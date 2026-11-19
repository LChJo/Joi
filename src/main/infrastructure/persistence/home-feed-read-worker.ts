import { DatabaseSync } from "node:sqlite";
import { type MessagePort, workerData } from "node:worker_threads";
import { WorkerRpc } from "../runtime/worker-rpc.js";
import { SqliteJoiHomeFeedRepository } from "./sqlite-joi-home-feed-repository.js";
import { SqliteWorkbenchAgentRepository } from "./sqlite-workbench-agent-repository.js";
import type { WorkbenchAgentListQuery } from "../../application/ports/workbench-agents.js";
import type { JoiGoalDetailPage } from "../../../shared/joi.js";
import type { GoalResultPage } from "../../../shared/goal-results.js";
import type { GoalArtifactPage } from "../../../shared/goal-artifacts.js";

const input = workerData as { databasePath: string; port: MessagePort };
const connection = new DatabaseSync(input.databasePath, { readOnly: true });
connection.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
const database = {
  transaction<T>(operation: (database: DatabaseSync) => T): T {
    // A WAL read snapshot never requests the writer's reserved lock.
    connection.exec("BEGIN");
    try { const result = operation(connection); connection.exec("COMMIT"); return result; }
    catch (error) { connection.exec("ROLLBACK"); throw error; }
  },
};
const repository = new SqliteJoiHomeFeedRepository(database);
const agents = new SqliteWorkbenchAgentRepository(database);
let closed = false;
new WorkerRpc(input.port, {
  load: (now) => repository.load(now as Date),
  listAgents: argument => agents.listAgents(argument as WorkbenchAgentListQuery),
  loadGoalDetail: (argument) => {
    const request = argument as { goalId: string; page: JoiGoalDetailPage };
    return repository.loadGoalDetail(request.goalId, request.page);
  },
  listGoalResults: argument => {
    const request = argument as { goalId: string; page: GoalResultPage };
    return repository.listGoalResults(request.goalId, request.page);
  },
  getGoalResult: argument => {
    const request = argument as { goalId: string; resultId: string };
    return repository.getGoalResult(request.goalId, request.resultId);
  },
  listGoalArtifacts: argument => {
    const request = argument as { goalId: string; page: GoalArtifactPage };
    return repository.listGoalArtifacts(request.goalId, request.page);
  },
  close: () => {
    // The owner terminates the Worker after receiving the database-close reply.
    if (!closed) {
      connection.close();
      closed = true;
    }
  },
});
