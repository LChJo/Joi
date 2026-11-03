import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { createWorkResult } from "../../src/main/domain/work/work-result.js";
import { SqlitePartnerDispatchClaims } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

const NOW = "2026-09-04T10:00:00.000Z";

async function openFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "joi-dependency-gate-"));
  const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
  const clock = new TestClock();
  const ids = new TestIds();
  const partners = new PartnerRegistryService({ clock, ids, repository: new SqlitePartnerRegistryRepository(database) });
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
  });
  return { clock, database, ids, partner, partnerRevisionId: partner.partnerRevisionId, root };
}

function seedWork(
  connection: DatabaseSync,
  input: { dependsOn?: string[]; partnerRevisionId: string; run?: boolean; status: string; workId: string },
): void {
  connection.prepare(`INSERT INTO work_items
    (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
    VALUES (?, 'workbench_1', 'input_1', ?, '{}', 'READ', ?, ?, ?)`).run(
    input.workId, input.workId, input.status, NOW, NOW,
  );
  const outboxId = `outbox_${input.workId}`;
  const actionId = `action_${input.workId}`;
  const attemptId = `attempt_${input.workId}`;
  connection.prepare(`INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
    VALUES (?, 'partner.dispatch', ?, 'PENDING', 0, ?, ?)`).run(
    outboxId, JSON.stringify({ actionId, dispatchAttemptId: attemptId, workId: input.workId }), NOW, NOW,
  );
  connection.prepare(`INSERT INTO dispatch_attempts
    (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at, outbox_id)
    VALUES (?, 'plan_1', ?, ?, 1, ?, 'PENDING', ?, ?, ?)`).run(
    attemptId, input.workId, input.partnerRevisionId, actionId, NOW, NOW, outboxId,
  );
  for (const dependsOn of input.dependsOn ?? []) {
    connection.prepare("INSERT INTO work_dependencies (work_id, depends_on_work_id) VALUES (?, ?)").run(input.workId, dependsOn);
  }
  if (input.run === true) {
    connection.prepare(`INSERT INTO partner_runs
      (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'workbench_1', ?, ?, 'LOCAL_PI', ?, 'RUNNING', ?, ?)`).run(
      `run_${input.workId}`, attemptId, actionId, input.workId, input.partnerRevisionId, `local:${input.workId}`, NOW, NOW,
    );
  }
}

function workFacts(database: Awaited<ReturnType<typeof openFixture>>["database"]) {
  return database.transaction((connection) => (
    connection.prepare("SELECT work_id, status, cancel_reason FROM work_items ORDER BY work_id").all()
  )) as { cancel_reason: string | null; status: string; work_id: string }[];
}

