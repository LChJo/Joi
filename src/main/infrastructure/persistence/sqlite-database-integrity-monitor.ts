import { Worker } from "node:worker_threads";

import type { Clock } from "../../application/ports/runtime-store.js";

const DAILY_CHECK_MILLIS = 24 * 60 * 60_000;

export interface DatabaseIntegritySnapshot {
  checkedAt?: string;
  checking: boolean;
  status: "check_failed" | "failed" | "ok" | "unknown";
}

const QUICK_CHECK_WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let database;
try {
  database = new DatabaseSync(workerData.databasePath, { readOnly: true });
  database.exec("PRAGMA query_only = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  const row = database.prepare("PRAGMA quick_check").get();
  parentPort.postMessage({ status: row && row.quick_check === "ok" ? "ok" : "failed" });
} catch {
  parentPort.postMessage({ status: "check_failed" });
} finally {
  if (database) database.close();
}
`;

function runQuickCheckInWorker(databasePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(QUICK_CHECK_WORKER, { eval: true, workerData: { databasePath } });
    let settled = false;
    worker.once("message", (message: unknown) => {
      settled = true;
      const status = message !== null && typeof message === "object" && "status" in message
        ? (message as { status?: unknown }).status
        : undefined;
      resolve(status === "ok" ? "ok" : status === "failed" ? "failed" : "check_failed");
    });
    worker.once("error", () => {
      if (!settled) reject(new Error("database_integrity_worker_failed"));
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error("database_integrity_worker_failed"));
    });
  });
}

/** Runs the full SQLite traversal away from Electron's event loop and exposes only bounded state. */
export class SqliteDatabaseIntegrityMonitor {
  #inFlight: Promise<DatabaseIntegritySnapshot> | null = null;
  #snapshot: DatabaseIntegritySnapshot = { checking: false, status: "unknown" };
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;

  constructor(private readonly dependencies: {
    clock: Clock;
    databasePath: string;
    intervalMillis?: number;
    run?: (databasePath: string) => Promise<string>;
  }) {}

  snapshot(): DatabaseIntegritySnapshot {
    return { ...this.#snapshot };
  }

  check(): Promise<DatabaseIntegritySnapshot> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#snapshot = { ...this.#snapshot, checking: true };
    const run = this.dependencies.run ?? runQuickCheckInWorker;
    const pending = run(this.dependencies.databasePath)
      .then((status): DatabaseIntegritySnapshot => ({
        checkedAt: this.dependencies.clock.now().toISOString(),
        checking: false,
        status: status === "ok" ? "ok" : status === "failed" ? "failed" : "check_failed",
      }))
      .catch((): DatabaseIntegritySnapshot => ({
        checkedAt: this.dependencies.clock.now().toISOString(),
        checking: false,
        status: "check_failed",
      }))
      .then((snapshot) => {
        this.#snapshot = snapshot;
        return { ...snapshot };
      })
      .finally(() => {
        if (this.#inFlight === pending) this.#inFlight = null;
      });
    this.#inFlight = pending;
    return pending;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const schedule = () => {
      if (!this.#started) return;
      this.#timer = setTimeout(() => {
        void this.check().finally(schedule);
      }, this.dependencies.intervalMillis ?? DAILY_CHECK_MILLIS);
      this.#timer.unref();
    };
    void this.check().finally(schedule);
  }

  close(): void {
    this.#started = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
