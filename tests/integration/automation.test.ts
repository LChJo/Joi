import { describe, expect, it } from "vitest";

import { AutomationService } from "../../src/main/application/automation/automation-service";
import { SqliteAutomationStore } from "../../src/main/infrastructure/persistence/sqlite-automation-store";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository";
import { createRuntimeFixture } from "../support/runtime-fixture";

function insertGoal(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>, input: {
  canceled?: boolean;
  failed?: boolean;
  inputId: string;
  status: "CONSUMED" | "PENDING";
  workbenchId: string;
}) {
  const now = fixture.clock.now().toISOString();
  fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_inbox_messages
    (input_id, idempotency_key, body, status, workbench_id, canceled_at, failed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.inputId, `key:${input.inputId}`, `Goal ${input.inputId}`, input.status, input.workbenchId,
    input.canceled ? now : null, input.failed ? now : null, now, now,
  ));
}

describe("Routine persistence", () => {
  // AC-63: recovery checks must not manufacture new occurrence/run facts.
  it.each(["active", "canceled", "workspace"] as const)("does not write on unchanged %s continuation ticks, but merges new occurrences", async (state) => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Tick WB", personaSummary: "summary", projectLabel: "project", scopeSummary: "scope" });
      insertGoal(fixture, { canceled: state === "canceled", inputId: "goal-ticks", status: state === "active" ? "PENDING" : "CONSUMED", workbenchId: workbench.workbenchId });
      const store = new SqliteAutomationStore(fixture.database);
      const service = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      const routine = await service.create({ frequency: { kind: "interval", hours: 1 }, name: "Ticks", prompt: "Continue", target: { goalId: "goal-ticks", kind: "GOAL_CONTINUATION" } } as never);
      const tick = () => store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" });
      const changes = () => fixture.database.transaction((connection) => connection.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
      fixture.clock.advance(60 * 60 * 1_000);
      expect(await tick()).toEqual([]);
      const blocked = await store.get(routine.routineId);
      const before = changes();
      for (let i = 0; i < 3; i += 1) {
        fixture.clock.advance(1_000);
        expect(await tick()).toEqual([]);
        expect(await store.get(routine.routineId)).toEqual(blocked);
      }
      expect(changes()).toBe(before);

      fixture.clock.advance(60 * 60 * 1_000 - 3_000);
      expect(await tick()).toEqual([]);
      const merged = await store.get(routine.routineId);
      expect(merged?.runs).toHaveLength(1);
      expect(merged?.runs[0]).toMatchObject({ runId: blocked?.runs[0]?.runId, mergeCount: 1, triggeredAt: fixture.clock.now().toISOString(), occurrenceAt: fixture.clock.now().toISOString() });
      expect(merged?.nextRunAt).not.toBe(blocked?.nextRunAt);
      const afterMerge = changes();
      fixture.clock.advance(1_000);
      expect(await tick()).toEqual([]);
      expect(changes()).toBe(afterMerge);
    } finally {
      await fixture.close();
    }
  });

  it("records cancellation once without changing the blocked trigger time", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Cancel WB", personaSummary: "summary", projectLabel: "project", scopeSummary: "scope" });
      insertGoal(fixture, { inputId: "goal-cancel-ticks", status: "PENDING", workbenchId: workbench.workbenchId });
      const store = new SqliteAutomationStore(fixture.database);
      const service = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      const routine = await service.create({ frequency: { kind: "interval", hours: 1 }, name: "Cancel", prompt: "Continue", target: { goalId: "goal-cancel-ticks", kind: "GOAL_CONTINUATION" } } as never);
      const tick = () => store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" });
      fixture.clock.advance(60 * 60 * 1_000);
      await tick();
      const blocked = (await store.get(routine.routineId))?.runs[0];
      fixture.clock.advance(1_000);
      fixture.database.transaction((connection) => connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED', canceled_at = ? WHERE input_id = 'goal-cancel-ticks'").run(fixture.clock.now().toISOString()));
      expect(await tick()).toEqual([]);
      expect((await store.get(routine.routineId))?.runs[0]).toEqual({ ...blocked, reasonCode: "goal_canceled" });
      const before = fixture.database.transaction((connection) => connection.prepare("SELECT total_changes() AS count").get());
      for (let i = 0; i < 3; i += 1) {
        fixture.clock.advance(1_000);
        expect(await tick()).toEqual([]);
      }
      expect(fixture.database.transaction((connection) => connection.prepare("SELECT total_changes() AS count").get())).toEqual(before);
    } finally {
      await fixture.close();
    }
  });

  it.each(["interval", "once"] as const)("preserves the %s trigger fact through a changed block reason and delayed recovery", async (kind) => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Recover WB", personaSummary: "summary", projectLabel: "project", scopeSummary: "scope" });
      insertGoal(fixture, { inputId: "goal-recover-ticks", status: "PENDING", workbenchId: workbench.workbenchId });
      const store = new SqliteAutomationStore(fixture.database);
      const service = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      const frequency = kind === "interval" ? { kind, hours: 1 } : { kind, at: new Date(fixture.clock.now().getTime() + 60 * 60 * 1_000).toISOString() };
      const routine = await service.create({ frequency, name: "Recover", prompt: "Continue", target: { goalId: "goal-recover-ticks", kind: "GOAL_CONTINUATION" } } as never);
      const tick = () => store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" });
      fixture.clock.advance(60 * 60 * 1_000);
      await tick();
      const blocked = await store.get(routine.routineId);
      const schedulingFact = () => fixture.database.transaction((connection) => connection.prepare("SELECT pending_trigger_at, next_run_at, last_run_at, updated_at FROM joi_automations WHERE routine_id = ?").get(routine.routineId));
      const scheduleBefore = schedulingFact();
      fixture.clock.advance(1_000);
      fixture.database.transaction((connection) => connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = 'goal-recover-ticks'").run());
      expect(await tick()).toEqual([]);
      expect((await store.get(routine.routineId))?.runs[0]).toEqual({ ...blocked?.runs[0], reasonCode: "workbench_unavailable" });
      fixture.clock.advance(1_000);
      fixture.database.transaction((connection) => connection.prepare("UPDATE workbench_workspace_bindings SET status = 'READY' WHERE workbench_id = ?").run(workbench.workbenchId));
      expect(await tick()).toEqual([{ inputId: "goal-recover-ticks", routineId: routine.routineId, runId: blocked?.runs[0]?.runId }]);
      const recovered = await store.get(routine.routineId);
      expect(recovered?.runs[0]).toMatchObject({ status: "PENDING", mergeCount: 0, triggeredAt: blocked?.runs[0]?.triggeredAt, occurrenceAt: blocked?.runs[0]?.occurrenceAt, queuedAt: fixture.clock.now().toISOString() });
      expect(recovered?.nextRunAt).toBe(blocked?.nextRunAt);
      expect(schedulingFact()).toEqual(scheduleBefore);
      const before = fixture.database.transaction((connection) => connection.prepare("SELECT total_changes() AS count").get());
      fixture.clock.advance(1_000);
      expect(await tick()).toEqual([]);
      expect(fixture.database.transaction((connection) => connection.prepare("SELECT total_changes() AS count").get())).toEqual(before);
    } finally {
      await fixture.close();
    }
  });

  it("atomically claims a due occurrence into the ordinary Joi inbox", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Routine WB", personaSummary: "summary", projectLabel: "project", scopeSummary: "scope" });
      fixture.database.transaction((connection) => connection.prepare("UPDATE workbench_workspace_bindings SET status = 'READY' WHERE workbench_id = ?").run(workbench.workbenchId));
      const store = new SqliteAutomationStore(fixture.database);
      const service = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      const created = await service.create({
        frequency: { kind: "interval", hours: 1 }, name: "Hourly", prompt: "Check open work", workbenchId: workbench.workbenchId,
      });
      fixture.clock.advance(60 * 60 * 1_000);
      const triggers = await store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" });
      expect(triggers).toHaveLength(1);
      const trigger = triggers[0];
      if (trigger === undefined) throw new Error("automation_trigger_missing");
      if (trigger.inputId === undefined) throw new Error("automation_input_missing");
      const triggerInputId = trigger.inputId;
      const inbox = fixture.database.transaction((connection) => {
        const row: unknown = connection.prepare("SELECT status, automation_routine_id, idempotency_key FROM joi_inbox_messages WHERE input_id = ?").get(triggerInputId);
        return row as Record<string, unknown>;
      });
      expect(inbox.automation_routine_id).toBe(created.routineId);
      expect(inbox.status).toBe("PENDING");
      expect(typeof inbox.idempotency_key).toBe("string");
      if (typeof inbox.idempotency_key === "string") expect(inbox.idempotency_key).toContain(`automation:${created.routineId}:`);
      const second = await store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" });
      expect(second).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("keeps one blocked fact while a Workbench is provisioning and recovers it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Blocked WB", personaSummary: "summary", projectLabel: "project", scopeSummary: "scope" });
      const store = new SqliteAutomationStore(fixture.database);
      const service = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      const routine = await service.create({ frequency: { kind: "interval", hours: 1 }, name: "Blocked", prompt: "Check", workbenchId: workbench.workbenchId });
      fixture.clock.advance(60 * 60 * 1_000);
      expect(await store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" })).toHaveLength(0);
      const blocked = await store.get(routine.routineId);
      expect(blocked?.runs[0]?.status).toBe("BLOCKED");
      fixture.database.transaction((connection) => connection.prepare("UPDATE workbench_workspace_bindings SET status = 'READY' WHERE workbench_id = ?").run(workbench.workbenchId));
      const recovered = await store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" });
      expect(recovered).toHaveLength(1);
      expect((await store.get(routine.routineId))?.runs[0]?.status).toBe("PENDING");
    } finally {
      await fixture.close();
    }
  });

  it("replays update and delete mutations by idempotency key", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Mutation WB", personaSummary: "summary", projectLabel: "project", scopeSummary: "scope" });
      fixture.database.transaction((connection) => connection.prepare("UPDATE workbench_workspace_bindings SET status = 'READY' WHERE workbench_id = ?").run(workbench.workbenchId));
      const store = new SqliteAutomationStore(fixture.database);
      const service = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      const routine = await service.create({ frequency: { kind: "interval", hours: 1 }, name: "Original", prompt: "Check", workbenchId: workbench.workbenchId }, "create-key");

      const firstUpdate = await service.update(routine.routineId, { name: "Updated" }, "update-key");
      const replayedUpdate = await service.update(routine.routineId, { name: "Different retry payload" }, "update-key");
      expect(firstUpdate.name).toBe("Updated");
      expect(replayedUpdate.name).toBe("Updated");
      expect(fixture.database.transaction((connection) => connection.prepare("SELECT COUNT(*) AS count FROM joi_automation_mutations WHERE idempotency_key = ?").get("update-key") as { count: number }).count).toBe(1);

      await service.runNow(routine.routineId, "run-key");
      await service.delete(routine.routineId, "delete-key");
      await expect(service.delete(routine.routineId, "delete-key")).resolves.toBeUndefined();
      await expect(service.runNow(routine.routineId, "run-key")).resolves.toMatchObject({ lifecycle: "DELETED" });
      await expect(service.update(routine.routineId, { name: "different retry payload" }, "update-key")).resolves.toMatchObject({ lifecycle: "DELETED", name: "Updated" });
      expect((await store.get(routine.routineId))?.routineId).toBeUndefined();
      expect((await store.get(routine.routineId, true))?.enabled).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("continues the same completed or failed goal instead of creating a second card", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Continuation WB", personaSummary: "summary", projectLabel: "project", scopeSummary: "scope" });
      fixture.database.transaction((connection) => connection.prepare("UPDATE workbench_workspace_bindings SET status = 'READY' WHERE workbench_id = ?").run(workbench.workbenchId));
      insertGoal(fixture, { inputId: "goal-completed", status: "CONSUMED", workbenchId: workbench.workbenchId });
      insertGoal(fixture, { failed: true, inputId: "goal-failed", status: "CONSUMED", workbenchId: workbench.workbenchId });
      const completedAt = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-completed', 'goal-completed', ?, 'session-completed', 'COMPLETED', ?, ?)`).run(
          workbench.workbenchId, completedAt, completedAt,
        );
        connection.prepare(`INSERT INTO joi_turn_completions
          (input_id, turn_id, outcome_kind, completion_summary, completed_at, updated_at)
          VALUES ('goal-completed', 'turn-completed', 'DIRECT_ANSWER', 'previous completion', ?, ?)`).run(completedAt, completedAt);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-failed', 'goal-failed', ?, 'session-failed', 'FAILED', ?, ?)`).run(
          workbench.workbenchId, completedAt, completedAt,
        );
      });
      const store = new SqliteAutomationStore(fixture.database);
      const service = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      const completedRoutine = await service.create({
        frequency: { kind: "interval", hours: 1 }, name: "Continue completed", prompt: "继续核对下一批结果",
        target: { goalId: "goal-completed", kind: "GOAL_CONTINUATION" },
      } as never);
      const failedRoutine = await service.create({
        frequency: { kind: "interval", hours: 1 }, name: "Retry failed", prompt: "修复后继续",
        target: { goalId: "goal-failed", kind: "GOAL_CONTINUATION" },
      } as never);

      expect(completedRoutine).toMatchObject({ target: { goalId: "goal-completed", kind: "GOAL_CONTINUATION" }, workbenchId: workbench.workbenchId });
      fixture.clock.advance(60 * 60 * 1_000);
      const triggers = await store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" });
      expect(triggers.map((trigger) => trigger.inputId).sort()).toEqual(["goal-completed", "goal-failed"]);
      const goals = fixture.database.transaction((connection) => connection.prepare(`SELECT input_id, status, automation_routine_id, failed_at
        FROM joi_inbox_messages WHERE input_id IN ('goal-completed', 'goal-failed') ORDER BY input_id`).all() as Record<string, unknown>[]);
      expect(goals).toEqual([
        expect.objectContaining({ automation_routine_id: completedRoutine.routineId, failed_at: null, input_id: "goal-completed", status: "PENDING" }),
        expect.objectContaining({ automation_routine_id: failedRoutine.routineId, failed_at: null, input_id: "goal-failed", status: "PENDING" }),
      ]);
      expect(fixture.database.transaction((connection) => connection.prepare("SELECT COUNT(*) AS count FROM joi_inbox_messages").get() as { count: number }).count).toBe(2);
      expect((await store.get(completedRoutine.routineId))?.runs[0]?.status).toBe("PENDING");
      expect((await store.get(failedRoutine.routineId))?.runs[0]?.status).toBe("PENDING");
    } finally {
      await fixture.close();
    }
  });

  it("waits for an unfinished goal, merges missed occurrences and never resumes a canceled goal", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Waiting WB", personaSummary: "summary", projectLabel: "project", scopeSummary: "scope" });
      fixture.database.transaction((connection) => connection.prepare("UPDATE workbench_workspace_bindings SET status = 'READY' WHERE workbench_id = ?").run(workbench.workbenchId));
      insertGoal(fixture, { inputId: "goal-running", status: "PENDING", workbenchId: workbench.workbenchId });
      insertGoal(fixture, { canceled: true, inputId: "goal-canceled", status: "CONSUMED", workbenchId: workbench.workbenchId });
      const store = new SqliteAutomationStore(fixture.database);
      const service = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      const waiting = await service.create({ frequency: { kind: "interval", hours: 1 }, name: "Wait", prompt: "继续", target: { goalId: "goal-running", kind: "GOAL_CONTINUATION" } } as never);
      await service.create({ frequency: { kind: "interval", hours: 1 }, name: "Canceled", prompt: "不要自动恢复取消", target: { goalId: "goal-canceled", kind: "GOAL_CONTINUATION" } } as never);

      fixture.clock.advance(3 * 60 * 60 * 1_000);
      expect(await store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" })).toEqual([]);
      const blocked = await store.get(waiting.routineId);
      expect(blocked?.runs[0]).toMatchObject({ mergeCount: 2, reasonCode: "goal_not_finished", status: "BLOCKED" });
      fixture.database.transaction((connection) => connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = 'goal-running'").run());
      expect(await store.claimDue({ now: fixture.clock.now().toISOString(), timezone: "UTC" })).toEqual([
        expect.objectContaining({ inputId: "goal-running", routineId: waiting.routineId }),
      ]);
      const canceled = fixture.database.transaction((connection) => connection.prepare("SELECT status, canceled_at FROM joi_inbox_messages WHERE input_id = 'goal-canceled'").get() as Record<string, unknown>);
      expect(canceled.status).toBe("CONSUMED");
      expect(typeof canceled.canceled_at).toBe("string");
    } finally {
      await fixture.close();
    }
  });

  it("soft-deletes every continuation routine when its completed goal card is removed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Removal WB", personaSummary: "summary", projectLabel: "project", scopeSummary: "scope" });
      fixture.database.transaction((connection) => connection.prepare("UPDATE workbench_workspace_bindings SET status = 'READY' WHERE workbench_id = ?").run(workbench.workbenchId));
      insertGoal(fixture, { inputId: "goal-remove", status: "CONSUMED", workbenchId: workbench.workbenchId });
      const store = new SqliteAutomationStore(fixture.database);
      const service = new AutomationService({ clock: fixture.clock, ids: fixture.ids, store, workbenches: fixture.workbenches });
      await service.create({ frequency: { kind: "interval", hours: 1 }, name: "One", prompt: "一", target: { goalId: "goal-remove", kind: "GOAL_CONTINUATION" } } as never);
      await service.create({ frequency: { kind: "interval", hours: 2 }, name: "Two", prompt: "二", target: { goalId: "goal-remove", kind: "GOAL_CONTINUATION" } } as never);

      expect(await new SqliteJoiInboxRepository(fixture.database, fixture.clock).dismiss("goal-remove")).not.toBeNull();
      expect(await store.list()).toEqual([]);
      expect((await store.list(true)).filter((routine) => routine.deletedAt !== undefined)).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });
});
