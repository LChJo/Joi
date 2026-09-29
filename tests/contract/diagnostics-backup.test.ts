import path from "node:path";

import { latestMigrationVersion } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("safe operations projections", () => {
  it("returns only counts, versions, states and non-sensitive backup metadata", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const schemaVersion = await latestMigrationVersion(path.resolve("resources/migrations"));
      const diagnostics = await fixture.operations.diagnostics();
      const manifest = await fixture.operations.createBackupManifest({ appVersion: "0.1.0", artifactCount: 0, artifactTotalBytes: 0 });
      const serialized = JSON.stringify({ diagnostics, manifest });

      expect(diagnostics).toMatchObject({
        database: { journalMode: "wal", state: "open" },
        runtime: { pendingOutbox: 0 },
        schemaVersion,
      });
      expect(manifest).toMatchObject({
        appVersion: "0.1.0",
        schemaVersion,
        secretsExcluded: true,
      });
      expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(serialized).not.toContain(fixture.root);
      expect(serialized.toLowerCase()).not.toMatch(/password|bearer|cookie|csrf|persona|message/);
      await expect(fixture.operations.listBackups()).resolves.toEqual([]);
      expect(() => fixture.operations.createBackup()).toThrow(/unavailable/);
      expect(() => fixture.operations.stageRestore("missing")).toThrow(/unavailable/);
    } finally {
      await fixture.close();
    }
  });

  it("orchestrates verified backups, restore staging, recovery and storage health without paths", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const summary = { backupId: "backup_safe", createdAt: fixture.clock.now().toISOString(), databaseBytes: 42, manifestHash: "a".repeat(64), schemaVersion: 4 };
      const backup = {
        create: vi.fn().mockResolvedValue(summary),
        list: vi.fn().mockResolvedValue([summary]),
        stageRestore: vi.fn().mockResolvedValue({ backupId: summary.backupId, restartRequired: true as const }),
        storageHealth: vi.fn().mockResolvedValue({ artifactsBytes: 1, backupsBytes: 42, databaseBytes: 41, diskAvailableBytes: 1_000_000, state: "ok" as const }),
      };
      const { OperationsService } = await import("../../src/main/application/operations/operations-service");
      const operations = new OperationsService({ backup, clock: fixture.clock, startup: { uncleanShutdown: true }, store: fixture.database.store, webHealth: () => ({ lan: { status: "listening" } }) });
      expect(await operations.diagnostics()).toMatchObject({ recovery: { uncleanShutdown: true }, storage: { state: "ok" }, web: { lan: { status: "listening" } } });
      expect(await operations.diagnostics()).toMatchObject({ storage: { state: "ok" } });
      expect(backup.storageHealth).toHaveBeenCalledOnce();
      await expect(operations.createBackup()).resolves.toEqual(summary);
      await expect(operations.listBackups()).resolves.toEqual([summary]);
      await expect(operations.stageRestore(summary.backupId)).resolves.toMatchObject({ restartRequired: true });
    } finally {
      await fixture.close();
    }
  });

  it("projects cached database integrity and only runs a check when explicitly requested", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const snapshot = vi.fn().mockReturnValue({ checkedAt: "2026-09-29T03:00:00.000Z", checking: false, status: "ok" });
      const check = vi.fn().mockResolvedValue({ checkedAt: "2026-09-29T03:01:00.000Z", checking: false, status: "ok" });
      const { OperationsService } = await import("../../src/main/application/operations/operations-service");
      const operations = new OperationsService({ clock: fixture.clock, integrity: { check, snapshot }, store: fixture.database.store });

      await operations.diagnostics();
      await operations.diagnostics();

      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(check).not.toHaveBeenCalled();
      await expect(operations.checkDatabaseIntegrity()).resolves.toMatchObject({ status: "ok" });
      expect(check).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });

  it("coalesces storage-health reads and safely handles an unavailable integrity monitor", async () => {
    const fixture = await createRuntimeFixture();
    try {
      let resolveStorage: ((value: { artifactsBytes: number; backupsBytes: number; databaseBytes: number; diskAvailableBytes: number; state: "ok" }) => void) | undefined;
      const storageHealth = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveStorage = resolve; }));
      const { OperationsService } = await import("../../src/main/application/operations/operations-service");
      const operations = new OperationsService({
        backup: {
          create: vi.fn(),
          list: vi.fn(),
          stageRestore: vi.fn(),
          storageHealth,
        },
        clock: fixture.clock,
        storageCacheMillis: 1,
        store: fixture.database.store,
      });

      const first = operations.diagnostics();
      const second = operations.diagnostics();
      await vi.waitFor(() => expect(storageHealth).toHaveBeenCalledOnce());
      resolveStorage?.({ artifactsBytes: 1, backupsBytes: 2, databaseBytes: 3, diskAvailableBytes: 4, state: "ok" });

      await expect(first).resolves.toMatchObject({ storage: { databaseBytes: 3 } });
      await expect(second).resolves.toMatchObject({ storage: { databaseBytes: 3 } });
      await expect(operations.checkDatabaseIntegrity()).resolves.toEqual({ checking: false, status: "unknown" });
    } finally {
      await fixture.close();
    }
  });
});
