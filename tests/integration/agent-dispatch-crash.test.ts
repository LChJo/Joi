/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentDispatchComponent } from "../../src/main/application/actors/components/agent-dispatch-component";
import { WorkbenchContextAssembler } from "../../src/main/application/joi/workbench-context-assembler.js";
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { SqlitePartnerDispatchClaims, SqlitePartnerDispatchDelivery } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter.js";
import { openRuntimeDatabase, type RuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";

const NOW = "2026-07-29T10:00:00.000Z";

function ctxAt(offsetMillis: number): ActorTickContext {
  const now = new Date(new Date(NOW).getTime() + offsetMillis);
  return { clock: { now: () => now }, now, tickId: 1 };
}

async function openFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "joi-agent-crash-"));
  const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
  const partners = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
  const partner = await partners.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [] });
  database.transaction((connection) => {
    connection.prepare(`INSERT INTO workbenches
      (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
      VALUES ('workbench_1', 'A', 'persona_1', 'summary', 'scope', 'project', 'memory_namespace_1', 'ACTIVE', ?, ?)`).run(NOW, NOW);
    connection.prepare(`INSERT INTO joi_inbox_messages (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
      VALUES ('input_1', 'idem_1', 'body', 'ROUTED', 'workbench_1', ?, ?)`).run(NOW, NOW);
    connection.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
      VALUES ('turn_1', 'input_1', 'workbench_1', 'joi_session:workbench_1', 'RUNNING', ?, ?)`).run(NOW, NOW);
    connection.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
      VALUES ('plan_1', 'turn_1', '{}', '{}', ?)`).run(NOW);
    connection.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
      VALUES ('work_1', 'workbench_1', 'input_1', 'the task', '{}', 'WRITE', 'READY', ?, ?)`).run(NOW, NOW);
    connection.prepare("INSERT INTO work_access_policies (work_id, access_mode) VALUES ('work_1', 'NONE')").run();
    connection.prepare(`INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
      VALUES ('outbox_1', 'partner.dispatch', ?, 'PENDING', 0, ?, ?)`).run(
      JSON.stringify({ actionId: "action_1", dispatchAttemptId: "attempt_1", workId: "work_1" }), NOW, NOW);
    connection.prepare(`INSERT INTO dispatch_attempts
      (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at, outbox_id)
      VALUES ('attempt_1', 'plan_1', 'work_1', ?, 1, 'action_1', 'PENDING', ?, ?, 'outbox_1')`).run(partner.partnerRevisionId, NOW, NOW);
    connection.prepare(`INSERT INTO partner_instances
      (instance_id, partner_id, partner_revision_id, session_policy, status, engine, workbench_id, created_at, last_used_at)
      VALUES ('instance_9', ?, ?, 'RESIDENT', 'IDLE', 'PI_CORE', 'workbench_1', ?, ?)`).run(partner.partnerId, partner.partnerRevisionId, NOW, NOW);
    connection.prepare(`INSERT INTO workbench_agent_sessions
      (agent_id, workbench_id, partner_id, partner_revision_id, backing_kind, backing_id, session_policy, created_at)
      VALUES ('instance_9', 'workbench_1', ?, ?, 'LOCAL_INSTANCE', 'instance_9', 'RESIDENT', ?)`).run(partner.partnerId, partner.partnerRevisionId, NOW);
  });
  return { database, partner, root };
}

function makeComponent(database: RuntimeDatabase, partnerId: string, dispatchSpy: { calls: unknown[] }) {
  const contexts = new SqliteWorkbenchContextRepository(database);
  const delivery = new SqlitePartnerDispatchDelivery({
    agentConversations: new SqliteWorkbenchAgentRepository(database),
    clock: new TestClock(),
    contextAssembler: new WorkbenchContextAssembler({ workbenches: new LegacyLifeStoreAdapter(database), clock: new TestClock(), ids: new TestIds(), projections: contexts, snapshots: contexts }),
    contexts,
    database,
    gateway: { recover: async () => { throw new Error("gateway unused"); }, startWithResult: async () => { throw new Error("gateway unused"); } },
    instances: {
      dispatch: async (input) => {
        dispatchSpy.calls.push(input);
        return { actionId: "action_1", artifacts: [], body: "done", externalRunId: "local_pi:action_1", status: "COMPLETED" as const, workId: "work_1" };
      },
    },
    leases: { acquire: async () => null, release: async () => undefined },
    partners: new SqlitePartnerRegistryRepository(database),
    results: new SqliteWorkResultRepository(database),
  });
  const component = new AgentDispatchComponent({
    workbenchId: "workbench_1",
    claims: new SqlitePartnerDispatchClaims(database),
    delivery,
    outbox: database.store,
    owner: "agent_crash_test",
    partnerId,
  });
  return component;
}

describe("agent dispatch crash recovery", () => {
  it("recovers a claim that expired before the ack (crash between claim and prepare)", async () => {
    const { database, partner, root } = await openFixture();
    try {
      database.transaction((connection) => connection.prepare(
        "UPDATE outbox SET status = 'CLAIMED', claim_owner = 'dead_pid', claim_until = ? WHERE outbox_id = 'outbox_1'",
      ).run(NOW));
      const spy = { calls: [] as unknown[] };
      const component = makeComponent(database, partner.partnerId, spy);

      await component.update(ctxAt(0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await component.update(ctxAt(2_000));

      expect(spy.calls).toHaveLength(1);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM outbox WHERE outbox_id = 'outbox_1'",
      ).get())).toEqual({ status: "DONE" });
      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1'",
      ).get())).toEqual({ status: "COMPLETED" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("finalizes an acked run whose ephemeral instance died as UNKNOWN", async () => {
    const { database, partner, root } = await openFixture();
    try {
      database.transaction((connection) => {
        connection.prepare("UPDATE outbox SET status = 'DONE' WHERE outbox_id = 'outbox_1'").run();
        connection.prepare("UPDATE dispatch_attempts SET status = 'RUNNING', instance_id = 'instance_9' WHERE dispatch_attempt_id = 'attempt_1'").run();
        connection.prepare("UPDATE partner_instances SET status = 'DISPOSED', disposal_reason = 'crash', disposed_at = ? WHERE instance_id = 'instance_9'").run(NOW);
        connection.prepare(`INSERT INTO workbench_context_snapshots
          (context_snapshot_id, workbench_id, work_id, persona_revision_id, safe_context_json, memory_summary_refs_json, created_at)
          VALUES ('context_x', 'workbench_1', 'work_1', 'persona_1', '{}', '[]', ?)`).run(NOW);
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at, context_snapshot_id)
          SELECT 'partner_run:action_1', 'attempt_1', 'action_1', 'workbench_1', 'work_1', partner_revision_id, 'LOCAL_PI', 'local_pi:action_1', 'RUNNING', ?, ?, 'context_x'
          FROM partner_revisions WHERE partner_revision_id = (SELECT partner_revision_id FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1')`).run(NOW, NOW);
      });
      const spy = { calls: [] as unknown[] };
      const component = makeComponent(database, partner.partnerId, spy);

      await component.update(ctxAt(0));

      expect(spy.calls).toHaveLength(0);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM partner_runs WHERE run_id = 'partner_run:action_1'",
      ).get())).toEqual({ status: "UNKNOWN" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("resumes an acked run whose resident instance survived the crash", async () => {
    const { database, partner, root } = await openFixture();
    try {
      database.transaction((connection) => {
        connection.prepare("UPDATE outbox SET status = 'DONE' WHERE outbox_id = 'outbox_1'").run();
        connection.prepare("UPDATE dispatch_attempts SET status = 'RUNNING', instance_id = 'instance_9' WHERE dispatch_attempt_id = 'attempt_1'").run();
        connection.prepare(`INSERT INTO workbench_context_snapshots
          (context_snapshot_id, workbench_id, work_id, persona_revision_id, safe_context_json, memory_summary_refs_json, created_at)
          VALUES ('context_x', 'workbench_1', 'work_1', 'persona_1', '{}', '[]', ?)`).run(NOW);
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at, context_snapshot_id)
          SELECT 'partner_run:action_1', 'attempt_1', 'action_1', 'workbench_1', 'work_1', partner_revision_id, 'LOCAL_PI', 'local_pi:action_1', 'RUNNING', ?, ?, 'context_x'
          FROM partner_revisions WHERE partner_revision_id = (SELECT partner_revision_id FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_1')`).run(NOW, NOW);
      });
      const spy = { calls: [] as unknown[] };
      const component = makeComponent(database, partner.partnerId, spy);

      await component.update(ctxAt(0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spy.calls).toHaveLength(1);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT status FROM partner_runs WHERE run_id = 'partner_run:action_1'",
      ).get())).toEqual({ status: "COMPLETED" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
