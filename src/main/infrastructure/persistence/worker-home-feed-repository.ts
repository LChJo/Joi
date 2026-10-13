import { MessageChannel, Worker } from "node:worker_threads";
import type { JoiHomeFeedRepository } from "../../application/ports/joi-home-feed.js";
import type { JoiHomeFeedDto } from "../../../shared/joi.js";
import { WorkerRpc } from "../runtime/worker-rpc.js";

export class WorkerHomeFeedRepository implements JoiHomeFeedRepository {
  readonly #worker: Worker;
  readonly #rpc: WorkerRpc;
  #closePromise: Promise<void> | undefined;

  constructor(databasePath: string, workerUrl = new URL("./home-feed-read-worker.js", import.meta.url)) {
    const { port1, port2 } = new MessageChannel();
    this.#rpc = new WorkerRpc(port1);
    this.#worker = new Worker(workerUrl, { workerData: { databasePath, port: port2 }, transferList: [port2] });
    this.#worker.on("error", () => this.#rpc.close());
    this.#worker.on("exit", () => this.#rpc.close());
  }

  load(now: Date): Promise<JoiHomeFeedDto> { return this.#rpc.call("load", now); }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      try { await this.#rpc.call("close"); }
      finally { this.#rpc.close(); await this.#worker.terminate(); }
    })();
    return this.#closePromise;
  }
}
