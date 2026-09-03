import { describe, expect, it } from "vitest";

import { AutomationService } from "../../src/main/application/automation/automation-service";
import { SqliteAutomationStore } from "../../src/main/infrastructure/persistence/sqlite-automation-store";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("Routine persistence", () => {
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
      const inbox = fixture.database.transaction((connection) => {
        const row: unknown = connection.prepare("SELECT status, automation_routine_id, idempotency_key FROM joi_inbox_messages WHERE input_id = ?").get(trigger.inputId);
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
});