describe("work dependency gate and failure cascade", () => {
  it("pauses unstarted dispatches at the goal gate but preserves a persistently started run", async () => {
    const fixture = await openFixture();
    try {
      fixture.database.transaction((connection) => {
        seedWork(connection, { partnerRevisionId: fixture.partnerRevisionId, run: true, status: "RUNNING", workId: "work_started" });
        connection.prepare("UPDATE outbox SET status = 'DONE' WHERE outbox_id = (SELECT outbox_id FROM dispatch_attempts WHERE work_id = 'work_started')").run();
        seedWork(connection, { partnerRevisionId: fixture.partnerRevisionId, status: "PLANNED", workId: "work_queued" });
      });
      await new SqliteJoiInboxRepository(fixture.database, fixture.clock)
        .requireClarification("input_1", "question_required", "请选择验收范围");

      const claims = await new SqlitePartnerDispatchClaims(fixture.database).listClaimable({
        now: NOW,
        partnerId: fixture.partner.partnerId,
        workbenchId: "workbench_1",
      });
      expect(claims).toEqual([]);
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status FROM partner_runs WHERE work_id = 'work_started'",
      ).get())).toEqual({ status: "RUNNING" });
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("only claims a Work once every declared predecessor has completed", async () => {
    const fixture = await openFixture();
    try {
      fixture.database.transaction((connection) => {
        seedWork(connection, { partnerRevisionId: fixture.partnerRevisionId, run: true, status: "PLANNED", workId: "work_a" });
        seedWork(connection, { dependsOn: ["work_a"], partnerRevisionId: fixture.partnerRevisionId, status: "PLANNED", workId: "work_b" });
        seedWork(connection, { dependsOn: ["work_b"], partnerRevisionId: fixture.partnerRevisionId, status: "PLANNED", workId: "work_c" });
      });
      const claims = new SqlitePartnerDispatchClaims(fixture.database);
      const claimable = async () => (await claims.listClaimable({ now: NOW, partnerId: fixture.partner.partnerId, workbenchId: "workbench_1" }))
        .map((claim) => (JSON.parse(claim.payloadJson) as { workId: string }).workId);

      // Only the dependency root is claimable while its successors wait.
      expect(await claimable()).toEqual(["work_a"]);

      // Completing A releases B, but C stays gated behind B.
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET status = 'COMPLETED', updated_at = ? WHERE work_id = 'work_a'",
      ).run(NOW));
      expect(await claimable()).toEqual(["work_b"]);

      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET status = 'COMPLETED', updated_at = ? WHERE work_id = 'work_b'",
      ).run(NOW));
      expect(await claimable()).toEqual(["work_c"]);
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("cascades a deterministic cancellation through the whole downstream closure when a Work fails", async () => {
    const fixture = await openFixture();
    try {
      fixture.database.transaction((connection) => {
        seedWork(connection, { partnerRevisionId: fixture.partnerRevisionId, run: true, status: "RUNNING", workId: "work_a" });
        seedWork(connection, { dependsOn: ["work_a"], partnerRevisionId: fixture.partnerRevisionId, status: "PLANNED", workId: "work_b" });
        seedWork(connection, { dependsOn: ["work_b"], partnerRevisionId: fixture.partnerRevisionId, status: "READY", workId: "work_c" });
      });
      const results = new SqliteWorkResultRepository(fixture.database);
      await results.record(createWorkResult({
        actionId: "action_work_a", artifacts: [], body: "the run failed", createdAt: NOW, isLate: false,
        partnerRevisionId: fixture.partnerRevisionId, resultId: "result_work_a", runId: "run_work_a",
        status: "FAILED", workbenchId: "workbench_1", workId: "work_a",
      }));

      expect(workFacts(fixture.database)).toEqual([
        { cancel_reason: null, status: "FAILED", work_id: "work_a" },
        { cancel_reason: "dependency_failed", status: "CANCELED", work_id: "work_b" },
        { cancel_reason: "dependency_failed", status: "CANCELED", work_id: "work_c" },
      ]);
      // No claimable residue remains for the canceled successors.
      const claims = new SqlitePartnerDispatchClaims(fixture.database);
      expect(await claims.listClaimable({ now: NOW, partnerId: fixture.partner.partnerId, workbenchId: "workbench_1" })).toEqual([]);
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("cancels a user-canceled Work's successors with a distinct reason", async () => {
    const fixture = await openFixture();
    try {
      fixture.database.transaction((connection) => {
        seedWork(connection, { partnerRevisionId: fixture.partnerRevisionId, status: "READY", workId: "work_a" });
        seedWork(connection, { dependsOn: ["work_a"], partnerRevisionId: fixture.partnerRevisionId, status: "PLANNED", workId: "work_b" });
      });
      const plans = new SqliteWorkPlanRepository(fixture.database);
      await expect(plans.cancel("work_a", NOW)).resolves.toEqual({ canceled: true, cascadedWorkIds: ["work_b"] });
      expect(workFacts(fixture.database)).toEqual([
        { cancel_reason: null, status: "CANCELED", work_id: "work_a" },
        { cancel_reason: "dependency_canceled", status: "CANCELED", work_id: "work_b" },
      ]);
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("cancels a new Work on arrival when it depends on an already failed predecessor", async () => {
    const fixture = await openFixture();
    try {
      fixture.database.transaction((connection) => {
        seedWork(connection, { partnerRevisionId: fixture.partnerRevisionId, run: true, status: "RUNNING", workId: "work_a" });
      });
      await new SqliteWorkResultRepository(fixture.database).record(createWorkResult({
        actionId: "action_work_a", artifacts: [], body: "the run failed", createdAt: NOW, isLate: false,
        partnerRevisionId: fixture.partnerRevisionId, resultId: "result_work_a", runId: "run_work_a",
        status: "FAILED", workbenchId: "workbench_1", workId: "work_a",
      }));

      // A later plan declares a successor against the already failed Work; the commit
      // transaction cancels it on arrival instead of leaving it unclaimable forever.
      const plans = new SqliteWorkPlanRepository(fixture.database);
      await plans.commit({
        attempts: [],
        briefs: [{ acceptanceChecks: [], workId: "work_late" }],
        createdAt: NOW,
        dependencies: [{ dependsOnWorkId: "work_a", workId: "work_late" }],
        dispatchPlanId: "plan_late",
        inputId: "input_1",
        items: [{
          accessMode: "READ", createdAt: NOW, status: "PLANNED", title: "late", updatedAt: NOW, workbenchId: "workbench_1", workId: "work_late",
        }],
        policyResults: [{ allowed: true, workId: "work_late" }],
        turnId: "turn_1",
        waves: [["work_late"]],
      });
      expect(workFacts(fixture.database).find((row) => row.work_id === "work_late")).toEqual({
        cancel_reason: "dependency_failed", status: "CANCELED", work_id: "work_late",
      });
    } finally {
      fixture.database.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
