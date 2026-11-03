/* eslint-disable @typescript-eslint/require-await */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkbenchContextAssembler } from "../../src/main/application/joi/workbench-context-assembler.js";
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import type { StagedAttachment } from "../../src/main/application/ports/partner-dispatch-delivery.js";
import { SqlitePartnerDispatchDelivery } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { JoiAttachmentService } from "../../src/main/infrastructure/artifacts/joi-attachment-service.js";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { WorkAttachmentStager } from "../../src/main/infrastructure/workspace/workspace-attachment-stager.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const NOW = "2026-07-29T10:00:00.000Z";

async function openFixture(temporaryRoot = os.tmpdir()) {
  const root = await realpath(await mkdtemp(path.join(temporaryRoot, "joi-attachment-staging-")));
  const workspaceDir = path.join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
  const clock = new TestClock();
  const ids = new TestIds();
  const attachments = new JoiAttachmentService({ clock, database, ids, rootDirectory: path.join(root, "artifacts") });
  const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const uploaded = await attachments.upload({ bytes: imageBytes, filename: "screen.png", mimeType: "image/png" });
  const partners = new PartnerRegistryService({ clock, ids, repository: new SqlitePartnerRegistryRepository(database) });
  const partner = await partners.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [] });
  database.transaction((connection) => {
    connection.prepare(`INSERT INTO workbenches
      (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
      VALUES ('workbench_1', 'A', 'persona_1', 'summary', 'scope', 'project', 'memory_namespace_1', 'ACTIVE', ?, ?)`).run(NOW, NOW);
    connection.prepare(`UPDATE workbench_workspace_bindings SET kind = 'BOUND', status = 'READY', display_name = '工程', updated_at = ?
      WHERE workbench_id = 'workbench_1'`).run(NOW);
    connection.prepare(`INSERT INTO workbench_workspace_roots (workspace_ref, root_path, created_at, updated_at)
      VALUES ('workbench_workspace:workbench_1', ?, ?, ?)`).run(workspaceDir, NOW, NOW);
    connection.prepare(`INSERT INTO joi_inbox_messages (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
      VALUES ('input_1', 'idem_1', 'body', 'ROUTED', 'workbench_1', ?, ?)`).run(NOW, NOW);
    connection.prepare("INSERT INTO joi_inbox_attachments (input_id, attachment_id) VALUES ('input_1', ?)").run(uploaded.attachmentId);
    connection.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
      VALUES ('turn_1', 'input_1', 'workbench_1', 'joi_session:workbench_1', 'RUNNING', ?, ?)`).run(NOW, NOW);
    connection.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
      VALUES ('plan_1', 'turn_1', '{}', '{}', ?)`).run(NOW);
    connection.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
      VALUES ('work_1', 'workbench_1', 'input_1', 'the task', '{}', 'READ', 'READY', ?, ?),
             ('work_2', 'workbench_1', 'input_1', 'no files', '{}', 'READ', 'READY', ?, ?)`).run(NOW, NOW, NOW, NOW);
    connection.prepare("INSERT INTO work_access_policies (work_id, access_mode) VALUES ('work_2', 'NONE')").run();
    connection.prepare(`INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
      VALUES ('outbox_1', 'partner.dispatch', ?, 'PENDING', 0, ?, ?),
             ('outbox_2', 'partner.dispatch', ?, 'PENDING', 0, ?, ?)`).run(
      JSON.stringify({ actionId: "action_1", dispatchAttemptId: "attempt_1", workId: "work_1" }), NOW, NOW,
      JSON.stringify({ actionId: "action_2", dispatchAttemptId: "attempt_2", workId: "work_2" }), NOW, NOW);
    connection.prepare(`INSERT INTO dispatch_attempts
      (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at, outbox_id)
      VALUES ('attempt_1', 'plan_1', 'work_1', ?, 1, 'action_1', 'PENDING', ?, ?, 'outbox_1'),
             ('attempt_2', 'plan_1', 'work_2', ?, 1, 'action_2', 'PENDING', ?, ?, 'outbox_2')`)
      .run(partner.partnerRevisionId, NOW, NOW, partner.partnerRevisionId, NOW, NOW);
  });
  return { attachments, clock, database, ids, partner, root, uploaded, workspaceDir };
}

function makeDelivery(
  fixture: Awaited<ReturnType<typeof openFixture>>,
  dispatchSpy: { calls: unknown[] },
  overrides?: { attachmentStager?: { stage(input: { inputId: string; workspacePath: string }): Promise<StagedAttachment[]> }; contexts?: ConstructorParameters<typeof SqlitePartnerDispatchDelivery>[0]["contexts"]; diagnostics?: ConstructorParameters<typeof SqlitePartnerDispatchDelivery>[0]["diagnostics"] },
) {
  const contexts = new SqliteWorkbenchContextRepository(fixture.database);
  return new SqlitePartnerDispatchDelivery({
    agentConversations: new SqliteWorkbenchAgentRepository(fixture.database),
    attachmentStager: overrides?.attachmentStager ?? new WorkAttachmentStager({ attachments: fixture.attachments, database: fixture.database, taskDirectory: path.join(fixture.root, "inputs") }),
    clock: fixture.clock,
    contextAssembler: new WorkbenchContextAssembler({
      workbenches: new LegacyLifeStoreAdapter(fixture.database), clock: fixture.clock, ids: fixture.ids, projections: contexts, snapshots: contexts,
    }),
    contexts: overrides?.contexts ?? contexts,
    evidenceDirectory: path.join(fixture.root, "inputs"),
    database: fixture.database,
    ...(overrides?.diagnostics === undefined ? {} : { diagnostics: overrides.diagnostics }),
    gateway: { recover: async () => { throw new Error("gateway unused"); }, startWithResult: async () => { throw new Error("gateway unused"); } },
    instances: {
      dispatch: async (input) => {
        dispatchSpy.calls.push(input);
        return { actionId: "action_1", artifacts: [], body: "done", externalRunId: "local_pi:action_1", status: "COMPLETED" as const, workId: "work_1" };
      },
    },
    leases: new SqliteWorkspaceLeaseManager({ clock: fixture.clock, database: fixture.database, owner: "staging_test" }),
    partners: new SqlitePartnerRegistryRepository(fixture.database),
    results: new SqliteWorkResultRepository(fixture.database),
  });
}

function outboxRecord(outboxId: string, dispatchAttemptId: string, workId: string) {
  return {
    attemptCount: 0, availableAt: NOW, createdAt: NOW, kind: "partner.dispatch", outboxId,
    payload: { actionId: `action:${dispatchAttemptId}`, dispatchAttemptId, workId }, status: "PENDING" as const,
  };
}

describe("partner dispatch attachment staging", () => {
  it("uses canonical input paths when the temporary parent is an alias", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "joi-attachment-alias-"));
    const physical = path.join(parent, "physical");
    const alias = path.join(parent, "alias");
    await mkdir(physical);
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
    let fixture: Awaited<ReturnType<typeof openFixture>> | undefined;
    try {
      fixture = await openFixture(alias);
      const spy = { calls: [] as unknown[] };
      await makeDelivery(fixture, spy).handle(outboxRecord("outbox_1", "attempt_1", "work_1"));
      const stagedPath = path.join(fixture.root, "inputs", "work_1", "joi-attachments", fixture.uploaded.attachmentId, "screen.png");
      expect(stagedPath).toBe(await realpath(stagedPath));
      expect((spy.calls[0] as { request: { taskProjection: string } }).request.taskProjection).toContain(stagedPath);
    } finally {
      fixture?.database.close();
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("AC-53 measures workspace waiting independently from model execution", async () => {
    const fixture = await openFixture();
    try {
      const leases = new SqliteWorkspaceLeaseManager({ clock: fixture.clock, database: fixture.database, owner: "queue-test" });
      await leases.acquire({ accessMode: "WRITE", workId: "work_2", workspaceRef: "workbench_workspace:workbench_1" });
      const events: { event: string; fields: unknown }[] = [];
      const delivery = makeDelivery(fixture, { calls: [] }, { diagnostics: { emit: (event, fields) => { events.push({ event, fields }); } } });
      const claim = { attemptCount: 0, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" };
      await expect(delivery.prepare(claim)).rejects.toMatchObject({ code: "workspace_lease_conflict" });
      fixture.clock.advance(2500);
      await leases.release("work_2");
      expect(await delivery.prepare(claim)).not.toBe("skipped_terminal");
      expect(events.filter(entry => entry.event === "joi.partner.workspace_queue_finished")).toEqual([{ event: "joi.partner.workspace_queue_finished", fields: {
        dispatchAttemptId: "attempt_1", durationMs: 2500, phase: "READ", workbenchId: "workbench_1", workId: "work_1",
      } }]);
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("AC-53 prepares native evidence outside acceptance roots and never redispatches a prepared run", async () => {
    const fixture = await openFixture();
    try {
      fixture.database.transaction(db => db.prepare("UPDATE partner_revisions SET engine = 'MANA_SDK', cli_protocol = 'CLAUDE' WHERE partner_revision_id = ?").run(fixture.partner.partnerRevisionId));
      const evidence = { index: "prior result: result-0.txt", files: [{ name: "result-0.txt", body: "original evidence tail" }], inline: "selected evidence" };
      const spy = { calls: [] as unknown[] };
      const delivery = makeDelivery(fixture, spy, { contexts: { loadForExecution: async () => ({ evidence, promptSection: evidence.inline, sanitized: {}, workspacePath: fixture.workspaceDir }) } });
      const claim = { attemptCount: 0, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" };
      const prepared = await delivery.prepare(claim);
      expect(prepared).not.toBe("skipped_terminal");
      const evidenceRoot = path.join(fixture.root, "inputs", "evidence");
      const packages = await readdir(evidenceRoot);
      expect(packages).toHaveLength(1);
      const inputRoot = path.join(evidenceRoot, packages[0] ?? "missing");
      expect(await readFile(path.join(inputRoot, "result-0.txt"), "utf8")).toBe("original evidence tail");
      const indexState = await stat(path.join(inputRoot, "index.md"));
      expect(indexState.mode & 0o222).toBe(0);
      expect(await delivery.prepare({ ...claim, attemptCount: 1 })).toBe("skipped_terminal");
      expect(await readdir(evidenceRoot)).toEqual(packages);
      expect((await stat(path.join(inputRoot, "index.md"))).mtimeMs).toBe(indexState.mtimeMs);
      expect(await readdir(fixture.workspaceDir)).toEqual([]);
      expect(spy.calls).toEqual([]);
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("AC-WR-06 stages input attachments outside the shared workspace", async () => {
    const fixture = await openFixture();
    try {
      const spy = { calls: [] as unknown[] };
      const delivery = makeDelivery(fixture, spy);
      await delivery.handle(outboxRecord("outbox_1", "attempt_1", "work_1"));

      const stagedPath = path.join(fixture.root, "inputs", "work_1", "joi-attachments", fixture.uploaded.attachmentId, "screen.png");
      expect(new Uint8Array(await readFile(stagedPath))).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      await expect(readFile(path.join(fixture.workspaceDir, "joi-attachments", fixture.uploaded.attachmentId, "screen.png"))).rejects.toMatchObject({ code: "ENOENT" });
      const request = spy.calls[0] as { request: { taskProjection: string } };
      expect(request.request.taskProjection).toContain("task's independent input directory");
      expect(request.request.taskProjection).toContain(stagedPath);
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("restores tampered staged files idempotently on the next staging pass", async () => {
    const fixture = await openFixture();
    try {
      const stager = new WorkAttachmentStager({ attachments: fixture.attachments, database: fixture.database });
      const first = await stager.stage({ inputId: "input_1", workspacePath: fixture.workspaceDir });
      expect(first).toEqual([{
        filename: "screen.png", mimeType: "image/png",
        relativePath: `joi-attachments/${fixture.uploaded.attachmentId}/screen.png`, size: 8,
      }]);
      const stagedPath = path.join(fixture.workspaceDir, "joi-attachments", fixture.uploaded.attachmentId, "screen.png");
      await writeFile(stagedPath, "tampered");
      await stager.stage({ inputId: "input_1", workspacePath: fixture.workspaceDir });
      expect(new Uint8Array(await readFile(stagedPath))).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(await stager.stage({ inputId: "no_such_input", workspacePath: fixture.workspaceDir })).toEqual([]);
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("releases the workspace lease when prepare fails after acquiring it", async () => {
    const fixture = await openFixture();
    try {
      const spy = { calls: [] as unknown[] };
      const failing = makeDelivery(fixture, spy, {
        attachmentStager: { stage: () => Promise.reject(new Error("stage_failed")) },
      });
      const claim = { attemptCount: 0, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" };
      await expect(failing.prepare(claim)).rejects.toThrow("stage_failed");
      const heldLeases = fixture.database.transaction((connection) => (
        connection.prepare("SELECT COUNT(*) AS n FROM workspace_leases").get() as { n: number }
      ).n);
      expect(heldLeases).toBe(0);

      // The freed lease lets the same work dispatch normally on the next attempt.
      const healthy = makeDelivery(fixture, spy);
      await healthy.handle(outboxRecord("outbox_1", "attempt_1", "work_1"));
      expect(spy.calls).toHaveLength(1);
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("lands a terminal FAILED result when an exhausted preparation is abandoned", async () => {
    const fixture = await openFixture();
    try {
      const spy = { calls: [] as unknown[] };
      const delivery = makeDelivery(fixture, spy);
      const claim = { attemptCount: 6, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" };
      await delivery.abandon({ claim, reasonCode: "workspace_lease_conflict" });

      const facts = fixture.database.transaction((connection) => ({
        attempt: connection.prepare("SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1'").get(),
        result: connection.prepare("SELECT status, summary FROM work_results").get(),
        run: connection.prepare("SELECT status FROM partner_runs WHERE work_id = 'work_1'").get(),
        work: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work_1'").get(),
      }));
      expect(facts).toMatchObject({
        attempt: { status: "FAILED" },
        result: { status: "FAILED" },
        run: { status: "FAILED" },
        work: { status: "FAILED" },
      });
      expect((facts.result as { summary: string }).summary).toContain("workspace_lease_conflict");
      expect(spy.calls).toEqual([]);

      // Abandoning an already-terminal attempt is a no-op.
      await expect(delivery.abandon({ claim, reasonCode: "workspace_lease_conflict" })).resolves.toBeUndefined();
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it.each(["{not valid json", "null", "[]", "42"])("converges a corrupted Work brief %s to a terminal FAILED result instead of running it unverifiable", async (intentJson) => {
    const fixture = await openFixture();
    try {
      const spy = { calls: [] as unknown[] };
      const delivery = makeDelivery(fixture, spy);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET intent_json = ? WHERE work_id = 'work_1'",
      ).run(intentJson));
      const claim = { attemptCount: 0, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" };
      await expect(delivery.prepare(claim)).resolves.toBe("skipped_terminal");

      const facts = fixture.database.transaction((connection) => ({
        result: connection.prepare("SELECT status, summary FROM work_results WHERE work_id = 'work_1'").get(),
        work: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work_1'").get(),
      }));
      expect(facts).toMatchObject({
        result: { status: "FAILED" },
        work: { status: "FAILED" },
      });
      expect((facts.result as { summary: string }).summary).toContain("brief is corrupted");
      expect(spy.calls).toEqual([]);
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not stage attachments for work without file access", async () => {
    const fixture = await openFixture();
    try {
      const spy = { calls: [] as unknown[] };
      const delivery = makeDelivery(fixture, spy);
      await delivery.handle(outboxRecord("outbox_2", "attempt_2", "work_2"));
      expect(spy.calls).toHaveLength(1);
      const request = spy.calls[0] as { request: { taskProjection: string } };
      expect(request.request.taskProjection).not.toContain("staged in this workspace");
      await expect(stat(path.join(fixture.workspaceDir, "joi-attachments"))).rejects.toThrow();
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
