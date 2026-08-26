import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentService } from "../../src/main/application/agents/agent-service.js";
import { LifeService } from "../../src/main/application/lives/life-service.js";
import { WorkbenchRegistryService } from "../../src/main/application/joi/workbench-registry-service.js";
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteWorkbenchAgentScan } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-scan.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

async function copyMigrationsThrough(destination: string, maximumVersion: number): Promise<void> {
  await mkdir(destination, { recursive: true });
  const source = path.resolve("resources/migrations");
  for (const filename of await readdir(source)) {
    const version = Number.parseInt(filename.split("_", 1)[0] ?? "", 10);
    if (Number.isSafeInteger(version) && version <= maximumVersion) await copyFile(path.join(source, filename), path.join(destination, filename));
  }
}

describe("JOI-01 non-destructive migration", () => {
  it("recovers legacy crash-loop parking without reclassifying real user cancellations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-input-failure-upgrade-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 39);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const now = "2026-08-20T05:06:00.000Z";
    oldDatabase.transaction((connection) => {
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, canceled_at, created_at, updated_at)
        VALUES ('legacy-parked', 'legacy-parked-key', 'parked', 'CONSUMED', ?, ?, ?),
               ('user-canceled', 'user-canceled-key', 'canceled', 'CONSUMED', ?, ?, ?)`).run(now, now, now, now, now, now);
      const insertTurn = connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, session_id, status, created_at, updated_at) VALUES (?, 'legacy-parked', ?, 'FAILED', ?, ?)`);
      for (let index = 0; index < 8; index += 1) insertTurn.run(`turn-${String(index)}`, `session-${String(index)}`, now, now);
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      expect(upgraded.inspect().schemaVersion).toBe(46);
      const rows = upgraded.transaction((connection) => connection.prepare(`SELECT input_id, canceled_at, failed_at,
        failure_count, failure_reason_code FROM joi_inbox_messages ORDER BY input_id`).all());
      expect(rows).toEqual([
        { canceled_at: null, failed_at: now, failure_count: 8, failure_reason_code: "legacy_scheduler_failure", input_id: "legacy-parked" },
        { canceled_at: now, failed_at: null, failure_count: null, failure_reason_code: null, input_id: "user-canceled" },
      ]);
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves the historical 041 repair and removes its ownership index in 045", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-workspace-ownership-upgrade-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 40);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const clock = new TestClock();
    const ids = new TestIds();
    const registry = new WorkbenchRegistryService({ clock, ids, repository: new LegacyLifeStoreAdapter(oldDatabase) });
    const first = await registry.create({ name: "第一个", personaSummary: "private", projectLabel: "工程一", scopeSummary: "范围一" });
    const second = await registry.create({ name: "第二个", personaSummary: "private", projectLabel: "工程二", scopeSummary: "范围二" });
    const now = "2026-08-21T06:00:00.000Z";
    oldDatabase.transaction((connection) => connection.prepare(`INSERT INTO workbench_workspace_roots
      (workspace_ref, root_path, created_at, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`)
      .run(`workbench_workspace:${first.workbenchId}`, "/legacy/shared", now, now, `workbench_workspace:${second.workbenchId}`, "/legacy/shared", now, now));
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const facts = upgraded.transaction((connection) => ({
        bindings: connection.prepare(`SELECT workbench_id, kind, status FROM workbench_workspace_bindings
          WHERE workbench_id IN (?, ?) ORDER BY workbench_id`).all(first.workbenchId, second.workbenchId),
        outbox: connection.prepare(`SELECT outbox_id, kind, payload_json FROM outbox
          WHERE outbox_id = ?`).get(`workbench_workspace_repair_041:${second.workbenchId}`),
        roots: connection.prepare(`SELECT workspace_ref, root_path FROM workbench_workspace_roots
          WHERE root_path = '/legacy/shared'`).all(),
      }));
      expect(facts.roots).toEqual([{ root_path: "/legacy/shared", workspace_ref: `workbench_workspace:${first.workbenchId}` }]);
      expect(facts.bindings).toEqual([
        { kind: "MANAGED", status: "PROVISIONING", workbench_id: first.workbenchId },
        { kind: "MANAGED", status: "PROVISIONING", workbench_id: second.workbenchId },
      ]);
      expect(facts.outbox).toMatchObject({
        kind: "workbench.workspace.provision",
        outbox_id: `workbench_workspace_repair_041:${second.workbenchId}`,
        payload_json: JSON.stringify({ workbenchId: second.workbenchId, workspaceRef: `workbench_workspace:${second.workbenchId}` }),
      });
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT 1 FROM pragma_index_list('workbench_workspace_roots') WHERE name = 'idx_workbench_workspace_roots_root_path'",
      ).get())).toBeUndefined();
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT 1 FROM pragma_index_list('workbench_workspace_roots') WHERE name = 'idx_workbench_workspace_roots_path'",
      ).get())).toEqual({ 1: 1 });
      upgraded.transaction((connection) => connection.prepare(`INSERT INTO workbench_workspace_roots
        (workspace_ref, root_path, created_at, updated_at) VALUES (?, '/legacy/shared', ?, ?)`)
        .run(`workbench_workspace:${second.workbenchId}`, now, now));
      expect(upgraded.transaction((connection) => connection.prepare(`SELECT COUNT(*) AS count
        FROM workbench_workspace_roots WHERE root_path = '/legacy/shared'`).get())).toEqual({ count: 2 });
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renames the 037 context schema to Workbench without losing rows or stable ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-workbench-terminology-upgrade-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 37);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const now = "2026-08-06T15:00:00.000Z";
    oldDatabase.transaction((connection) => {
      connection.prepare(`INSERT INTO avatars
        (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
         memory_namespace_id, status, created_at, updated_at)
        VALUES ('context-038', '发布台', 'persona-038', 'summary', 'scope', 'project',
                'memory-038', 'ACTIVE', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, clarification_reason_code, avatar_id, created_at, updated_at)
        VALUES ('goal-038', 'key-038', 'goal', 'CLARIFICATION_REQUIRED',
                'avatar_workspace_not_ready', 'context-038', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_harness_maps
        (goal_input_id, avatar_id, destination, status, revision, reviewed_revision, created_at, updated_at)
        VALUES ('goal-038', 'context-038', 'ship', 'ACTIVE', 1, 0, ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_harness_decisions
        (decision_id, goal_input_id, kind, summary, detail, created_at)
        VALUES ('decision-038', 'goal-038', 'AVATAR_REFINE', 'narrow scope', '', ?)`).run(now);
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const facts = upgraded.transaction((connection) => ({
        decision: connection.prepare("SELECT kind FROM joi_harness_decisions WHERE decision_id = 'decision-038'").get(),
        foreignKeys: connection.prepare("PRAGMA foreign_key_check").all(),
        inbox: connection.prepare("SELECT clarification_reason_code, workbench_id FROM joi_inbox_messages WHERE input_id = 'goal-038'").get(),
        oldNamedObjects: connection.prepare("SELECT name FROM sqlite_master WHERE lower(name) LIKE '%avatar%' ORDER BY name").all(),
        outbox: connection.prepare("SELECT outbox_id, kind, payload_json FROM outbox WHERE outbox_id = 'avatar_workspace_provision:context-038'").get(),
        workbench: connection.prepare("SELECT workbench_id, name FROM workbenches WHERE workbench_id = 'context-038'").get(),
      }));
      expect(facts).toEqual({
        decision: { kind: "WORKBENCH_REFINE" },
        foreignKeys: [],
        inbox: { clarification_reason_code: "workbench_workspace_not_ready", workbench_id: "context-038" },
        oldNamedObjects: [],
        outbox: {
          kind: "workbench.workspace.provision",
          outbox_id: "avatar_workspace_provision:context-038",
          payload_json: '{"workspaceRef":"avatar_workspace:context-038","workbenchId":"context-038"}',
        },
        workbench: { name: "发布台", workbench_id: "context-038" },
      });
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("backfills historical goals into cleared harness maps and leaves live goals untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-harness-upgrade-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 36);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const now = "2026-08-05T09:00:00.000Z";
    oldDatabase.transaction((connection) => {
      connection.prepare(`INSERT INTO avatars
        (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
         memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench-harness', 'A', 'persona-harness', 'summary', 'scope', 'project',
                'memory-harness', 'ACTIVE', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
        VALUES ('goal-history', 'key-history', 'done goal', 'CONSUMED', 'workbench-harness', ?, ?),
               ('goal-live', 'key-live', 'live goal', 'ROUTED', 'workbench-harness', ?, ?),
               ('joi_result_input:goal:goal-history', 'key-history-synthetic', 'synthetic', 'CONSUMED', 'workbench-harness', ?, ?)`)
        .run(now, now, now, now, now, now);
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const maps = upgraded.transaction((connection) => connection.prepare(`
        SELECT goal_input_id, status, feedback_recorded_at IS NOT NULL AS feedback_done
          FROM joi_harness_maps ORDER BY goal_input_id`).all());
      expect(maps).toEqual([
        { goal_input_id: "goal-history", status: "CLEARED", feedback_done: 1 },
      ]);
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reconciles already-consumed legacy result inputs into a deletable goal outcome", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-goal-outcome-upgrade-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 35);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const now = "2026-08-05T07:00:00.000Z";
    const partner = await new PartnerRegistryService({
      clock: new TestClock(now), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(oldDatabase),
    }).add({ capabilities: [], displayName: "旧搭档", kind: "local-pi", skills: [], tools: [] });
    oldDatabase.transaction((connection) => {
      connection.prepare(`INSERT INTO avatars
        (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
         memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench-outcome', 'A', 'persona-outcome', 'summary', 'scope', 'project',
                'memory-outcome', 'ACTIVE', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
        VALUES ('goal-outcome', 'key-outcome', 'legacy goal', 'CONSUMED', 'workbench-outcome', ?, ?),
               ('joi_result_input:legacy-event', 'key-legacy-result', 'legacy result', 'CONSUMED', 'workbench-outcome', ?, ?)`)
        .run(now, now, now, now);
      connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at)
        VALUES ('turn-outcome', 'goal-outcome', 'workbench-outcome', 'session-outcome', 'COMPLETED', ?, ?)`)
        .run(now, now);
      connection.prepare(`INSERT INTO dispatch_plans
        (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
        VALUES ('plan-outcome', 'turn-outcome', '{"workIds":["work-outcome"]}', '[]', ?)`).run(now);
      connection.prepare(`INSERT INTO work_items
        (work_id, avatar_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-outcome', 'workbench-outcome', 'goal-outcome', 'legacy work', '{}', 'READ', 'COMPLETED', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO dispatch_attempts
        (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
        VALUES ('attempt-outcome', 'plan-outcome', 'work-outcome', ?, 1, 'action-outcome', 'COMPLETED', ?, ?)`)
        .run(partner.partnerRevisionId, now, now);
      connection.prepare(`INSERT INTO partner_runs
        (run_id, dispatch_attempt_id, action_id, avatar_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
        VALUES ('run-outcome', 'attempt-outcome', 'action-outcome', 'workbench-outcome', 'work-outcome', ?, 'LOCAL_PI', 'local:outcome', 'COMPLETED', ?, ?)`)
        .run(partner.partnerRevisionId, now, now);
      connection.prepare("INSERT INTO work_result_bodies (body_ref, body, created_at) VALUES ('body-outcome', 'private', ?)").run(now);
      connection.prepare(`INSERT INTO work_results
        (result_id, run_id, action_id, avatar_id, work_id, partner_revision_id, status, summary, body_ref,
         artifacts_json, is_late, is_authoritative, created_at)
        VALUES ('result-outcome', 'run-outcome', 'action-outcome', 'workbench-outcome', 'work-outcome', ?,
                'COMPLETED', 'legacy summary', 'body-outcome', '[]', 0, 1, ?)`).run(partner.partnerRevisionId, now);
      connection.prepare("INSERT INTO work_result_verifications (result_id, status, created_at) VALUES ('result-outcome', 'NOT_REQUIRED', ?)").run(now);
      connection.prepare(`INSERT INTO partner_result_events
        (event_id, run_id, avatar_id, work_id, partner_revision_id, status, created_at, consumed_at, input_id)
        VALUES ('legacy-event', 'run-outcome', 'workbench-outcome', 'work-outcome', ?, 'COMPLETED', ?, ?, 'joi_result_input:legacy-event')`)
        .run(partner.partnerRevisionId, now, now);
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      expect(upgraded.transaction((connection) => connection.prepare(`SELECT s.revision, s.synthesized_revision,
        o.completion_summary FROM joi_goal_result_sets s JOIN joi_goal_outcomes o ON o.input_id = s.original_input_id
        WHERE s.original_input_id = 'goal-outcome'`).get())).toEqual({
        completion_summary: "历史工作已完成；Agent 结果可在工作台详情中查看。", revision: 1, synthesized_revision: 1,
      });
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("backfills a deterministic historical Work goal binding and rejects new unbound Work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-work-goal-binding-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 33);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const now = "2026-08-05T08:00:00.000Z";
    oldDatabase.transaction((connection) => {
      connection.prepare(`INSERT INTO avatars
        (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
         memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench-binding', 'A', 'persona-binding', 'summary', 'scope', 'project',
                'memory-binding', 'ACTIVE', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
        VALUES ('input-binding', 'idem-binding', 'private request', 'ROUTED', 'workbench-binding', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at)
        VALUES ('turn-binding', 'input-binding', 'workbench-binding', 'session-binding', 'COMPLETED', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO dispatch_plans
        (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
        VALUES ('plan-binding', 'turn-binding', '{"workIds":["work-binding"]}', '[]', ?)`).run(now);
      connection.prepare(`INSERT INTO work_items
        (work_id, avatar_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-binding', 'workbench-binding', NULL, 'work', '{}', 'READ', 'COMPLETED', ?, ?)`).run(now, now);
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT input_id FROM work_items WHERE work_id = 'work-binding'",
      ).get())).toEqual({ input_id: "input-binding" });
      expect(() => upgraded.transaction((connection) => connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-unbound', 'workbench-binding', NULL, 'invalid', '{}', 'READ', 'PLANNED', ?, ?)`)
        .run(now, now))).toThrow();
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("terminalizes schema 038 UNKNOWN Work and makes its result eligible for goal synthesis again", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-unknown-work-upgrade-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 38);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const now = "2026-08-07T06:54:20.327Z";
    const partner = await new PartnerRegistryService({
      clock: new TestClock(now), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(oldDatabase),
    }).add({ capabilities: [], displayName: "超时搭档", kind: "local-pi", skills: [], tools: [] });
    oldDatabase.transaction((connection) => {
      connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
         memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench-unknown', '排查台', 'persona-unknown', 'summary', 'scope', 'project',
                'memory-unknown', 'ACTIVE', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
        VALUES ('goal-unknown', 'key-unknown', 'private goal', 'CONSUMED', 'workbench-unknown', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
        VALUES ('turn-unknown', 'goal-unknown', 'workbench-unknown', 'session-unknown', 'COMPLETED', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO dispatch_plans
        (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
        VALUES ('plan-unknown', 'turn-unknown', '{"workIds":["work-unknown"]}', '[]', ?)`).run(now);
      connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-unknown', 'workbench-unknown', 'goal-unknown', 'timeout work', '{}', 'READ', 'WAITING', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO dispatch_attempts
        (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
        VALUES ('attempt-unknown', 'plan-unknown', 'work-unknown', ?, 1, 'action-unknown', 'UNKNOWN', ?, ?)`)
        .run(partner.partnerRevisionId, now, now);
      connection.prepare(`INSERT INTO partner_runs
        (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind,
         external_run_id, status, created_at, updated_at)
        VALUES ('run-unknown', 'attempt-unknown', 'action-unknown', 'workbench-unknown', 'work-unknown', ?,
                'LOCAL_PI', 'local:unknown', 'UNKNOWN', ?, ?)`).run(partner.partnerRevisionId, now, now);
      connection.prepare("INSERT INTO work_result_bodies (body_ref, body, created_at) VALUES ('body-unknown', 'private', ?)").run(now);
      connection.prepare(`INSERT INTO work_results
        (result_id, run_id, action_id, workbench_id, work_id, partner_revision_id, status, summary, body_ref,
         artifacts_json, is_late, is_authoritative, created_at)
        VALUES ('result-unknown', 'run-unknown', 'action-unknown', 'workbench-unknown', 'work-unknown', ?,
                'UNKNOWN', '', 'body-unknown', '[]', 0, 1, ?)`).run(partner.partnerRevisionId, now);
      connection.prepare("INSERT INTO work_result_verifications (result_id, status, created_at) VALUES ('result-unknown', 'NOT_REQUIRED', ?)").run(now);
      connection.prepare(`INSERT INTO partner_result_events
        (event_id, run_id, workbench_id, work_id, partner_revision_id, status, created_at)
        VALUES ('event-unknown', 'run-unknown', 'workbench-unknown', 'work-unknown', ?, 'UNKNOWN', ?)`)
        .run(partner.partnerRevisionId, now);
      connection.prepare(`INSERT INTO joi_goal_result_sets
        (original_input_id, revision, synthesized_revision, updated_at)
        VALUES ('goal-unknown', 1, 0, ?)`).run(now);
      connection.prepare(`INSERT INTO joi_goal_result_members
        (original_input_id, event_id, revision) VALUES ('goal-unknown', 'event-unknown', 1)`).run();
      connection.prepare(`UPDATE workbench_task_projections
        SET active_work_json = '[{"workId":"work-unknown","title":"timeout work","status":"WAITING"}]'
        WHERE workbench_id = 'workbench-unknown'`).run();
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const facts = upgraded.transaction((connection) => ({
        memberCount: (connection.prepare(`SELECT COUNT(*) AS count FROM joi_goal_result_members
          WHERE event_id = 'event-unknown'`).get() as { count: number }).count,
        projection: connection.prepare(`SELECT active_work_json FROM workbench_task_projections
          WHERE workbench_id = 'workbench-unknown'`).get() as { active_work_json: string },
        work: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work-unknown'").get(),
      }));
      expect(upgraded.inspect().schemaVersion).toBe(46);
      expect(facts.work).toEqual({ status: "FAILED" });
      expect(JSON.parse(facts.projection.active_work_json)).toEqual([]);
      expect(facts.memberCount).toBe(0);

      const [result] = await new SqliteWorkbenchAgentScan(upgraded).listUnsynthesizedResults("workbench-unknown");
      expect(result).toMatchObject({ eventId: "event-unknown", status: "UNKNOWN", workId: "work-unknown" });
      await expect(new SqliteJoiInboxRepository(upgraded).enqueuePartnerResult(result ?? {
        workbenchId: "missing", eventId: "missing", resultId: "missing", status: "UNKNOWN", summary: "", workId: "missing",
      })).resolves.toBe("joi_result_input:goal:goal-unknown");
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("creates the new orchestration schema on an empty database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-schema-empty-"));
    const database = await openRuntimeDatabase({
      databasePath: path.join(root, "runtime.sqlite"),
      migrationsDirectory: path.resolve("resources/migrations"),
    });
    try {
      expect(database.inspect().schemaVersion).toBe(46);
      expect(database.transaction((connection) => connection.prepare("PRAGMA table_info(joi_goal_outcomes)").all()))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "disposition", notnull: 1 })]));
      expect(database.transaction((connection) => connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workbench_agent_sessions', 'workbench_agent_conversation_entries') ORDER BY name",
      ).all())).toEqual([
        { name: "workbench_agent_conversation_entries" },
        { name: "workbench_agent_sessions" },
      ]);
      expect(database.transaction((connection) => connection.prepare("PRAGMA table_info(model_source_revisions)").all()))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "access_mode" }), expect.objectContaining({ name: "protocol" })]));
      expect(database.transaction((connection) => connection.prepare("PRAGMA table_info(model_source_health)").all()))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "last_error" })]));
      expect(database.transaction((connection) => connection.prepare("PRAGMA table_info(joi_inbox_messages)").all()))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "clarification_prompt" }), expect.objectContaining({ name: "dismissed_at" })]));
      const names = database.transaction((connection) => connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all().map((row) => String((row as { name: unknown }).name)));
      expect(names).toEqual(expect.arrayContaining([
        "workbenches",
        "workbench_change_requests",
        "workbench_merges",
        "model_sources",
        "model_source_credentials",
        "model_source_revisions",
        "model_source_model_revisions",
        "model_source_health",
        "partners",
        "partner_revisions",
        "partner_prompts",
        "partner_runs",
        "partner_result_events",
        "workbench_partner_policies",
        "joi_inbox_messages",
        "joi_attachments",
        "joi_inbox_attachments",
        "joi_turns",
        "joi_session_messages",
        "work_items",
        "work_dependencies",
        "dispatch_attempts",
        "workspace_leases",
        "workbench_workspace_bindings",
        "workbench_workspace_roots",
        "workbench_task_projections",
        "workbench_context_snapshots",
        "work_results",
        "work_result_bodies",
        "joi_harness_maps",
        "joi_harness_paths",
        "joi_harness_decisions",
        "joi_harness_fog",
      ]));
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("backfills legacy identities without changing old counts and maps the primary Agent to preferred Partner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-schema-upgrade-"));
    const legacyMigrations = path.join(root, "legacy-migrations");
    await copyMigrationsThrough(legacyMigrations, 16);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: legacyMigrations });
    const clock = new TestClock();
    const ids = new TestIds();
    const sse = { publish: () => undefined };
    const agents = new AgentService({ clock, ids, store: oldDatabase.store });
    const lives = new LifeService({ clock, ids, publisher: sse, store: oldDatabase.store });
    const agent = await agents.createShell({ cardUrl: "http://192.168.1.20/card.json", name: "旧主 Agent" });
    await agents.activateForReadiness(agent.agentConnectionId);
    const legacy = await lives.create({
      mainAgentConnectionId: agent.agentConnectionId,
      name: "产品工作",
      personaSummary: "保留全部旧上下文",
      timezone: "Asia/Shanghai",
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      expect(upgraded.inspect().schemaVersion).toBe(46);
      const counts = upgraded.transaction((connection) => ({
        agents: (connection.prepare("SELECT COUNT(*) AS count FROM agent_connections").get() as { count: number }).count,
        workbenches: (connection.prepare("SELECT COUNT(*) AS count FROM workbenches").get() as { count: number }).count,
        lives: (connection.prepare("SELECT COUNT(*) AS count FROM lives").get() as { count: number }).count,
        partners: (connection.prepare("SELECT COUNT(*) AS count FROM partners").get() as { count: number }).count,
      }));
      expect(counts).toEqual({ agents: 1, workbenches: 1, lives: 1, partners: 1 });

      const mapping = upgraded.transaction((connection) => connection.prepare(`
        SELECT a.workbench_id, a.legacy_life_id, p.preferred_partner_id
          FROM workbenches a JOIN workbench_partner_policies p ON p.workbench_id = a.workbench_id
         WHERE a.workbench_id = ?`).get(legacy.lifeId)) as { workbench_id: string; legacy_life_id: string; preferred_partner_id: string };
      expect(mapping).toEqual({
        workbench_id: legacy.lifeId,
        legacy_life_id: legacy.lifeId,
        preferred_partner_id: `partner_${agent.agentConnectionId}`,
      });

      const adapter = new LegacyLifeStoreAdapter(upgraded);
      expect(await adapter.getWorkbench(legacy.lifeId)).toMatchObject({
        workbenchId: legacy.lifeId,
        profile: { name: "产品工作", personaSummary: "保留全部旧上下文" },
      });
      expect(await adapter.getPreferredPartnerId(legacy.lifeId)).toBe(`partner_${agent.agentConnectionId}`);

      const upgradedSse = { publish: () => undefined };
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      ).all())).toEqual(expect.arrayContaining([{ name: "mirror_new_life_as_workbench" }]));
      const compatibilityLives = new LifeService({ clock, ids, publisher: upgradedSse, store: upgraded.store });
      const mirrored = await compatibilityLives.create({
        mainAgentConnectionId: agent.agentConnectionId,
        name: "兼容创建",
        personaSummary: "旧 API 仍会镜像 Workbench",
        timezone: "Asia/Shanghai",
      });
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT workbench_id, status FROM workbenches WHERE workbench_id = ?",
      ).get(mirrored.lifeId))).toEqual({ workbench_id: mirrored.lifeId, status: "ACTIVE" });
      expect(await adapter.getWorkbench(mirrored.lifeId)).toMatchObject({ profile: { name: "兼容创建" } });
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT kind, status FROM workbench_workspace_bindings WHERE workbench_id = ?",
      ).get(mirrored.lifeId))).toEqual({ kind: "MANAGED", status: "PROVISIONING" });

      const registry = new WorkbenchRegistryService({ clock, ids, repository: adapter });
      const nativeWorkbench = await registry.create({
        name: "原生 Workbench",
        personaSummary: "由唯一 joi 创建",
        projectLabel: "新工程",
        scopeSummary: "新的隔离范围",
      });
      expect(await adapter.getWorkbench(nativeWorkbench.workbenchId)).toMatchObject({
        profile: { name: "原生 Workbench", scopeSummary: "新的隔离范围" },
        project: { label: "新工程" },
      });
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT kind, status FROM workbench_workspace_bindings WHERE workbench_id = ?",
      ).get(nativeWorkbench.workbenchId))).toEqual({ kind: "MANAGED", status: "PROVISIONING" });
      const provisioningPayload = upgraded.transaction((connection) => connection.prepare(
        "SELECT payload_json FROM outbox WHERE outbox_id = ?",
      ).get(`workbench_workspace_provision:${nativeWorkbench.workbenchId}`)) as { payload_json: string };
      expect(provisioningPayload.payload_json).not.toContain(path.parse(databasePath).root);
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("backfills existing source protocols without changing credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-schema-protocol-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 21);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const now = "2026-07-30T10:00:00.000Z";
    oldDatabase.transaction((connection) => {
      connection.prepare(`INSERT INTO model_source_credentials
        (provider_id, credential_type, encrypted_blob, credential_version, updated_at)
        VALUES ('joi-source:kimi-old', 'api_key', ?, 1, ?)`)
        .run(new Uint8Array([7, 8, 9]), now);
      connection.prepare(`INSERT INTO model_sources
        (source_id, status, active_source_revision_id, active_model_revision_id, created_at, updated_at)
        VALUES ('kimi-old', 'DRAFT', NULL, NULL, ?, ?)`)
        .run(now, now);
      connection.prepare(`INSERT INTO model_source_revisions
        (source_revision_id, source_id, kind, access_mode, display_name, credential_ref, credential_version, created_at)
        VALUES ('revision-kimi-old', 'kimi-old', 'kimi', 'coding-plan', 'Kimi Code', 'joi-source:kimi-old', 1, ?)`)
        .run(now);
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT protocol FROM model_source_revisions WHERE source_revision_id = 'revision-kimi-old'",
      ).get())).toEqual({ protocol: "anthropic" });
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT length(encrypted_blob) AS size FROM model_source_credentials WHERE provider_id = 'joi-source:kimi-old'",
      ).get())).toEqual({ size: 3 });
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("invalidates pre-027 work and instances while provisioning every active Workbench", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-schema-workbench-private-upgrade-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 26);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const now = "2026-08-01T10:00:00.000Z";
    const partners = new PartnerRegistryService({
      clock: new TestClock(now), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(oldDatabase),
    });
    const partner = await partners.add({ capabilities: [], displayName: "旧搭档", kind: "local-pi", skills: [], tools: [] });
    oldDatabase.transaction((connection) => {
      connection.prepare("UPDATE partner_revisions SET workspace_ref = 'C:\\\\legacy\\\\must-not-run' WHERE partner_revision_id = ?")
        .run(partner.partnerRevisionId);
      connection.prepare(`INSERT INTO avatars
        (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
         memory_namespace_id, task_summary, status, created_at, updated_at)
        VALUES ('workbench-upgrade', '升级 Workbench', 'persona-upgrade', 'private persona', 'scope', 'project',
                'memory-upgrade', '', 'ACTIVE', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
        VALUES ('input-upgrade', 'idem-upgrade', 'private body', 'ROUTED', 'workbench-upgrade', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at)
        VALUES ('turn-upgrade', 'input-upgrade', 'workbench-upgrade', 'session-upgrade', 'RUNNING', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO dispatch_plans
        (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
        VALUES ('plan-upgrade', 'turn-upgrade', '{}', '{}', ?)`).run(now);
      connection.prepare(`INSERT INTO work_items
        (work_id, avatar_id, input_id, title, intent_json, access_mode, workspace_ref, status, created_at, updated_at)
        VALUES ('work-upgrade', 'workbench-upgrade', 'input-upgrade', 'old work', '{}', 'WRITE',
                'C:\\\\legacy\\\\must-not-run', 'RUNNING', ?, ?)`).run(now, now);
      connection.prepare(`INSERT INTO partner_instances
        (instance_id, partner_id, partner_revision_id, session_policy, status, engine, created_at, last_used_at)
        VALUES ('instance-upgrade', ?, ?, 'RESIDENT', 'BUSY', 'PI_CORE', ?, ?)`)
        .run(partner.partnerId, partner.partnerRevisionId, now, now);
      connection.prepare(`INSERT INTO dispatch_attempts
        (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id,
         status, instance_id, created_at, updated_at)
        VALUES ('attempt-upgrade', 'plan-upgrade', 'work-upgrade', ?, 1, 'action-upgrade',
                'RUNNING', 'instance-upgrade', ?, ?)`).run(partner.partnerRevisionId, now, now);
      connection.prepare(`INSERT INTO partner_runs
        (run_id, dispatch_attempt_id, action_id, avatar_id, work_id, partner_revision_id, kind,
         external_run_id, status, created_at, updated_at)
        VALUES ('run-upgrade', 'attempt-upgrade', 'action-upgrade', 'workbench-upgrade', 'work-upgrade', ?,
                'A2A', 'remote-upgrade', 'WAITING_INPUT', ?, ?)`).run(partner.partnerRevisionId, now, now);
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const facts = upgraded.transaction((connection) => ({
        attempt: connection.prepare("SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt-upgrade'").get(),
        binding: connection.prepare("SELECT kind, status FROM workbench_workspace_bindings WHERE workbench_id = 'workbench-upgrade'").get(),
        cancel: connection.prepare("SELECT kind, payload_json, status FROM outbox WHERE outbox_id = 'partner_cancel_027:run-upgrade'").get(),
        instance: connection.prepare("SELECT workbench_id, disposal_reason, status FROM partner_instances WHERE instance_id = 'instance-upgrade'").get(),
        work: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work-upgrade'").get(),
      }));
      expect(facts).toEqual({
        attempt: { status: "FAILED" },
        binding: { kind: "MANAGED", status: "PROVISIONING" },
        cancel: { kind: "partner.cancel", payload_json: '{"runId":"run-upgrade","actionId":"action-upgrade"}', status: "PENDING" },
        instance: { workbench_id: null, disposal_reason: "upgrade_027", status: "DISPOSED" },
        work: { status: "CANCELED" },
      });
      expect(await new SqlitePartnerRegistryRepository(upgraded).getActive(partner.partnerId))
        .not.toHaveProperty("workspaceRef");
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
