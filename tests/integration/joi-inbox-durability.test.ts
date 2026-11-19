import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { JoiTaskComponent } from "../../src/main/application/actors/components/joi-task-component.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiTaskReader } from "../../src/main/infrastructure/persistence/sqlite-joi-task-reader.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

describe("joi-message-durable-before-reasoning", () => {
  it("reconciles interrupted turns from disk before the first scheduling tick", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-boot-turns-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const clock = new TestClock();
    const now = clock.now().toISOString();
    let database = await openRuntimeDatabaseFixture(databasePath);
    try {
      const inbox = new SqliteJoiInboxRepository(database, clock);
      database.transaction((db) => db.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES ('bench', 'Bench', 'persona', 'summary', 'scope', 'project', 'memory', 'ACTIVE', ?, ?)`).run(now, now));
      const inputs = ["safe", "unknown", "planned", "settled", "waiting", "canceled"];
      for (const inputId of inputs) {
        await inbox.create({ inputId, idempotencyKey: inputId, body: "Synthetic task", status: "PENDING", workbenchId: "bench", createdAt: now, updatedAt: now });
        await inbox.createTurn({ inputId, turnId: `turn:${inputId}`, sessionId: `session:${inputId}`, workbenchId: "bench", createdAt: now });
      }
      await inbox.recordTurnProgress("turn:unknown", { sideEffectStarted: true, formalOutputStarted: false });
      await inbox.requireClarification("waiting", "question_required", "Which phase?");
      await inbox.cancel("canceled");
      database.transaction((db) => {
        db.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES ('plan', 'turn:planned', '{}', '{}', ?)`).run(now);
        db.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work', 'bench', 'planned', 'Existing work', '{}', 'READ', 'COMPLETED', ?, ?)`).run(now, now);
        db.prepare(`INSERT INTO joi_turn_completions (input_id, turn_id, outcome_kind, completion_summary, completed_at, updated_at)
          VALUES ('settled', 'turn:settled', 'DIRECT_ANSWER', 'Existing answer', ?, ?)`).run(now, now);
      });
      database.close();

      clock.advance(2_000);
      database = await openRuntimeDatabaseFixture(databasePath);
      const restarted = new SqliteJoiInboxRepository(database, clock);
      await restarted.recoverOnBoot();
      await restarted.recoverOnBoot();
      const reader = new SqliteJoiTaskReader({ database, failTurn: vi.fn(), park: vi.fn() });
      expect((await reader.listPendingInputs()).map((input) => input.inputId)).toEqual(["safe"]);
      const handle = vi.fn().mockResolvedValue(undefined);
      await new JoiTaskComponent({ driver: { handle }, gate: { hasReadySource: () => Promise.resolve(true) }, inbox: reader })
        .update({ clock, now: clock.now(), tickId: 1 });
      expect(handle).toHaveBeenCalledExactlyOnceWith("safe", expect.any(AbortSignal));
      const records = new Map((await restarted.list()).map((record) => [record.inputId, record]));
      expect(records.get("unknown")).toMatchObject({ status: "CONSUMED", failureReasonCode: "joi_task_turn_interrupted" });
      expect(records.get("planned")).toMatchObject({ status: "CONSUMED" });
      expect(records.get("planned")?.failedAt).toBeUndefined();
      expect(records.get("settled")).toMatchObject({ status: "CONSUMED" });
      expect(records.get("waiting")).toMatchObject({ status: "CLARIFICATION_REQUIRED" });
      expect(records.get("canceled")).toMatchObject({ status: "CONSUMED", canceledAt: now });
      expect(database.transaction((db) => db.prepare("SELECT status FROM work_items WHERE work_id = 'work'").get())).toEqual({ status: "COMPLETED" });
      expect(database.transaction((db) => db.prepare("SELECT status FROM joi_turns WHERE turn_id = 'turn:settled'").get())).toEqual({ status: "COMPLETED" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("accepts idempotently and restores pending input metadata after restart without exposing the full body", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-inbox-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const secret = `only-stored-in-the-inbox-${"x".repeat(120)}`;
    let database = await openRuntimeDatabaseFixture(databasePath);
    try {
      let service = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository: new SqliteJoiInboxRepository(database) });
      await expect(service.accept({ idempotencyKey: "", text: "valid" })).rejects.toMatchObject({ code: "idempotency_key_invalid" });
      await expect(service.accept({ idempotencyKey: "valid", text: "   " })).rejects.toMatchObject({ code: "joi_message_invalid" });
      const accepted = await service.accept({ idempotencyKey: "input-key-1", text: secret });
      expect(accepted.textPreview).toBe(`${secret.slice(0, 80)}…`);
      expect(await service.accept({ idempotencyKey: "input-key-1", text: "must not replace original" })).toEqual(accepted);
      database.close();

      database = await openRuntimeDatabaseFixture(databasePath);
      service = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository: new SqliteJoiInboxRepository(database) });
      const pending = await service.list();
      expect(pending).toEqual([accepted]);
      expect(JSON.stringify(pending)).not.toContain(secret);
      expect(database.transaction((connection) => connection.prepare("SELECT body FROM joi_inbox_messages WHERE input_id = ?").get(accepted.inputId)))
        .toEqual({ body: secret });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
