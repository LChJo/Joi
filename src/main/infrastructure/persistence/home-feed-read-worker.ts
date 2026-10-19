import { DatabaseSync } from "node:sqlite";
import { parentPort, type MessagePort, workerData } from "node:worker_threads";
import { WorkerRpc } from "../runtime/worker-rpc.js";
import { SqliteJoiHomeFeedRepository } from "./sqlite-joi-home-feed-repository.js";
import type { JoiGoalDetailPage } from "../../../shared/joi.js";

const input = workerData as { databasePath: string; port: MessagePort };
const connection = new DatabaseSync(input.databasePath, { readOnly: true });
connection.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
const repository = new SqliteJoiHomeFeedRepository({
  transaction<T>(operation: (database: DatabaseSync) => T): T {
    // A WAL read snapshot never requests the writer's reserved lock.
    connection.exec("BEGIN");
    try { const result = operation(connection); connection.exec("COMMIT"); return result; }
    catch (error) { connection.exec("ROLLBACK"); throw error; }
  },
});
let closed = false;
const peer = new WorkerRpc(input.port, {
  load: (now) => repository.load(now as Date),
  loadGoalDetail: (argument) => {
    const request = argument as { goalId: string; page: JoiGoalDetailPage };
    return repository.loadGoalDetail(request.goalId, request.page);
  },
  close: () => {
    if (!closed) { closed = true; connection.close(); }
    setImmediate(() => { peer.close(); parentPort?.close(); });
  },
});
