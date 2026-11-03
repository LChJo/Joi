import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { AutomationService } from "../../src/main/application/automation/automation-service.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { SqliteAutomationStore } from "../../src/main/infrastructure/persistence/sqlite-automation-store.js";
import { SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { enqueueGoalResultSynthesis } from "../../src/main/infrastructure/persistence/sqlite-goal-result-synthesis.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture.js";

async function setup() {
  const fixture = await createRuntimeFixture();
  const workbench = await fixture.workbenchRegistry.create({ name: "History", personaSummary: "Synthetic", projectLabel: "History", scopeSummary: "Synthetic" });
  const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
  const service = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository: inbox });
  const reader = new SqliteJoiHomeFeedRepository(fixture.database);
  const goal = await service.accept({ idempotencyKey: "history-goal", text: "Synthetic goal", workbenchId: workbench.workbenchId });
  const complete = async (turnId: string, body: string) => {
    await inbox.createTurn({ inputId: goal.inputId, workbenchId: workbench.workbenchId, turnId, sessionId: "synthetic-session", createdAt: fixture.clock.now().toISOString() });
    await inbox.completeInput(goal.inputId, turnId, { outcome: "DIRECT_ANSWER", committedByTool: true, completionSummary: body });
  };
  return { fixture, inbox, reader, service, goal, workbench, complete };
}

function seedLayer(fixture: RuntimeFixture, goalId: string, workbenchId: string, disposition: "COMPLETED" | "CONTINUE" | "BLOCKED") {
  const now = fixture.clock.now().toISOString();
  fixture.database.transaction(db => {
    db.prepare("UPDATE joi_inbox_messages SET status='CONSUMED' WHERE input_id=?").run(goalId);
    db.prepare(`INSERT INTO joi_harness_maps (goal_input_id,workbench_id,status,created_at,updated_at)
      VALUES (?,?,'ACTIVE',?,?)`).run(goalId, workbenchId, now, now);
    db.prepare(`INSERT INTO joi_goal_result_sets (original_input_id,revision,synthesized_revision,updated_at)
      VALUES (?,1,1,?)`).run(goalId, now);
    db.prepare(`INSERT INTO joi_goal_outcomes (input_id,result_revision,completion_summary,completed_at,updated_at,disposition)
      VALUES (?,1,'# Synthetic delivery',?,?,?)`).run(goalId, now, now, disposition);
  });
}

