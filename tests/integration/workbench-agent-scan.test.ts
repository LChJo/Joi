import { DatabaseSync } from "node:sqlite";

import { SqliteWorkbenchAgentScan } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-scan";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository";

const NOW = "2026-08-05T10:00:00.000Z";

function makeDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE work_items (work_id TEXT PRIMARY KEY, workbench_id TEXT, input_id TEXT, title TEXT, status TEXT);
    CREATE TABLE work_results (result_id TEXT PRIMARY KEY, run_id TEXT, work_id TEXT, workbench_id TEXT,
      status TEXT, summary TEXT, is_authoritative INTEGER, is_late INTEGER, instance_id TEXT, created_at TEXT);
    CREATE TABLE partner_result_events (event_id TEXT PRIMARY KEY, run_id TEXT, status TEXT);
    CREATE TABLE partner_runs (run_id TEXT PRIMARY KEY, workbench_id TEXT, status TEXT, kind TEXT,
      action_id TEXT, partner_revision_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE partner_revisions (partner_revision_id TEXT PRIMARY KEY, partner_id TEXT);
    CREATE TABLE partners (partner_id TEXT PRIMARY KEY);
    CREATE TABLE dispatch_attempts (dispatch_attempt_id TEXT PRIMARY KEY, work_id TEXT,
      partner_revision_id TEXT, status TEXT);
    CREATE TABLE partner_instances (instance_id TEXT PRIMARY KEY, workbench_id TEXT, partner_id TEXT, status TEXT);
    CREATE TABLE workbench_agent_sessions (agent_id TEXT PRIMARY KEY, workbench_id TEXT, partner_id TEXT, dismissed_at TEXT);
    CREATE TABLE joi_inbox_messages (input_id TEXT PRIMARY KEY, idempotency_key TEXT, body TEXT, status TEXT,
      workbench_id TEXT, created_at TEXT, updated_at TEXT, canceled_at TEXT, dismissed_at TEXT,
      clarification_prompt TEXT, clarification_reason_code TEXT, goal_input_id TEXT, result_revision INTEGER);
    CREATE TABLE joi_goal_result_sets (original_input_id TEXT PRIMARY KEY, revision INTEGER,
      synthesized_revision INTEGER, synthetic_input_id TEXT, updated_at TEXT);
    CREATE TABLE joi_goal_result_members (original_input_id TEXT, event_id TEXT, revision INTEGER,
      PRIMARY KEY (original_input_id, event_id));
    CREATE TABLE workbench_change_requests (request_id TEXT PRIMARY KEY, kind TEXT, source_workbench_id TEXT,
      target_workbench_id TEXT, reason TEXT, turn_id TEXT, status TEXT, created_at TEXT, decided_at TEXT);
    CREATE TABLE invocations (invocation_id TEXT PRIMARY KEY, message_id TEXT);
  `);
  return database;
}

function seed(database: DatabaseSync): void {
  database.prepare("INSERT INTO partners VALUES ('partner_1'), ('partner_2')").run();
  database.prepare("INSERT INTO partner_revisions VALUES ('rev_1', 'partner_1'), ('rev_2', 'partner_2')").run();
  database.prepare("INSERT INTO work_items VALUES ('work_1', 'workbench_1', 'input_goal', 'create file', 'COMPLETED')").run();
  database.prepare("INSERT INTO partner_runs VALUES ('run_1', 'workbench_1', 'COMPLETED', 'LOCAL_PI', 'action_1', 'rev_1', ?, ?)").run(NOW, NOW);
  database.prepare(`INSERT INTO work_results VALUES
    ('work_result:run_1:COMPLETED', 'run_1', 'work_1', 'workbench_1', 'COMPLETED', 'done', 1, 0, 'inst_1', ?)`).run(NOW);
  database.prepare("INSERT INTO partner_result_events VALUES ('partner_result:run_1:COMPLETED', 'run_1', 'COMPLETED')").run();
  database.prepare("INSERT INTO dispatch_attempts VALUES ('attempt_1', 'work_1', 'rev_2', 'PENDING')").run();
  database.prepare("INSERT INTO partner_instances VALUES ('inst_1', 'workbench_1', 'partner_1', 'IDLE')").run();
  database.prepare("INSERT INTO workbench_agent_sessions VALUES ('agent_1', 'workbench_1', 'partner_1', NULL)").run();
  database.prepare(`INSERT INTO joi_inbox_messages
    (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at, clarification_prompt, clarification_reason_code)
    VALUES ('input_c', 'key_c', 'question', 'CLARIFICATION_REQUIRED', 'workbench_1', ?, ?, 'which one?', 'question_required')`).run(NOW, NOW);
  database.prepare(`INSERT INTO workbench_change_requests VALUES
    ('req_1', 'ARCHIVE', 'workbench_1', NULL, 'stale', 'turn_1', 'PENDING', ?, NULL)`).run(NOW);
}

describe("SqliteWorkbenchAgentScan traversal sources", () => {
  it("discovers unsynthesized authoritative results and stops after enqueue", async () => {
    const database = makeDatabase();
    seed(database);
    const wrapper = { transaction: <T,>(operation: (connection: DatabaseSync) => T): T => operation(database) };
    const scan = new SqliteWorkbenchAgentScan(wrapper);

    const results = await scan.listUnsynthesizedResults("workbench_1");
    expect(results).toEqual([{
      workbenchId: "workbench_1",
      eventId: "partner_result:run_1:COMPLETED",
      partnerId: "partner_1",
      resultId: "work_result:run_1:COMPLETED",
      sessionDataSource: "partner_instance_messages:inst_1",
      status: "COMPLETED",
      summary: "done",
      title: "create file",
      workId: "work_1",
    }]);

    const inbox = new SqliteJoiInboxRepository(wrapper);
    const inputId = await inbox.enqueuePartnerResult({
      workbenchId: "workbench_1",
      eventId: results[0]?.eventId ?? "",
      resultId: results[0]?.resultId ?? "",
      status: "COMPLETED",
      summary: "done",
      workId: "work_1",
    });
    expect(inputId).toBe("joi_result_input:goal:input_goal");

    await expect(scan.listUnsynthesizedResults("workbench_1")).resolves.toEqual([]);
  });

  it("unions partner keys from attempts, instances and sessions", async () => {
    const database = makeDatabase();
    seed(database);
    const scan = new SqliteWorkbenchAgentScan({ transaction: (op) => op(database) });
    await expect(scan.listPartnerKeys("workbench_1")).resolves.toEqual([
      { partnerId: "partner_1" },
      { partnerId: "partner_2" },
    ]);
  });

  it("aggregates clarification and workbench change confirmations plus waiting runs", async () => {
    const database = makeDatabase();
    seed(database);
    database.prepare("INSERT INTO partner_runs VALUES ('run_2', 'workbench_1', 'WAITING_INPUT', 'LOCAL_PI', 'action_2', 'rev_1', ?, ?)").run(NOW, NOW);
    const scan = new SqliteWorkbenchAgentScan({ transaction: (op) => op(database) });
    await expect(scan.listPendingConfirmations("workbench_1")).resolves.toEqual([
      { kind: "clarification", reasonCode: "question_required", referenceId: "input_c" },
      { kind: "workbench_change", referenceId: "req_1" },
      { kind: "partner_waiting", reasonCode: "WAITING_INPUT", referenceId: "run_2" },
    ]);
  });
});
