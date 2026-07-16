import type { Clock, RuntimeStore } from "../ports/runtime-store.js";

interface BackupOperations {
  create(): Promise<{ backupId: string; createdAt: string; databaseBytes: number; manifestHash: string; schemaVersion: number }>;
  list(): Promise<{ backupId: string; createdAt: string; databaseBytes: number; manifestHash: string; schemaVersion: number }[]>;
  stageRestore(backupId: string): Promise<{ backupId: string; restartRequired: true }>;
  storageHealth(): Promise<{ artifactsBytes: number; backupsBytes: number; databaseBytes: number; diskAvailableBytes: number; state: "low" | "ok" }>;
}

interface StartupEvidence {
  uncleanShutdown: boolean;
}

export class OperationsService {
  constructor(private readonly dependencies: {
    backup?: BackupOperations;
    clock: Clock;
    startup?: StartupEvidence;
    store: Pick<RuntimeStore, "createManifestHash" | "getRuntimeStats">;
    webHealth?: () => Record<string, unknown>;
  }) {}

  async diagnostics() {
    const stats = await this.dependencies.store.getRuntimeStats();
    const storage = await this.dependencies.backup?.storageHealth();
    return {
      agents: { activeInvocations: stats.activeInvocations, connections: stats.agentConnections, openBreakers: stats.openBreakers },
      database: { integrity: stats.integrity, journalMode: stats.journalMode, state: "open" as const },
      recovery: { uncleanShutdown: this.dependencies.startup?.uncleanShutdown ?? false },
      runtime: {
        activeWakes: stats.activeWakes,
        enabledSchedules: stats.enabledSchedules,
        leases: stats.runtimeLeases,
        pendingOutbox: stats.pendingOutbox,
        scheduledAlarms: stats.scheduledAlarms,
        staleWakeTurns: stats.staleWakeTurns,
      },
      schemaVersion: stats.schemaVersion,
      sse: { events: stats.sseEvents },
      ...(storage === undefined ? {} : { storage }),
      web: { sessions: stats.sessions, ...(this.dependencies.webHealth?.() ?? {}) },
    };
  }

  createBackup() {
    if (this.dependencies.backup === undefined) throw new Error("Backup service is unavailable.");
    return this.dependencies.backup.create();
  }

  listBackups() {
    if (this.dependencies.backup === undefined) return Promise.resolve([]);
    return this.dependencies.backup.list();
  }

  stageRestore(backupId: string) {
    if (this.dependencies.backup === undefined) throw new Error("Backup service is unavailable.");
    return this.dependencies.backup.stageRestore(backupId);
  }

  async createBackupManifest(input: { appVersion: string; artifactCount: number; artifactTotalBytes: number }) {
    const stats = await this.dependencies.store.getRuntimeStats();
    const manifestBase = {
      appVersion: input.appVersion,
      artifacts: { count: input.artifactCount, totalBytes: input.artifactTotalBytes },
      createdAt: this.dependencies.clock.now().toISOString(),
      database: { lives: stats.lives, sseEvents: stats.sseEvents },
      formatVersion: 1,
      schemaVersion: stats.schemaVersion,
      secretsExcluded: true as const,
    };
    return { ...manifestBase, manifestHash: this.dependencies.store.createManifestHash(manifestBase) };
  }
}
