import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { AvatarContextAssembler } from "../../src/main/application/joi/avatar-context-assembler.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { SqliteA2aPartnerDispatchHandler } from "../../src/main/infrastructure/a2a/sqlite-partner-dispatch-handler.js";
import { SqliteAvatarContextRepository } from "../../src/main/infrastructure/persistence/sqlite-avatar-context-repository.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("SQLite work plan outbox", () => {
  it("commits work, partner revision pins and side-effect outbox atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-work-plan-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const ids = new TestIds();
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO avatars
          (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES ('avatar-1', '研究', 'persona-1', '人格', '范围', '工程', 'memory-1', '', 'ACTIVE', ?, ?)`).run(clock.now().toISOString(), clock.now().toISOString());
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, created_at, updated_at) VALUES ('input-1', 'key-1', 'body', 'ROUTED', ?, ?)`).run(clock.now().toISOString(), clock.now().toISOString());
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at) VALUES ('turn-1', 'input-1', 'avatar-1', 'session-1', 'RUNNING', ?, ?)`).run(clock.now().toISOString(), clock.now().toISOString());
        connection.prepare(`UPDATE avatar_workspace_bindings SET kind = 'BOUND', status = 'READY', display_name = '工程', updated_at = ?
          WHERE avatar_id = 'avatar-1'`).run(clock.now().toISOString());
        connection.prepare(`INSERT INTO avatar_workspace_roots (workspace_ref, root_path, created_at, updated_at)
          VALUES ('avatar_workspace:avatar-1', ?, ?, ?)`).run(root, clock.now().toISOString(), clock.now().toISOString());
      });
      const partnerRepository = new SqlitePartnerRegistryRepository(database);
      const partners = new PartnerRegistryService({ clock, ids, repository: partnerRepository });
      const partner = await partners.add({ capabilities: ["write"], displayName: "Local", kind: "local-pi", skills: [], tools: ["edit"] });
      const repository = new SqliteWorkPlanRepository(database);
      const service = new WorkOrchestrationService({
        clock, ids, partners, policy: { evaluate: () => Promise.resolve({ allowed: true }) }, repository,
      });
      await service.plan({ avatarId: "avatar-1", dependencies: [], turnId: "turn-1", work: [{ accessMode: "WRITE", key: "write", partnerId: partner.partnerId, title: "写入" }] });
      const facts = database.transaction((connection) => ({
        attempts: connection.prepare("SELECT action_id, outbox_id, partner_revision_id, registry_revision FROM dispatch_attempts").all(),
        outbox: connection.prepare("SELECT kind, payload_json, status FROM outbox WHERE kind = 'partner.dispatch'").all(),
        work: connection.prepare("SELECT avatar_id, status FROM work_items").all(),
      }));
      expect(facts.work).toEqual([{ avatar_id: "avatar-1", status: "PLANNED" }]);
      expect(facts.attempts).toEqual([expect.objectContaining({ partner_revision_id: partner.partnerRevisionId, registry_revision: 1 })]);
      expect(facts.outbox).toEqual([expect.objectContaining({ kind: "partner.dispatch", status: "PENDING" })]);
      const attempt = facts.attempts[0] as { action_id: string };
      const outbox = facts.outbox[0] as { payload_json: string };
      expect(JSON.parse(outbox.payload_json)).toMatchObject({ actionId: attempt.action_id });
      const payload = JSON.parse(outbox.payload_json) as { actionId: string; dispatchAttemptId: string };
      const inbox = new SqliteJoiInboxRepository(database);
      const contexts = new SqliteAvatarContextRepository(database);
      const resultRepository = new SqliteWorkResultRepository(database);
      const privateResultBody = `bounded summary ${"x".repeat(2_000_000)} PRIVATE_RESULT_DETAIL`;
      let resultInputId: string | undefined;
      const handler = new SqliteA2aPartnerDispatchHandler({
        clock,
        contextAssembler: new AvatarContextAssembler({ avatars: new LegacyLifeStoreAdapter(database), clock, ids, projections: contexts, snapshots: contexts }),
        contexts,
        database,
        gateway: { recover: () => Promise.reject(new Error("must not recover")), startWithResult: () => Promise.reject(new Error("must not dispatch")) },
        leases: new SqliteWorkspaceLeaseManager({ clock, database }),
        local: {
          run: (request, revision) => Promise.resolve({
            actionId: request.actionId,
            artifacts: [],
            body: privateResultBody,
            externalRunId: `local:${request.actionId}:${revision.partnerRevisionId}`,
            status: "COMPLETED",
            workId: request.workId,
          }),
        },
        onResult: async (event) => { resultInputId = await inbox.enqueuePartnerResult(event); },
        partners: partnerRepository,
        results: resultRepository,
      });
      await handler.handle({
        attemptCount: 0,
        availableAt: clock.now().toISOString(),
        createdAt: clock.now().toISOString(),
        kind: "partner.dispatch",
        outboxId: "outbox-test",
        payload,
        status: "CLAIMED",
      });
      await handler.handle({
        attemptCount: 1,
        availableAt: clock.now().toISOString(),
        createdAt: clock.now().toISOString(),
        kind: "partner.dispatch",
        outboxId: "outbox-test",
        payload,
        status: "CLAIMED",
      });
      expect(await repository.listActive()).toEqual([]);
      expect(database.transaction((connection) => connection.prepare("SELECT status FROM dispatch_attempts").get()))
        .toEqual({ status: "COMPLETED" });
      const resultEvents = database.transaction((connection) => connection.prepare(
        "SELECT avatar_id, work_id, status FROM partner_result_events",
      ).all()) as { avatar_id: string; status: string; work_id: string }[];
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0]).toMatchObject({ avatar_id: "avatar-1", status: "COMPLETED" });
      expect(resultEvents[0]?.work_id).toMatch(/^work_/u);
      expect(resultInputId).toMatch(/^joi_result_input:/u);
      const resultInput = await inbox.loadInput(resultInputId ?? "missing");
      expect(resultInput).toMatchObject({ avatarId: "avatar-1", status: "PENDING" });
      expect(resultInput?.body).toContain("resultId=work_result:");
      expect(resultInput?.body).not.toContain("PRIVATE_RESULT_DETAIL");
      const projection = database.transaction((connection) => connection.prepare(
        "SELECT active_work_json, recent_results_json FROM avatar_task_projections WHERE avatar_id = 'avatar-1'",
      ).get()) as { active_work_json: string; recent_results_json: string };
      expect(JSON.parse(projection.active_work_json)).toEqual([]);
      const recent: unknown = JSON.parse(projection.recent_results_json);
      expect(Array.isArray(recent)).toBe(true);
      const firstRecent = (recent as Record<string, unknown>[])[0];
      expect(firstRecent).toMatchObject({ status: "COMPLETED" });
      expect(firstRecent?.workId).toMatch(/^work_/u);
      const storedResult = database.transaction((connection) => connection.prepare(
        "SELECT artifacts_json, body_ref, result_id FROM work_results",
      ).get()) as { artifacts_json: string; body_ref: string; result_id: string };
      expect(storedResult.body_ref).toBe(`work_result_artifact:${storedResult.result_id}`);
      expect(JSON.parse(storedResult.artifacts_json)).toEqual([
        expect.objectContaining({ artifactRef: storedResult.body_ref, name: "partner-result.txt", size: Buffer.byteLength(privateResultBody) }),
      ]);
      await expect(resultRepository.readBody({ avatarId: "avatar-1", limit: 16, offset: 0, resultId: storedResult.result_id }))
        .resolves.toEqual({ body: privateResultBody.slice(0, 16), total: privateResultBody.length });
      expect(database.transaction((connection) => connection.prepare(
        "SELECT input_id FROM partner_result_events",
      ).get())).toEqual({ input_id: resultInputId });
      const signalInputId = await inbox.enqueueSystemSignal({ avatarId: "avatar-1", signalId: "alarm-1", type: "schedule.alarm_due" });
      expect(await inbox.loadInput(signalInputId)).toMatchObject({ avatarId: "avatar-1", status: "PENDING" });
      expect(database.transaction((connection) => connection.prepare("SELECT COUNT(*) AS count FROM workspace_leases").get()))
        .toEqual({ count: 0 });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