describe("immutable goal result history (AC-37/48/57)", () => {
  it("retains repeated direct answers across restart and deduplicates completion delivery by turn", async () => {
    const { fixture, inbox, reader, goal, complete } = await setup();
    try {
      await complete("first-turn", "# First delivery");
      const first = await reader.listGoalResults(goal.inputId, {});
      expect(first?.items).toHaveLength(1);
      const original = first?.items[0];
      expect(original).toMatchObject({ completedAt: fixture.clock.now().toISOString(), status: "COMPLETED" });
      expect(original).not.toHaveProperty("body");
      expect(await reader.getGoalResult(goal.inputId, original?.resultId ?? "missing")).toMatchObject({ body: "# First delivery", status: "COMPLETED" });

      fixture.clock.advance(60_000);
      await inbox.retry(goal.inputId, { text: "Continue synthetic goal" });
      await complete("second-turn", "# Second delivery");
      await inbox.completeInput(goal.inputId, "second-turn", { outcome: "DIRECT_ANSWER", committedByTool: true, completionSummary: "# Second delivery" });
      const page = await reader.listGoalResults(goal.inputId, {});
      expect(page?.items).toHaveLength(2);
      expect(page?.items[1]?.resultId).toBe(original?.resultId);
      expect((await reader.load(fixture.clock.now())).goals.find(item => item.goalId === goal.inputId)?.resultId).toBe(page?.items[0]?.resultId);
      expect(await reader.getGoalResult(goal.inputId, original?.resultId ?? "missing")).toMatchObject({ body: "# First delivery" });

      const reopened = await openRuntimeDatabase({ databasePath: path.join(fixture.root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
      try {
        expect(await new SqliteJoiHomeFeedRepository(reopened).listGoalResults(goal.inputId, {})).toEqual(page);
      } finally { reopened.close(); }
    } finally { await fixture.close(); }
  });

  it("keeps identical bodies from different completions as distinct results", async () => {
    const { fixture, inbox, reader, goal, complete } = await setup();
    try {
      await complete("same-first", "Identical synthetic delivery");
      fixture.clock.advance(1000);
      await inbox.retry(goal.inputId, {});
      await complete("same-second", "Identical synthetic delivery");
      const page = await reader.listGoalResults(goal.inputId, {});
      expect(page?.items).toHaveLength(2);
      expect(new Set(page?.items.map(item => item.resultId)).size).toBe(2);
    } finally { await fixture.close(); }
  });

  it("does not let a delayed completion replay replace a newer direct answer", async () => {
    const { fixture, inbox, reader, goal, complete } = await setup();
    try {
      await complete("replayed-old-turn", "# First committed delivery");
      fixture.clock.advance(1000);
      await inbox.retry(goal.inputId, {});
      await complete("replay-new-turn", "# Newest committed delivery");
      const before = await reader.listGoalResults(goal.inputId, {});
      fixture.clock.advance(1000);
      await inbox.completeInput(goal.inputId, "replayed-old-turn", { outcome: "DIRECT_ANSWER", committedByTool: true, completionSummary: "# Altered delayed payload" });
      expect(await reader.listGoalResults(goal.inputId, {})).toEqual(before);
      const latest = (await reader.load(fixture.clock.now())).goals.find(item => item.goalId === goal.inputId);
      expect(latest).toMatchObject({ completionSummary: "# Newest committed delivery", resultId: before?.items[0]?.resultId });
      expect(await reader.getGoalResult(goal.inputId, before?.items[0]?.resultId ?? "missing")).toMatchObject({ body: "# Newest committed delivery" });
    } finally { await fixture.close(); }
  });

  it.each(["due", "run-now"] as const)("retains a direct deliverable from a real %s routine continuation after a synthesized delivery", async triggerKind => {
    const fixture = await createGoalEvidenceFixture([{}]);
    try {
      const reader = new SqliteJoiHomeFeedRepository(fixture.database);
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { outcome: "RESULT_SYNTHESIZED", completionSummary: "# Initial synthesis", committedByTool: true });
      const before = await reader.listGoalResults("goal", {});
      expect(before?.items).toHaveLength(1);
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction(db => {
        db.prepare("UPDATE workbench_workspace_bindings SET status='READY' WHERE workbench_id=?").run(fixture.workbenchId);
        db.prepare(`INSERT INTO joi_harness_maps (goal_input_id,workbench_id,status,reviewed_revision,created_at,updated_at)
          VALUES ('goal',?,'CLEARED',1,?,?)`).run(fixture.workbenchId, now, now);
      });
      const store = new SqliteAutomationStore(fixture.database);
      const automations = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      const routinePrompt = "Return a current synthetic direct deliverable.";
      const routine = await automations.create({ frequency: { kind: "interval", hours: 1 }, name: "History routine", prompt: routinePrompt,
        target: { kind: "GOAL_CONTINUATION", goalId: "goal" } });
      if (triggerKind === "due") {
        fixture.clock.advance(3_600_000);
        expect(await store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" })).toMatchObject([{ inputId: "goal", routineId: routine.routineId }]);
      } else await automations.runNow(routine.routineId, "history-run-now");
      const run = (await store.get(routine.routineId))?.runs[0];
      if (run === undefined) throw new Error("Synthetic routine execution must be queued");
      const requirements = new SqliteGoalRequirementsRepository(fixture.database);
      const contract = await requirements.ensure({ goalInputId: "goal", workbenchId: fixture.workbenchId, executionKey: run.runId, executionPrompt: routinePrompt });
      for (let sourceRevision = 1; sourceRevision <= contract.sourceRevision; sourceRevision++) {
        await requirements.readSource({ goalInputId: "goal", workbenchId: fixture.workbenchId, sourceRevision, offset: 0 });
      }
      const ready = await requirements.update({ goalInputId: "goal", workbenchId: fixture.workbenchId, expectedRevision: contract.revision,
        processedSourceRevision: contract.sourceRevision, retirements: [], upserts: [{ id: "routine-delivery", kind: "DELIVERABLE", mandatory: true, scope: "GLOBAL", text: routinePrompt,
          source: { sourceRevision: contract.sourceRevision, start: 0, end: routinePrompt.length } }] });
      await fixture.inbox.createTurn({ inputId: "goal", turnId: "routine-direct-turn", sessionId: "synthetic-routine", workbenchId: fixture.workbenchId,
        requirementsRevision: ready.revision, createdAt: fixture.clock.now().toISOString() });
      await fixture.inbox.completeInput("goal", "routine-direct-turn", { outcome: "DIRECT_ANSWER", committedByTool: true, completionSummary: "# Scheduled direct deliverable" });
      fixture.database.transaction(db => db.prepare("UPDATE joi_harness_maps SET status='CLEARED',cleared_at=? WHERE goal_input_id='goal'").run(fixture.clock.now().toISOString()));
      const page = await reader.listGoalResults("goal", {});
      expect(page?.items).toHaveLength(2);
      expect(page?.items[1]?.resultId).toBe(before?.items[0]?.resultId);
      expect(await reader.getGoalResult("goal", page?.items[0]?.resultId ?? "missing")).toMatchObject({ body: "# Scheduled direct deliverable" });
      expect((await reader.load(fixture.clock.now())).goals.find(item => item.goalId === "goal"))
        .toMatchObject({ status: "COMPLETED", completionSummary: "# Scheduled direct deliverable", resultId: page?.items[0]?.resultId });
    } finally { await fixture.close(); }
  });

  it.each(["COMPLETED", "CONTINUE", "BLOCKED"] as const)("archives only a final completed layer after the active map closes: %s", async disposition => {
    const { fixture, reader, goal, workbench } = await setup();
    try {
      seedLayer(fixture, goal.inputId, workbench.workbenchId, disposition);
      expect((await reader.listGoalResults(goal.inputId, {}))?.items).toEqual([]);
      fixture.database.transaction(db => db.prepare("UPDATE joi_harness_maps SET status='CLEARED',cleared_at=? WHERE goal_input_id=?")
        .run(fixture.clock.now().toISOString(), goal.inputId));
      const page = await reader.listGoalResults(goal.inputId, {});
      expect(page?.items).toHaveLength(disposition === "COMPLETED" ? 1 : 0);
      if (disposition === "COMPLETED") expect(await reader.getGoalResult(goal.inputId, page?.items[0]?.resultId ?? "missing")).toMatchObject({ body: "# Synthetic delivery", status: "COMPLETED" });
    } finally { await fixture.close(); }
  });

  it.each([0, 1])("saves an accepted result with gaps once the action, map and inbox transitions commit at epoch +%ims", async offset => {
    const { fixture, service, reader, goal, workbench } = await setup();
    try {
      seedLayer(fixture, goal.inputId, workbench.workbenchId, "CONTINUE");
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction(db => {
        const epoch = new Date(Date.parse(now) + offset).toISOString();
        db.prepare("UPDATE joi_inbox_messages SET reopened_at=? WHERE input_id=?").run(epoch, goal.inputId);
        db.prepare("UPDATE joi_goal_outcomes SET completed_at=? WHERE input_id=?").run(epoch, goal.inputId);
        db.prepare("UPDATE joi_inbox_messages SET status='CLARIFICATION_REQUIRED',clarification_reason_code='goal_continuation_required' WHERE input_id=?").run(goal.inputId);
        db.prepare(`INSERT INTO joi_user_action_requests
          (action_id,input_id,result_revision,kind,status,reason_code,prompt,created_at,updated_at)
          VALUES ('accept-history',?,1,'GOAL_CONTINUATION','OPEN','goal_continuation_required','Synthetic gaps',?,?)`).run(goal.inputId, now, now);
      });
      expect((await reader.listGoalResults(goal.inputId, {}))?.items).toEqual([]);
      await service.clarify({ inputId: goal.inputId, actionChoice: "ACCEPT_CURRENT" });
      const page = await reader.listGoalResults(goal.inputId, {});
      expect(page?.items).toHaveLength(1);
      expect(await reader.getGoalResult(goal.inputId, page?.items[0]?.resultId ?? "missing")).toMatchObject({ status: "COMPLETED_WITH_GAPS", body: "# Synthetic delivery" });
      expect((await reader.load(fixture.clock.now())).goals.find(item => item.goalId === goal.inputId)).toMatchObject({
        status: "COMPLETED_WITH_GAPS", resultId: page?.items[0]?.resultId,
      });
      expect(fixture.database.transaction(db => db.prepare("SELECT source_key FROM joi_goal_result_history WHERE goal_input_id=?").get(goal.inputId))?.source_key).toBe("action:accept-history");
      await expect(service.clarify({ inputId: goal.inputId, actionChoice: "ACCEPT_CURRENT" })).rejects.toThrow();
      expect((await reader.listGoalResults(goal.inputId, {}))?.items).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  it("pages newest first, scopes records to their original goal, preserves archives and hides dismissed goals", async () => {
    const { fixture, inbox, service, reader, goal, complete } = await setup();
    try {
      for (const index of [1, 2, 3]) {
        if (index > 1) { fixture.clock.advance(1000); await inbox.retry(goal.inputId, {}); }
        await complete(`page-turn-${String(index)}`, `# Synthetic ${String(index)}`);
      }
      const first = await reader.listGoalResults(goal.inputId, { limit: 2 });
      const last = await reader.listGoalResults(goal.inputId, { limit: 2, cursor: first?.nextCursor ?? "missing" });
      expect(first?.items).toHaveLength(2);
      expect(typeof first?.nextCursor).toBe("string");
      expect(last?.items).toHaveLength(1);
      expect(last?.nextCursor).toBeUndefined();
      const ids = [...(first?.items ?? []), ...(last?.items ?? [])].map(item => item.resultId);
      expect(new Set(ids).size).toBe(3);
      expect(await reader.getGoalResult(goal.inputId, first?.items[0]?.resultId ?? "missing")).toMatchObject({ body: "# Synthetic 3" });
      expect(await reader.getGoalResult(goal.inputId, last?.items[0]?.resultId ?? "missing")).toMatchObject({ body: "# Synthetic 1" });
      const other = await service.accept({ idempotencyKey: "foreign-goal", text: "Other synthetic goal" });
      expect(await reader.getGoalResult(other.inputId, ids[0] ?? "missing")).toBeNull();
      await expect(reader.listGoalResults(other.inputId, { cursor: ids[0] ?? "missing" })).rejects.toMatchObject({ code: "goal_result_page_invalid" });
      expect(await reader.getGoalResult(goal.inputId, "missing")).toBeNull();
      expect(await reader.listGoalResults("missing", {})).toBeNull();
      await inbox.archive(goal.inputId);
      expect((await reader.listGoalResults(goal.inputId, {}))?.items).toHaveLength(3);
      await inbox.dismiss(goal.inputId);
      expect(await reader.listGoalResults(goal.inputId, {})).toBeNull();
      expect(await reader.getGoalResult(goal.inputId, ids[0] ?? "missing")).toBeNull();
    } finally { await fixture.close(); }
  });

  it("projects only safe body text when reading a retained result", async () => {
    const { fixture, reader, goal, complete } = await setup();
    try {
      const body = "# Synthetic delivery\ntoken=synthetic-history-secret C:\\private\\hidden\\project\\docs\\result.md";
      await complete("private-history-turn", body);
      const page = await reader.listGoalResults(goal.inputId, {});
      const saved = await reader.getGoalResult(goal.inputId, page?.items[0]?.resultId ?? "missing");
      expect(saved?.body).toContain("token=[redacted]");
      expect(saved?.body).toContain("C:\\…\\project\\docs\\result.md");
      expect(saved?.body).not.toContain("synthetic-history-secret");
      expect(saved?.body).not.toContain("\\private\\hidden\\");
    } finally { await fixture.close(); }
  });

  it("does not invent a result for canceled, failed or uncommitted planning turns and validates page bounds", async () => {
    const { fixture, reader, inbox, goal, workbench } = await setup();
    try {
      await inbox.createTurn({ inputId: goal.inputId, turnId: "uncommitted", sessionId: "synthetic", workbenchId: workbench.workbenchId, createdAt: fixture.clock.now().toISOString() });
      await inbox.completeInput(goal.inputId, "uncommitted");
      expect((await reader.listGoalResults(goal.inputId, {}))?.items).toEqual([]);
      await inbox.retry(goal.inputId, {});
      await inbox.createTurn({ inputId: goal.inputId, turnId: "failed", sessionId: "synthetic", workbenchId: workbench.workbenchId, createdAt: fixture.clock.now().toISOString() });
      await inbox.failTurn(goal.inputId, "failed");
      expect((await reader.listGoalResults(goal.inputId, {}))?.items).toEqual([]);
      await inbox.cancel(goal.inputId);
      expect((await reader.listGoalResults(goal.inputId, {}))?.items).toEqual([]);
      for (const page of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: "invalid" }]) {
        await expect(reader.listGoalResults(goal.inputId, page)).rejects.toMatchObject({ code: "goal_result_page_invalid" });
      }
    } finally { await fixture.close(); }
  });

  it("keeps equal-time pagination stable when a newer completion is inserted between pages", async () => {
    const { fixture, inbox, reader, goal, complete } = await setup();
    try {
      await complete("equal-time-first", "Synthetic 1");
      fixture.database.transaction(db => {
        for (const index of [2, 3, 4]) db.prepare(`INSERT INTO joi_goal_result_history
          (result_id,goal_input_id,source_key,completed_at,status,body) VALUES (lower(hex(randomblob(16))),?,?,?,'COMPLETED',?)`)
          .run(goal.inputId, `equal-time-${String(index)}`, fixture.clock.now().toISOString(), `Synthetic ${String(index)}`);
      });
      const initial = await reader.listGoalResults(goal.inputId, {});
      const expected = initial?.items.map(item => item.resultId) ?? [];
      expect(expected).toHaveLength(4);
      expect(expected).toEqual([...expected].sort().reverse());
      const first = await reader.listGoalResults(goal.inputId, { limit: 2 });
      fixture.clock.advance(1000);
      await inbox.retry(goal.inputId, {});
      await complete("newer-between-pages", "New synthetic delivery");
      const second = await reader.listGoalResults(goal.inputId, { limit: 2, cursor: first?.nextCursor ?? "missing" });
      const all = [...(first?.items ?? []), ...(second?.items ?? [])];
      expect(all.map(item => item.resultId)).toEqual(expected);
      expect(second?.nextCursor).toBeUndefined();
    } finally { await fixture.close(); }
  });

  it("keeps separate finalized recovery synthesis runs at the same evidence and requirements revisions", async () => {
    const fixture = await createGoalEvidenceFixture([{}]);
    try {
      const reader = new SqliteJoiHomeFeedRepository(fixture.database);
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { outcome: "RESULT_SYNTHESIZED", completionSummary: "# First synthesis", committedByTool: true });
      const first = await reader.listGoalResults("goal", {});
      expect(first?.items).toHaveLength(1);
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { outcome: "RESULT_SYNTHESIZED", completionSummary: "# First synthesis", committedByTool: true });
      expect((await reader.listGoalResults("goal", {}))?.items).toHaveLength(1);
      fixture.clock.advance(60_000);
      const resumedInputId = fixture.database.transaction(db => {
        const epoch = fixture.clock.now().toISOString();
        db.prepare("UPDATE joi_inbox_messages SET reopened_at=? WHERE input_id='goal'").run(epoch);
        return enqueueGoalResultSynthesis(db, "goal", fixture.workbenchId, epoch, epoch);
      });
      if (resumedInputId === null) throw new Error("Synthetic recovery must enqueue synthesis");
      expect(resumedInputId).not.toBe(fixture.inputId);
      await fixture.inbox.createTurn({ inputId: resumedInputId, turnId: "second-synthesis", sessionId: "synthetic-second-session", workbenchId: fixture.workbenchId, createdAt: fixture.clock.now().toISOString() });
      await fixture.inbox.completeInput(resumedInputId, "second-synthesis", { outcome: "RESULT_SYNTHESIZED", completionSummary: "# Second synthesis", committedByTool: true });
      await fixture.inbox.completeInput(resumedInputId, "second-synthesis", { outcome: "RESULT_SYNTHESIZED", completionSummary: "# Second synthesis", committedByTool: true });
      const page = await reader.listGoalResults("goal", {});
      expect(page?.items).toHaveLength(2);
      expect(page?.items[1]?.resultId).toBe(first?.items[0]?.resultId);
      expect(await reader.getGoalResult("goal", page?.items[0]?.resultId ?? "missing")).toMatchObject({ body: "# Second synthesis" });
      expect(await reader.getGoalResult("goal", page?.items[1]?.resultId ?? "missing")).toMatchObject({ body: "# First synthesis" });
      expect(fixture.database.transaction(db => db.prepare("SELECT revision,synthesized_revision FROM joi_goal_result_sets WHERE original_input_id='goal'").get()))
        .toEqual({ revision: 1, synthesized_revision: 1 });
    } finally { await fixture.close(); }
  });

  it("backfills only verifiable current deliveries on upgrade and does not import overwritten internal outcome history", async () => {
    const fixture = await createRuntimeFixture();
    const oldMigrations = path.join(fixture.root, "old-migrations");
    await mkdir(oldMigrations);
    for (const name of await readdir("resources/migrations")) {
      if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 87) {
        await copyFile(path.join("resources/migrations", name), path.join(oldMigrations, name));
      }
    }
    const databasePath = path.join(fixture.root, "upgrade.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    try {
      const now = fixture.clock.now().toISOString();
      database.transaction(db => {
        db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,
          project_label,memory_namespace_id,status,created_at,updated_at)
          VALUES ('legacy-wb','Legacy','legacy-persona','Synthetic','Synthetic','History','legacy-memory','ACTIVE',?,?)`).run(now, now);
        const goals = db.prepare(`INSERT INTO joi_inbox_messages
          (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'Synthetic goal','CONSUMED','legacy-wb',?,?)`);
        const outcome = db.prepare(`INSERT INTO joi_goal_outcomes
          (input_id,result_revision,completion_summary,completed_at,updated_at,disposition) VALUES (?,2,?,?,?,?)`);
        for (const id of ["completed", "gaps", "active", "continue", "blocked", "stale", "direct"]) goals.run(id, id, now, now);
        for (const [id, disposition] of [["completed", "COMPLETED"], ["gaps", "ACCEPTED_WITH_GAPS"], ["active", "COMPLETED"], ["continue", "CONTINUE"], ["blocked", "BLOCKED"], ["stale", "COMPLETED"]]) {
          db.prepare(`INSERT INTO joi_goal_result_sets (original_input_id,revision,synthesized_revision,updated_at)
            VALUES (?,2,2,?)`).run(id ?? "", now);
          outcome.run(id ?? "", `# Current ${id ?? ""}`, now, now, disposition ?? "");
        }
        db.prepare(`INSERT INTO joi_harness_maps (goal_input_id,workbench_id,status,created_at,updated_at)
          VALUES ('active','legacy-wb','ACTIVE',?,?)`).run(now, now);
        db.prepare("UPDATE joi_inbox_messages SET reopened_at='2026-07-15T13:00:00.000Z' WHERE input_id='stale'").run();
        db.prepare(`INSERT INTO joi_goal_outcome_history
          (goal_input_id,result_revision,requirements_revision,disposition,completion_summary,completed_at)
          VALUES ('completed',1,0,'COMPLETED','# Overwritten internal layer',?)`).run(now);
        db.prepare(`INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
          VALUES ('legacy-direct','direct','legacy-wb','synthetic-session','COMPLETED',?,?)`).run(now, now);
        db.prepare(`INSERT INTO joi_turn_completions (input_id,turn_id,outcome_kind,completion_summary,completed_at,updated_at)
          VALUES ('direct','legacy-direct','DIRECT_ANSWER','# Legacy direct delivery',?,?)`).run(now, now);
      });
      database.close();
      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      const reader = new SqliteJoiHomeFeedRepository(database);
      for (const [goalId, status] of [["completed", "COMPLETED"], ["gaps", "COMPLETED_WITH_GAPS"], ["direct", "COMPLETED"]] as const) {
        const page = await reader.listGoalResults(goalId, {});
        expect(page?.items).toHaveLength(1);
        expect(page?.items[0]?.status).toBe(status);
        const saved = await reader.getGoalResult(goalId, page?.items[0]?.resultId ?? "missing");
        expect(saved?.body).toBe(goalId === "direct" ? "# Legacy direct delivery" : `# Current ${goalId}`);
      }
      for (const goalId of ["active", "continue", "blocked", "stale"]) {
        expect((await reader.listGoalResults(goalId, {}))?.items).toEqual([]);
      }
      const pageBefore = await reader.listGoalResults("completed", {});
      database.close();
      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      expect(await new SqliteJoiHomeFeedRepository(database).listGoalResults("completed", {})).toEqual(pageBefore);
    } finally { database.close(); await fixture.close(); }
  }, process.env.CI ? 60_000 : 5_000);
});
