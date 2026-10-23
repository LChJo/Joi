import { DatabaseSync } from "node:sqlite";

import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { SqliteJoiTaskReader } from "../../src/main/infrastructure/persistence/sqlite-joi-task-reader";

describe("foreground runnable facts and evolution idle", () => {
  let connection: DatabaseSync;
  let store: SqliteEvolutionStore;
  let reader: SqliteJoiTaskReader;
  beforeEach(() => {
    connection = new DatabaseSync(":memory:");
    connection.exec(`
      CREATE TABLE workbenches (workbench_id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE joi_inbox_messages (input_id TEXT PRIMARY KEY, status TEXT, workbench_id TEXT,
        goal_input_id TEXT, canceled_at TEXT, dismissed_at TEXT, failed_at TEXT, created_at TEXT);
      CREATE TABLE joi_goal_execution_gates (goal_input_id TEXT, status TEXT, resume_input_id TEXT);
      CREATE TABLE joi_user_action_requests (action_id TEXT, input_id TEXT, work_id TEXT, status TEXT);
      CREATE TABLE joi_turns (turn_id TEXT, input_id TEXT, status TEXT);
      CREATE TABLE work_items (work_id TEXT, input_id TEXT, workbench_id TEXT, status TEXT);
      INSERT INTO workbenches VALUES ('bench','ACTIVE');
      INSERT INTO joi_inbox_messages VALUES ('goal','CONSUMED','bench',NULL,NULL,NULL,NULL,'0');
      INSERT INTO joi_inbox_messages VALUES ('child','PENDING','bench','goal',NULL,NULL,NULL,'1');
    `);
    const database = { transaction: <T>(operation: (db: DatabaseSync) => T) => operation(connection) };
    store = new SqliteEvolutionStore(database);
    reader = new SqliteJoiTaskReader({ database, failTurn: () => Promise.resolve(), park: () => Promise.resolve(),
      background: { pending: () => [{ inputId: "evolution:test", createdAt: "2" }], canceled: () => false } });
  });
  afterEach(() => connection.close());

  it.each(["canceled_at", "dismissed_at", "failed_at"])("excludes children of a goal with %s from both scheduling decisions", async (column) => {
    connection.exec(`UPDATE joi_inbox_messages SET ${column} = 'now' WHERE input_id = 'goal'`);
    expect(await reader.listPendingInputs()).toEqual([{ inputId: "evolution:test", createdAt: "2" }]);
    expect(store.idle()).toBe(true);
  });
  it("gives a valid foreground child priority over background work", async () => {
    expect(await reader.listPendingInputs()).toEqual([{ inputId: "child", createdAt: "1", requiresModelSource: true }]);
    expect(store.idle()).toBe(false);
  });
  it("excludes archived workbench inputs and queued Work", async () => {
    connection.exec("INSERT INTO work_items VALUES ('work','goal','bench','READY'); UPDATE workbenches SET status = 'ARCHIVED'");
    expect(await reader.listPendingInputs()).toEqual([{ inputId: "evolution:test", createdAt: "2" }]);
    expect(store.idle()).toBe(true);
  });
  it("excludes a canceled input even when its goal remains open", async () => {
    connection.exec("UPDATE joi_inbox_messages SET canceled_at = 'now' WHERE input_id = 'child'");
    expect(await reader.listPendingInputs()).toEqual([{ inputId: "evolution:test", createdAt: "2" }]);
    expect(store.idle()).toBe(true);
  });
  it.each(["WAITING_INPUT", "REVIEWING"])("treats %s gates consistently and leaves the designated review runnable", async (status) => {
    connection.prepare("INSERT INTO joi_goal_execution_gates VALUES ('goal',?,'review')").run(status);
    expect(await reader.listPendingInputs()).toEqual([{ inputId: "evolution:test", createdAt: "2" }]);
    expect(store.idle()).toBe(true);
    if (status === "REVIEWING") {
      connection.exec("UPDATE joi_goal_execution_gates SET resume_input_id = 'child'");
      expect((await reader.listPendingInputs())[0]?.inputId).toBe("child");
      expect(store.idle()).toBe(false);
    }
  });
  it("blocks a reviewing gate without a designated resume input", async () => {
    connection.exec("INSERT INTO joi_goal_execution_gates VALUES ('goal','REVIEWING',NULL)");
    expect(await reader.listPendingInputs()).toEqual([{ inputId: "evolution:test", createdAt: "2" }]);
    expect(store.idle()).toBe(true);
  });
  it("allows unassigned foreground inputs to run", async () => {
    connection.exec("UPDATE joi_inbox_messages SET workbench_id = NULL WHERE input_id = 'child'");
    expect((await reader.listPendingInputs())[0]?.inputId).toBe("child");
    expect(store.idle()).toBe(false);
  });
  it.each(["PLANNED", "READY", "RUNNING", "WAITING"])("keeps %s Work ahead of evolution", (status) => {
    connection.exec("UPDATE joi_inbox_messages SET status = 'CONSUMED'");
    connection.prepare("INSERT INTO work_items VALUES ('work','goal','bench',?)").run(status);
    expect(store.idle()).toBe(false);
  });
  it.each(["PLANNED", "READY"])("lets %s Work behind a user-input gate yield to evolution", (status) => {
    connection.exec("UPDATE joi_inbox_messages SET status = 'CONSUMED'; INSERT INTO joi_goal_execution_gates VALUES ('goal','WAITING_INPUT',NULL)");
    connection.prepare("INSERT INTO work_items VALUES ('work','goal','bench',?)").run(status);
    expect(store.idle()).toBe(true);
    connection.exec("UPDATE joi_goal_execution_gates SET status = 'OPEN'");
    expect(store.idle()).toBe(false);
  });
  it("lets explicit user waits yield, but preserves unknown waits and resolved actions", () => {
    connection.exec(`UPDATE joi_inbox_messages SET status = 'CONSUMED';
      INSERT INTO work_items VALUES ('work','goal','bench','WAITING');
      INSERT INTO joi_user_action_requests VALUES ('action','goal','other-work','OPEN');`);
    expect(store.idle()).toBe(false);
    connection.exec("UPDATE joi_user_action_requests SET work_id = 'work'");
    expect(store.idle()).toBe(true);
    connection.exec("UPDATE joi_user_action_requests SET status = 'RESOLVED'");
    expect(store.idle()).toBe(false);
  });
  it("keeps an in-flight turn ahead of evolution even when its input is canceled", () => {
    connection.exec(`UPDATE joi_inbox_messages SET canceled_at = 'now';
      INSERT INTO joi_turns VALUES ('turn','child','RUNNING')`);
    expect(store.idle()).toBe(false);
  });
  it("does not ignore running Work when its goal is canceled", () => {
    connection.exec(`UPDATE joi_inbox_messages SET canceled_at = 'now';
      INSERT INTO work_items VALUES ('work','goal','bench','RUNNING')`);
    expect(store.idle()).toBe(false);
  });
});
