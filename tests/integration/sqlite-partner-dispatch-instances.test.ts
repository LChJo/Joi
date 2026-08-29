/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager.js";
import { WorkbenchContextAssembler } from "../../src/main/application/joi/workbench-context-assembler.js";
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { SqlitePartnerDispatchDelivery } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { SqliteWorkbenchAgentScan } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-scan.js";
import { SqlitePartnerInstanceRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-repository.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { SqliteWorkbenchManagementRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-management-repository.js";
import { createWorkResult } from "../../src/main/domain/work/work-result.js";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter.js";
import { openRuntimeDatabase, type RuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { wrapPartnerRunFailure } from "../../src/main/application/partners/partner-run-failure.js";

function seedDispatchFixture(database: RuntimeDatabase, partnerRevisionId: string): void {
  database.transaction((connection) => {
    connection.prepare(`INSERT INTO workbenches
      (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
      VALUES ('workbench_1', 'A', 'persona_1', 'summary', 'scope', 'project', 'memory_namespace_1', 'ACTIVE', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO joi_inbox_messages (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
      VALUES ('input_1', 'idem_1', 'body', 'ROUTED', 'workbench_1', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
      VALUES ('turn_1', 'input_1', 'workbench_1', 'joi_session:workbench_1', 'RUNNING', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
      VALUES ('plan_1', 'turn_1', '{}', '{}', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
      VALUES ('work_1', 'workbench_1', 'input_1', 'the task', '{}', 'WRITE', 'READY', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare("INSERT INTO work_access_policies (work_id, access_mode) VALUES ('work_1', 'NONE')").run();
    connection.prepare(`INSERT INTO dispatch_attempts
      (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
      VALUES ('attempt_1', 'plan_1', 'work_1', ?, 1, 'action_1', 'PENDING', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run(partnerRevisionId);
  });
}

async function openWithPartner() {
  const root = await mkdtemp(path.join(os.tmpdir(), "joi-dispatch-instances-"));
  const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
  const partners = new PartnerRegistryService({ clock: new TestClock(), ids: { next: (prefix) => `${prefix}_t${String(Math.random()).slice(2, 8)}` }, repository: new SqlitePartnerRegistryRepository(database) });
  const partner = await partners.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [] });
  seedDispatchFixture(database, partner.partnerRevisionId);
  await new SqlitePartnerInstanceRepository(database).create({
    workbenchId: "workbench_1", createdAt: "2026-07-29T10:00:00.000Z", engine: "pi-core", instanceId: "instance_9",
    partnerId: partner.partnerId, partnerRevisionId: partner.partnerRevisionId, sessionPolicy: "RESIDENT",
  });
  return { database, partner, root };
}

function makeHandler(
  database: RuntimeDatabase,
  instances: Pick<PartnerInstanceManager, "dispatch">,
  diagnostics: { event: string; fields: Record<string, unknown> }[] = [],
  verifier?: { verify(input: unknown): Promise<{ reasonCode?: string; status: "FAILED" | "NOT_REQUIRED" | "PASSED" }> },
  publish: (event: unknown) => Promise<unknown> = async () => undefined,
) {
  const contexts = new SqliteWorkbenchContextRepository(database);
  return new SqlitePartnerDispatchDelivery({
    agentConversations: new SqliteWorkbenchAgentRepository(database),
    clock: new TestClock(),
    contextAssembler: new WorkbenchContextAssembler({ workbenches: new LegacyLifeStoreAdapter(database), clock: new TestClock(), ids: new TestIds(), projections: contexts, snapshots: contexts }),
    contexts,
    database,
    diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
    gateway: { recover: async () => { throw new Error("gateway must not be used for LOCAL_PI"); }, startWithResult: async () => { throw new Error("gateway must not be used for LOCAL_PI"); } },
    instances,
    leases: { acquire: async () => null, release: async () => undefined },
    partners: new SqlitePartnerRegistryRepository(database),
    publish,
    results: new SqliteWorkResultRepository(database),
    ...(verifier === undefined ? {} : { verifier }),
  });
}

const baseRecord = (payload: Record<string, unknown>) => ({
  attemptCount: 0,
  availableAt: "2026-07-29T10:00:00.000Z",
  createdAt: "2026-07-29T10:00:00.000Z",
  kind: "partner.dispatch",
  outboxId: "outbox_1",
  payload,
  status: "PENDING" as const,
});

describe("partner dispatch instance routing", () => {
  it("fails a candidate completion when its private acceptance checks do not pass", async () => {
    const { database, root } = await openWithPartner();
    try {
      database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET intent_json = ? WHERE work_id = 'work_1'",
      ).run(JSON.stringify({ acceptanceChecks: [{ expectedText: "hellow", kind: "FILE_CONTAINS_EXACT", relativePath: "hello.txt" }] })));
      const handler = makeHandler(database, {
        dispatch: async () => ({
          actionId: "action_1", artifacts: [], body: "I wrote it", externalRunId: "local_pi:action_1",
          status: "COMPLETED" as const, workId: "work_1",
        }),
      }, [], {
        verify: async () => ({ reasonCode: "verification_content_mismatch", status: "FAILED" }),
      });

      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", instanceId: "instance_9", workId: "work_1" }));

      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM work_items WHERE work_id = 'work_1'",
      ).get())).toEqual({ status: "FAILED" });
      expect(database.transaction((connection) => connection.prepare(
        "SELECT reason_code, status FROM work_result_verifications",
      ).get())).toEqual({ reason_code: "verification_content_mismatch", status: "FAILED" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses the returned partner body for BODY_PRESENT acceptance", async () => {
    const { database, root } = await openWithPartner();
    try {
      database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET intent_json = ? WHERE work_id = 'work_1'",
      ).run(JSON.stringify({ acceptanceChecks: [{ kind: "BODY_PRESENT" }] })));
      let receivedBody: string | undefined;
      const handler = makeHandler(database, {
        dispatch: async () => ({
          actionId: "action_1", artifacts: [], body: "analysis complete", externalRunId: "local_pi:action_1",
          status: "COMPLETED" as const, workId: "work_1",
        }),
      }, [], {
        verify: async (input) => {
          receivedBody = (input as { body?: string }).body;
          return receivedBody === "analysis complete" ? { status: "PASSED" } : { reasonCode: "verification_body_missing", status: "FAILED" };
        },
      });

      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", instanceId: "instance_9", workId: "work_1" }));

      expect(receivedBody).toBe("analysis complete");
      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM work_items WHERE work_id = 'work_1'",
      ).get())).toEqual({ status: "COMPLETED" });
      expect(database.transaction((connection) => connection.prepare(
        "SELECT reason_code, status FROM work_result_verifications",
      ).get())).toEqual({ reason_code: null, status: "PASSED" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the first terminal result authoritative and archives later conflicts without changing projections", async () => {
    const { database, partner, root } = await openWithPartner();
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO partner_runs
        (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind,
         external_run_id, status, created_at, updated_at)
        VALUES ('partner_run:action_1', 'attempt_1', 'action_1', 'workbench_1', 'work_1', ?,
                'LOCAL_PI', 'local_pi:action_1', 'RUNNING', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`)
        .run(partner.partnerRevisionId));
      const repository = new SqliteWorkResultRepository(database);
      const base = {
        actionId: "action_1", artifacts: [], workbenchId: "workbench_1", body: "done",
        createdAt: "2026-07-29T10:00:00.000Z", isLate: false,
        partnerRevisionId: partner.partnerRevisionId, runId: "partner_run:action_1", workId: "work_1",
      };
      const first = await repository.record(createWorkResult({
        ...base, resultId: "result_completed", status: "COMPLETED",
      }));
      const conflict = await repository.record(createWorkResult({
        ...base, body: "conflicting failure", createdAt: "2026-07-29T10:01:00.000Z",
        resultId: "result_failed", status: "FAILED",
      }));

      expect(first.isAuthoritative).toBe(true);
      expect(conflict.isAuthoritative).toBe(false);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT result_id, is_authoritative FROM work_results ORDER BY created_at, result_id",
      ).all())).toEqual([
        { is_authoritative: 1, result_id: "result_completed" },
        { is_authoritative: 0, result_id: "result_failed" },
      ]);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM work_items WHERE work_id = 'work_1'",
      ).get())).toEqual({ status: "COMPLETED" });
      const projection = database.transaction((connection) => connection.prepare(
        "SELECT recent_results_json FROM workbench_task_projections WHERE workbench_id = 'workbench_1'",
      ).get()) as { recent_results_json: string };
      expect(JSON.parse(projection.recent_results_json)).toEqual([
        expect.objectContaining({ resultId: "result_completed", status: "COMPLETED" }),
      ]);
      const detail = await new SqliteWorkbenchManagementRepository(database).getDetail("workbench_1");
      expect(detail?.recentResults.map((result) => result.resultId)).toEqual(["result_completed"]);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("routes LOCAL_PI dispatches carrying instance fields through the instance manager and reports the real data source", async () => {
    const { database, partner, root } = await openWithPartner();
    try {
      const dispatchInputs: unknown[] = [];
      const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
      const handler = makeHandler(database, {
        dispatch: async (input) => {
          dispatchInputs.push(input);
          database.transaction((connection) => connection.prepare(
            "UPDATE dispatch_attempts SET instance_id = ? WHERE dispatch_attempt_id = ?",
          ).run(input.instanceId ?? "", input.dispatchAttemptId ?? ""));
          return { actionId: "action_1", artifacts: [], body: "done", externalRunId: "local_pi:action_1", status: "COMPLETED" as const, workId: "work_1" };
        },
      }, diagnostics);

      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", instanceId: "instance_9", sessionPolicy: "RESIDENT", workId: "work_1" }));

      expect(dispatchInputs[0]).toMatchObject({
        dispatchAttemptId: "attempt_1",
        instanceId: "instance_9",
        request: {
          actionId: "action_1", workbenchId: "workbench_1",
          taskProjection: "Work title: the task\n\nOriginal user request (authoritative):\nbody", workId: "work_1",
        },
        sessionPolicy: "RESIDENT",
      });
      const dispatched = dispatchInputs[0] as { request: { contextSnapshotId: unknown } };
      expect(dispatched.request.contextSnapshotId).toMatch(/^workbench_context_snapshot_/u);
      const scan = new SqliteWorkbenchAgentScan(database);
      const [unsynthesized] = await scan.listUnsynthesizedResults("workbench_1");
      expect(unsynthesized).toMatchObject({
        partnerId: partner.partnerId,
        sessionDataSource: "partner_instance_messages:instance_9",
        status: "COMPLETED",
        title: "the task",
      });
      const attempt = database.transaction((connection) => connection.prepare(
        "SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1'",
      ).get()) as { status: string };
      expect(attempt.status).toBe("COMPLETED");
      const conversation = database.transaction((connection) => connection.prepare(`SELECT role, kind, text
        FROM workbench_agent_conversation_entries WHERE agent_id = 'instance_9' ORDER BY sequence`).all());
      expect(conversation).toEqual([
        { kind: "MARKDOWN", role: "USER", text: "Work title: the task\n\nOriginal user request (authoritative):\nbody" },
        { kind: "MARKDOWN", role: "AGENT", text: "done" },
      ]);
      expect(diagnostics.find((entry) => entry.event === "joi.partner.dispatch.started")?.fields).toMatchObject({
        actionId: "action_1",
        workbenchId: "workbench_1",
        dispatchAttemptId: "attempt_1",
        outboxId: "outbox_1",
        workId: "work_1",
      });
      expect(diagnostics.find((entry) => entry.event === "joi.partner.run.created")?.fields)
        .toMatchObject({ runId: "partner_run:action_1" });
      expect(diagnostics.find((entry) => entry.event === "joi.partner.result.recorded")?.fields).toMatchObject({
        agentId: "instance_9",
        resultId: "work_result:partner_run:action_1:COMPLETED",
        status: "COMPLETED",
      });
      expect(JSON.stringify(diagnostics)).not.toContain("the task");
      expect(JSON.stringify(diagnostics)).not.toContain("done");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("replaces one live run snapshot in place and commits the terminal conversation without duplicates", async () => {
    const { database, root } = await openWithPartner();
    try {
      let liveRows: unknown[] = [];
      const handler = makeHandler(database, {
        dispatch: async (rawInput) => {
          const input = rawInput as typeof rawInput & {
            onConversation?: (event: { conversation: { kind: "MARKDOWN"; role: "AGENT" | "USER"; text: string }[]; instanceId: string }) => Promise<void>;
          };
          database.transaction((connection) => connection.prepare(
            "UPDATE dispatch_attempts SET instance_id = ? WHERE dispatch_attempt_id = ?",
          ).run("instance_9", input.dispatchAttemptId ?? ""));
          expect(input.onConversation).toBeTypeOf("function");
          await input.onConversation?.({
            conversation: [
              { kind: "MARKDOWN", role: "USER", text: "the task" },
              { kind: "MARKDOWN", role: "AGENT", text: "正在生成" },
            ],
            instanceId: "instance_9",
          });
          await input.onConversation?.({
            conversation: [
              { kind: "MARKDOWN", role: "USER", text: "the task" },
              { kind: "MARKDOWN", role: "AGENT", text: "正在生成安全结论" },
            ],
            instanceId: "instance_9",
          });
          liveRows = database.transaction((connection) => connection.prepare(`SELECT role, kind, text
            FROM workbench_agent_conversation_entries WHERE agent_id = 'instance_9' ORDER BY sequence`).all());
          return {
            actionId: "action_1", artifacts: [], body: "最终结论", conversation: [
              { kind: "MARKDOWN" as const, role: "USER" as const, text: "the task" },
              { kind: "MARKDOWN" as const, role: "AGENT" as const, text: "最终结论" },
            ],
            externalRunId: "local_pi:action_1", instanceId: "instance_9", status: "COMPLETED" as const, workId: "work_1",
          };
        },
      });

      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", instanceId: "instance_9", workId: "work_1" }));

      expect(liveRows).toEqual([
        { kind: "MARKDOWN", role: "USER", text: "the task" },
        { kind: "MARKDOWN", role: "AGENT", text: "正在生成安全结论" },
      ]);
      expect(database.transaction((connection) => connection.prepare(`SELECT role, kind, text
        FROM workbench_agent_conversation_entries WHERE agent_id = 'instance_9' ORDER BY sequence`).all())).toEqual([
        { kind: "MARKDOWN", role: "USER", text: "the task" },
        { kind: "MARKDOWN", role: "AGENT", text: "最终结论" },
      ]);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("records a safe FAILED result when instance preflight rejects the dispatch", async () => {
    const { database, root } = await openWithPartner();
    try {
      const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
      const handler = makeHandler(database, {
        dispatch: async () => { throw wrapPartnerRunFailure(
          Object.assign(new Error("private requested id"), { code: "partner_instance_unavailable" }),
          { phase: "EXECUTION", sideEffectState: "NONE" },
        ); },
      }, diagnostics);
      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", sessionPolicy: "EPHEMERAL", workId: "work_1" }));
      const attempt = database.transaction((connection) => connection.prepare(
        "SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1'",
      ).get()) as { status: string };
      expect(attempt.status).toBe("FAILED");
      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM work_items WHERE work_id = 'work_1'",
      ).get())).toEqual({ status: "FAILED" });
      expect(diagnostics.find((entry) => entry.event === "joi.partner.result.recorded")?.fields).toMatchObject({
        phase: "EXECUTION", reasonCode: "partner_instance_unavailable", retryable: false, sideEffectState: "NONE", status: "FAILED",
      });
      expect(JSON.stringify(diagnostics)).not.toContain("private requested id");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves pre-execution Skill failure facts and stores an actionable safe result body", async () => {
    const { database, root } = await openWithPartner();
    try {
      const handler = makeHandler(database, {
        dispatch: async () => {
          throw wrapPartnerRunFailure(
            Object.assign(new Error("PRIVATE selected path"), { code: "partner_skill_ref_invalid" }),
            { phase: "CONFIGURATION", sideEffectState: "NONE" },
          );
        },
      });
      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", sessionPolicy: "EPHEMERAL", workId: "work_1" }));

      const stored = database.transaction((connection) => connection.prepare(`SELECT b.body
        FROM work_results r JOIN work_result_bodies b ON b.body_ref = r.body_ref
        WHERE r.work_id = 'work_1'`).get()) as { body: string };
      expect(stored.body).toContain("phase=CONFIGURATION");
      expect(stored.body).toContain("reasonCode=partner_skill_ref_invalid");
      expect(stored.body).toContain("sideEffectState=NONE");
      expect(stored.body).toContain("No partner model or tool was started");
      expect(stored.body).toContain("reselect an installed Skill");
      expect(stored.body).not.toContain("PRIVATE selected path");
      expect(stored.body).not.toContain("phase=EXECUTION");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each(["WAITING_INPUT", "WAITING_AUTH"] as const)("keeps %s runs actionable as waiting Work", async (status) => {
    const { database, root } = await openWithPartner();
    try {
      const handler = makeHandler(database, {
        dispatch: async () => ({
          actionId: "action_1", artifacts: [], body: "waiting", externalRunId: "local_pi:action_1",
          status, workId: "work_1",
        }),
      });
      await handler.handle(baseRecord({
        actionId: "action_1", dispatchAttemptId: "attempt_1", sessionPolicy: "EPHEMERAL", workId: "work_1",
      }));

      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM work_items WHERE work_id = 'work_1'",
      ).get())).toEqual({ status: "WAITING" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not replace a committed COMPLETED result with UNKNOWN when result notification fails", async () => {
    const { database, root } = await openWithPartner();
    try {
      const handler = makeHandler(database, {
        dispatch: async () => ({
          actionId: "action_1", artifacts: [], body: "done", externalRunId: "local_pi:action_1",
          status: "COMPLETED" as const, workId: "work_1",
        }),
      }, [], undefined, async () => { throw new Error("result notification failed"); });

      await expect(handler.handle(baseRecord({
        actionId: "action_1", dispatchAttemptId: "attempt_1", instanceId: "instance_9",
        sessionPolicy: "RESIDENT", workId: "work_1",
      }))).rejects.toThrow("result notification failed");

      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM work_results WHERE work_id = 'work_1' ORDER BY created_at, result_id",
      ).all())).toEqual([{ status: "COMPLETED" }]);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1'",
      ).get())).toEqual({ status: "COMPLETED" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("resumes RUNNING instance-linked attempts through the manager instead of terminalizing them", async () => {
    const { database, partner, root } = await openWithPartner();
    try {
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO workbench_context_snapshots
          (context_snapshot_id, workbench_id, work_id, persona_revision_id, safe_context_json, memory_summary_refs_json, created_at)
          VALUES ('context_existing', 'workbench_1', 'work_1', 'persona_1', '{}', '[]', '2026-07-29T10:00:00.000Z')`).run();
        connection.prepare("UPDATE dispatch_attempts SET instance_id = 'instance_9' WHERE dispatch_attempt_id = 'attempt_1'").run();
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at, context_snapshot_id)
          VALUES ('partner_run:action_1', 'attempt_1', 'action_1', 'workbench_1', 'work_1', ?, 'LOCAL_PI', 'local_pi:action_1', 'RUNNING', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z', 'context_existing')`).run(partner.partnerRevisionId);
      });
      const dispatchInputs: unknown[] = [];
      const handler = makeHandler(database, {
        dispatch: async (input) => {
          dispatchInputs.push(input);
          return { actionId: "action_1", artifacts: [], body: "done", externalRunId: "local_pi:action_1", status: "COMPLETED" as const, workId: "work_1" };
        },
      });
      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", instanceId: "instance_9", sessionPolicy: "RESIDENT", workId: "work_1" }));
      expect(dispatchInputs).toHaveLength(1);
      const attempt = database.transaction((connection) => connection.prepare(
        "SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1'",
      ).get()) as { status: string };
      expect(attempt.status).toBe("COMPLETED");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("archives a late result without reopening canceled work or enqueueing it for joi integration", async () => {
    const { database, partner, root } = await openWithPartner();
    try {
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO workbench_context_snapshots
          (context_snapshot_id, workbench_id, work_id, persona_revision_id, safe_context_json, memory_summary_refs_json, created_at)
          VALUES ('context_late', 'workbench_1', 'work_1', 'persona_1', '{}', '[]', '2026-07-29T10:00:00.000Z')`).run();
        connection.prepare("UPDATE work_items SET status = 'CANCELED' WHERE work_id = 'work_1'").run();
        connection.prepare("UPDATE dispatch_attempts SET instance_id = 'instance_9', status = 'RUNNING' WHERE dispatch_attempt_id = 'attempt_1'").run();
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at, context_snapshot_id)
          VALUES ('partner_run:action_1', 'attempt_1', 'action_1', 'workbench_1', 'work_1', ?, 'LOCAL_PI', 'local_pi:action_1', 'RUNNING', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z', 'context_late')`).run(partner.partnerRevisionId);
      });
      const handler = makeHandler(database, {
        dispatch: async () => ({ actionId: "action_1", artifacts: [], body: "late body", externalRunId: "local_pi:action_1", status: "COMPLETED" as const, workId: "work_1" }),
      });
      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", instanceId: "instance_9", sessionPolicy: "RESIDENT", workId: "work_1" }));

      // Late results are non-authoritative: the workbench traversal must never fold them into synthesis.
      await expect(new SqliteWorkbenchAgentScan(database).listUnsynthesizedResults("workbench_1")).resolves.toEqual([]);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT is_late, status FROM work_results WHERE work_id = 'work_1'",
      ).get())).toEqual({ is_late: 1, status: "COMPLETED" });
      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM work_items WHERE work_id = 'work_1'",
      ).get())).toEqual({ status: "CANCELED" });
      const projection = database.transaction((connection) => connection.prepare(
        "SELECT recent_results_json FROM workbench_task_projections WHERE workbench_id = 'workbench_1'",
      ).get()) as { recent_results_json: string };
      expect(JSON.parse(projection.recent_results_json)).toEqual([
        expect.objectContaining({ resultId: "work_result:partner_run:action_1:COMPLETED", status: "COMPLETED" }),
      ]);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("creates an ephemeral A2A Agent card and archives text without raw data payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-dispatch-a2a-agent-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO agent_connections
        (agent_connection_id, name, card_url, status, created_at, updated_at)
        VALUES ('remote_1', '远程研究员', 'http://agent.invalid/card', 'ACTIVE', ?, ?)`)
        .run("2026-07-29T10:00:00.000Z", "2026-07-29T10:00:00.000Z"));
      const revision = database.transaction((connection) => connection.prepare(
        "SELECT active_revision_id FROM partners WHERE partner_id = 'partner_remote_1'",
      ).get()) as { active_revision_id: string };
      seedDispatchFixture(database, revision.active_revision_id);
      const contexts = new SqliteWorkbenchContextRepository(database);
      const handler = new SqlitePartnerDispatchDelivery({
        agentConversations: new SqliteWorkbenchAgentRepository(database),
        clock: new TestClock(),
        contextAssembler: new WorkbenchContextAssembler({ workbenches: new LegacyLifeStoreAdapter(database), clock: new TestClock(), ids: new TestIds(), projections: contexts, snapshots: contexts }),
        contexts,
        database,
        gateway: {
          recover: async () => { throw new Error("unexpected recovery"); },
          startWithResult: async () => ({
            invocation: {
              agentConnectionId: "remote_1", createdAt: "2026-07-29T10:00:00.000Z", invocationId: "invocation_remote_1",
              lastActivityAt: "2026-07-29T10:00:00.000Z", messageId: "action_1", request: { parts: [] }, sendAttempts: 1,
              status: "COMPLETED" as const, updatedAt: "2026-07-29T10:00:00.000Z",
            },
            output: { artifacts: [], parts: [{ data: "远程工作完成", kind: "text" }, { data: "PRIVATE_A2A_PAYLOAD", kind: "data" }] },
          }),
        },
        instances: { dispatch: async () => { throw new Error("instance dispatch must not be used for A2A"); } },
        leases: { acquire: async () => null, release: async () => undefined },
        partners: new SqlitePartnerRegistryRepository(database),
        results: new SqliteWorkResultRepository(database),
      });
      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", workId: "work_1" }));

      expect(database.transaction((connection) => connection.prepare(`SELECT backing_kind, session_policy
        FROM workbench_agent_sessions WHERE workbench_id = 'workbench_1'`).get())).toEqual({ backing_kind: "A2A_RUN", session_policy: "EPHEMERAL" });
      const displayText = database.transaction((connection) => connection.prepare(`SELECT text
        FROM workbench_agent_conversation_entries ORDER BY sequence`).all()) as { text: string | null }[];
      expect(displayText.map((row) => row.text).join("\n")).toContain("远程工作完成");
      expect(displayText.map((row) => row.text).join("\n")).not.toContain("PRIVATE_A2A_PAYLOAD");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
