import { SqliteDatabaseIntegrityMonitor } from "../../src/main/infrastructure/persistence/sqlite-database-integrity-monitor";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

describe("sqlite database integrity monitor", () => {
  it("coalesces concurrent checks and keeps a bounded cached projection", async () => {
    let finish: ((value: string) => void) | undefined;
    const run = vi.fn().mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const monitor = new SqliteDatabaseIntegrityMonitor({
      clock: { now: () => new Date("2026-09-29T03:00:00.000Z") },
      databasePath: "private/runtime.sqlite",
      run,
    });

    const first = monitor.check();
    const second = monitor.check();
    expect(run).toHaveBeenCalledOnce();
    expect(monitor.snapshot()).toEqual({ checking: true, status: "unknown" });

    finish?.("ok");
    await expect(first).resolves.toEqual({ checkedAt: "2026-09-29T03:00:00.000Z", checking: false, status: "ok" });
    await expect(second).resolves.toEqual({ checkedAt: "2026-09-29T03:00:00.000Z", checking: false, status: "ok" });
    expect(monitor.snapshot()).not.toHaveProperty("databasePath");
  });

  it("turns worker failures into a safe status without exposing the error", async () => {
    const monitor = new SqliteDatabaseIntegrityMonitor({
      clock: { now: () => new Date("2026-09-29T03:00:00.000Z") },
      databasePath: "private/runtime.sqlite",
      run: () => Promise.reject(new Error("private/runtime.sqlite secret")),
    });

    await expect(monitor.check()).resolves.toEqual({ checkedAt: "2026-09-29T03:00:00.000Z", checking: false, status: "check_failed" });
    expect(JSON.stringify(monitor.snapshot())).not.toContain("private");
  });

  it.each([
    ["failed", "failed"],
    ["unexpected", "check_failed"],
  ] as const)("normalizes a %s worker result to %s", async (workerStatus, expectedStatus) => {
    const monitor = new SqliteDatabaseIntegrityMonitor({
      clock: { now: () => new Date("2026-09-29T03:00:00.000Z") },
      databasePath: "private/runtime.sqlite",
      run: () => Promise.resolve(workerStatus),
    });

    await expect(monitor.check()).resolves.toMatchObject({ checking: false, status: expectedStatus });
  });

  it("starts once, schedules later checks and cancels the schedule when closed", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn().mockResolvedValue("ok");
      const monitor = new SqliteDatabaseIntegrityMonitor({
        clock: { now: () => new Date("2026-09-29T03:00:00.000Z") },
        databasePath: "private/runtime.sqlite",
        intervalMillis: 100,
        run,
      });

      monitor.start();
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      expect(run).toHaveBeenCalledTimes(2);

      monitor.close();
      monitor.close();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs quick_check on a disposable database in a worker thread", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "joi-integrity-"));
    const databasePath = path.join(directory, "runtime.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sample (value) VALUES ('safe');");
    database.close();
    try {
      const monitor = new SqliteDatabaseIntegrityMonitor({
        clock: { now: () => new Date("2026-09-29T03:00:00.000Z") },
        databasePath,
      });
      await expect(monitor.check()).resolves.toEqual({
        checkedAt: "2026-09-29T03:00:00.000Z",
        checking: false,
        status: "ok",
      });
    } finally {
      await rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
