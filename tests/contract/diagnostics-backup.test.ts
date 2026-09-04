import { createRuntimeFixture } from "../support/runtime-fixture";

describe("safe operations projections", () => {
  it("returns only counts, versions, states and non-sensitive backup metadata", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const diagnostics = await fixture.operations.diagnostics();
      const manifest = await fixture.operations.createBackupManifest({ appVersion: "0.1.0", artifactCount: 0, artifactTotalBytes: 0 });
      const serialized = JSON.stringify({ diagnostics, manifest });

      expect(diagnostics).toMatchObject({
        database: { journalMode: "wal", state: "open" },
        runtime: { pendingOutbox: 0 },
        schemaVersion: 51,
      });
      expect(manifest).toMatchObject({
        appVersion: "0.1.0",
        schemaVersion: 51,
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
      await expect(operations.createBackup()).resolves.toEqual(summary);
      await expect(operations.listBackups()).resolves.toEqual([summary]);
      await expect(operations.stageRestore(summary.backupId)).resolves.toMatchObject({ restartRequired: true });
    } finally {
      await fixture.close();
    }
  });
});
