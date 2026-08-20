/* eslint-disable @typescript-eslint/require-await */
import { DatabaseSync } from "node:sqlite";

import { ActorTree } from "../../src/main/application/actors/actor-tree";
import { WorkbenchActor } from "../../src/main/application/actors/workbench-actor";
import { JoiActor } from "../../src/main/application/actors/joi-actor";
import { JoiWorkbenchComponent } from "../../src/main/application/actors/components/joi-workbench-component";
import { JoiHarnessComponent } from "../../src/main/application/actors/components/joi-harness-component";
import { JoiTaskComponent } from "../../src/main/application/actors/components/joi-task-component";
import type { HarnessReviewDigest } from "../../src/main/application/ports/joi-harness";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository";
import { SqliteJoiTaskReader } from "../../src/main/infrastructure/persistence/sqlite-joi-task-reader";

const NOW = "2026-08-05T10:00:00.000Z";
const OLD = "2026-08-05T09:40:00.000Z";

function makeDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE joi_inbox_messages (
      input_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      workbench_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      canceled_at TEXT,
      dismissed_at TEXT,
      clarification_prompt TEXT,
      clarification_reason_code TEXT
    );
    CREATE TABLE joi_turns (
      turn_id TEXT PRIMARY KEY,
      input_id TEXT NOT NULL,
      status TEXT NOT NULL,
      formal_output_started INTEGER NOT NULL DEFAULT 0,
      side_effect_started INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

function insertInput(database: DatabaseSync, inputId: string, status: string, createdAt: string): void {
  database.prepare(`INSERT INTO joi_inbox_messages
    (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)`).run(inputId, `key_${inputId}`, "goal", status, createdAt, createdAt);
}

function insertTurn(database: DatabaseSync, turnId: string, inputId: string, status: string, updatedAt: string): void {
  database.prepare(`INSERT INTO joi_turns
    (turn_id, input_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(turnId, inputId, status, updatedAt, updatedAt);
}

describe("joi actor tick over persisted facts", () => {
  it("drives pending inputs and recovers orphaned turns from the DB", async () => {
    const database = makeDatabase();
    const wrapper = { transaction: <T,>(operation: (connection: DatabaseSync) => T): T => operation(database) };
    const inboxRepository = new SqliteJoiInboxRepository(wrapper);
    insertInput(database, "input_a", "PENDING", NOW);
    insertInput(database, "input_old", "ROUTED", OLD);
    insertTurn(database, "turn_old", "input_old", "RUNNING", OLD);

    const handled: string[] = [];
    const tree = new ActorTree({
      clock: { now: () => new Date(NOW) },
      roots: [new JoiActor({
        workbenchComponent: new JoiWorkbenchComponent({ workbenches: { listSummaries: async () => [] } }),
        components: [new JoiTaskComponent({
          driver: { handle: async (inputId) => { handled.push(inputId); } },
          gate: { hasReadySource: async () => true },
          inbox: new SqliteJoiTaskReader({
            database: wrapper,
            failTurn: (inputId, turnId) => inboxRepository.failTurn(inputId, turnId),
            park: async (inputId, failure) => { await inboxRepository.park(inputId, failure); },
          }),
        })],
        createChild: (workbenchId) => new WorkbenchActor({ workbenchId }),
      })],
    });

    await tree.tick(new Date(NOW));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toEqual(["input_a"]);
    const orphan = database.prepare("SELECT status FROM joi_turns WHERE turn_id = 'turn_old'").get() as { status: string };
    expect(orphan.status).toBe("FAILED");
    const repended = database.prepare("SELECT status FROM joi_inbox_messages WHERE input_id = 'input_old'").get() as { status: string };
    expect(repended.status).toBe("PENDING");

    await tree.tick(new Date(NOW));
    expect(handled).toEqual(["input_a", "input_old"]);
  });

  it("consumes a harness review input through the same serial slot it was posted into", async () => {
    const database = makeDatabase();
    const wrapper = { transaction: <T,>(operation: (connection: DatabaseSync) => T): T => operation(database) };
    const inboxRepository = new SqliteJoiInboxRepository(wrapper);
    insertInput(database, "input_goal", "PENDING", NOW);

    const digest: HarnessReviewDigest = {
      workbenchId: "workbench_h",
      completionSummary: "一层完成",
      decisionCount: 0,
      decisions: [],
      destination: "目的地",
      fogNotes: [],
      goalInputId: "input_goal",
      openPaths: [],
      resultRevision: 1,
    };
    let digestPending = true;
    const handled: string[] = [];
    const tree = new ActorTree({
      clock: { now: () => new Date(NOW) },
      roots: [new JoiActor({
        workbenchComponent: new JoiWorkbenchComponent({ workbenches: { listSummaries: async () => [] } }),
        components: [
          new JoiTaskComponent({
            driver: {
              handle: async (inputId) => {
                handled.push(inputId);
                // Mirror the coordinator: a handled input leaves PENDING.
                database.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(inputId);
              },
            },
            gate: { hasReadySource: async () => true },
            inbox: new SqliteJoiTaskReader({
              database: wrapper,
              failTurn: (inputId, turnId) => inboxRepository.failTurn(inputId, turnId),
              park: async (inputId, failure) => { await inboxRepository.park(inputId, failure); },
            }),
          }),
          new JoiHarnessComponent({
            reviewEnabled: true,
            scan: {
              listFeedbackTargets: async () => [],
              listGoalsWithoutMap: async () => [],
              listReviewDigests: async () => (digestPending ? [digest] : []),
              listTrivialMapCandidates: async () => [],
              loadGoalProjections: async () => [],
            },
            writer: {
              clearTrivialMap: async () => false,
              createMap: async () => false,
              enqueueReview: async (input) => {
                digestPending = false;
                const inputId = `joi_harness_review:goal:${input.digest.goalInputId}:r${String(input.digest.resultRevision)}`;
                database.prepare(`INSERT OR IGNORE INTO joi_inbox_messages
                  (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
                  VALUES (?, ?, 'review', 'PENDING', ?, ?, ?)`)
                  .run(inputId, `key_${inputId}`, input.digest.workbenchId, input.now, input.now);
                return inputId;
              },
              recordCompletionFeedback: async () => false,
            },
          }),
        ],
        createChild: (workbenchId) => new WorkbenchActor({ workbenchId }),
      })],
    });

    await tree.tick(new Date(NOW));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toEqual(["input_goal"]);
    // Second pass: the slot is free again and the posted review row is the only PENDING left.
    await tree.tick(new Date(NOW));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toEqual(["input_goal", "joi_harness_review:goal:input_goal:r1"]);
  });
});
