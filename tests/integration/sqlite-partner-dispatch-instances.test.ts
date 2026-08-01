/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager.js";
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { SqliteA2aPartnerDispatchHandler } from "../../src/main/infrastructure/a2a/sqlite-partner-dispatch-handler.js";
import { SqlitePartnerInstanceRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-repository.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { openRuntimeDatabase, type RuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock } from "../support/runtime-fixture.js";

function seedDispatchFixture(database: RuntimeDatabase, partnerRevisionId: string): void {
  database.transaction((connection) => {
    connection.prepare(`INSERT INTO avatars
      (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
      VALUES ('avatar_1', 'A', 'persona_1', 'summary', 'scope', 'project', 'memory_namespace_1', 'ACTIVE', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO joi_inbox_messages (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
      VALUES ('input_1', 'idem_1', 'body', 'ROUTED', 'avatar_1', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO joi_turns (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at)
      VALUES ('turn_1', 'input_1', 'avatar_1', 'joi_session:avatar_1', 'RUNNING', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
      VALUES ('plan_1', 'turn_1', '{}', '{}', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO work_items (work_id, avatar_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
      VALUES ('work_1', 'avatar_1', 'input_1', 'the task', '{}', 'WRITE', 'READY', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO dispatch_attempts
      (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
      VALUES ('attempt_1', 'plan_1', 'work_1', ?, 1, 'action_1', 'PENDING', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run(partnerRevisionId);
  });
}

async function openWithPartner() {
  const root = await mkdtemp(path.join(os.tmpdir(), "joi-dispatch-instances-"));
  const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
  const partners = new PartnerRegistryService({ clock: new TestClock(), ids: { next: (prefix) => `${prefix}_t${String(Math.random()).slice(2, 8)}` }, repository: new SqlitePartnerRegistryRepository(database) });
  const partner = await partners.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [], workspaceRef: "workspace" });
  seedDispatchFixture(database, partner.partnerRevisionId);
  await new SqlitePartnerInstanceRepository(database).create({
    createdAt: "2026-07-29T10:00:00.000Z", engine: "pi-core", instanceId: "instance_9",
    partnerId: partner.partnerId, partnerRevisionId: partner.partnerRevisionId, sessionPolicy: "RESIDENT",
  });
  return { database, partner, root };
}

function makeHandler(database: RuntimeDatabase, instances: Pick<PartnerInstanceManager, "dispatch">, onResult: (event: Record<string, unknown>) => Promise<void>) {
  return new SqliteA2aPartnerDispatchHandler({
    clock: new TestClock(),
    database,
    gateway: { recover: async () => { throw new Error("gateway must not be used for LOCAL_PI"); }, startWithResult: async () => { throw new Error("gateway must not be used for LOCAL_PI"); } },
    instances,
    leases: { acquire: async () => null, release: async () => undefined },
    local: { run: async () => { throw new Error("legacy local runner must not be used when instance fields are present"); } },
    onResult,
    partners: new SqlitePartnerRegistryRepository(database),
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
  it("routes LOCAL_PI dispatches carrying instance fields through the instance manager and reports the real data source", async () => {
    const { database, partner, root } = await openWithPartner();
    try {
      const dispatchInputs: unknown[] = [];
      const results: Record<string, unknown>[] = [];
      const handler = makeHandler(database, {
        dispatch: async (input) => {
          dispatchInputs.push(input);
          database.transaction((connection) => connection.prepare(
            "UPDATE dispatch_attempts SET instance_id = ? WHERE dispatch_attempt_id = ?",
          ).run(input.instanceId ?? "", input.dispatchAttemptId ?? ""));
          return { actionId: "action_1", externalRunId: "local_pi:action_1", status: "COMPLETED" as const, workId: "work_1" };
        },
      }, async (event) => { results.push(event); });

      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", instanceId: "instance_9", sessionPolicy: "RESIDENT", workId: "work_1" }));

      expect(dispatchInputs[0]).toMatchObject({
        dispatchAttemptId: "attempt_1",
        instanceId: "instance_9",
        request: { actionId: "action_1", avatarId: "avatar_1", taskProjection: "the task", workId: "work_1" },
        sessionPolicy: "RESIDENT",
      });
      expect(results[0]).toMatchObject({
        partnerId: partner.partnerId,
        sessionDataSource: "partner_instance_messages:instance_9",
        status: "COMPLETED",
        title: "the task",
      });
      const attempt = database.transaction((connection) => connection.prepare(
        "SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1'",
      ).get()) as { status: string };
      expect(attempt.status).toBe("COMPLETED");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("marks the attempt UNKNOWN when the instance manager rejects the dispatch", async () => {
    const { database, root } = await openWithPartner();
    try {
      const handler = makeHandler(database, {
        dispatch: async () => { throw new Error("partner_instance_unavailable"); },
      }, async () => undefined);
      await handler.handle(baseRecord({ actionId: "action_1", dispatchAttemptId: "attempt_1", sessionPolicy: "EPHEMERAL", workId: "work_1" }));
      const attempt = database.transaction((connection) => connection.prepare(
        "SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1'",
      ).get()) as { status: string };
      expect(attempt.status).toBe("UNKNOWN");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("resumes RUNNING instance-linked attempts through the manager instead of terminalizing them", async () => {
    const { database, partner, root } = await openWithPartner();
    try {
      database.transaction((connection) => {
        connection.prepare("UPDATE dispatch_attempts SET instance_id = 'instance_9' WHERE dispatch_attempt_id = 'attempt_1'").run();
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, avatar_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
          VALUES ('partner_run:action_1', 'attempt_1', 'action_1', 'avatar_1', 'work_1', ?, 'LOCAL_PI', 'local_pi:action_1', 'RUNNING', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run(partner.partnerRevisionId);
      });
      const dispatchInputs: unknown[] = [];
      const handler = makeHandler(database, {
        dispatch: async (input) => {
          dispatchInputs.push(input);
          return { actionId: "action_1", externalRunId: "local_pi:action_1", status: "COMPLETED" as const, workId: "work_1" };
        },
      }, async () => undefined);
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
});
