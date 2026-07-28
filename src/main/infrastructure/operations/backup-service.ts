import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Clock } from "../../application/ports/runtime-store.js";
import { DomainError } from "../../domain/errors.js";
import { applyMigrations, latestMigrationVersion, type RuntimeDatabase } from "../persistence/runtime-database.js";

const BACKUP_ID = /^backup_[0-9TZ-]{20,32}_[a-f0-9]{8}$/;
const PENDING_RESTORE = "pending-restore.json";

interface BackupFile {
  path: string;
  sha256: string;
  size: number;
}

export interface BackupManifest {
  appVersion: string;
  artifacts: { count: number; files: BackupFile[]; totalBytes: number };
  createdAt: string;
  database: { filename: "runtime.sqlite"; sha256: string; size: number };
  formatVersion: 1;
  manifestHash: string;
  schemaVersion: number;
  secretsExcluded: true;
}

export interface BackupSummary {
  backupId: string;
  createdAt: string;
  databaseBytes: number;
  manifestHash: string;
  schemaVersion: number;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function filesBelow(root: string, relative = ""): Promise<BackupFile[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: BackupFile[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, childRelative));
    else if (entry.isFile()) {
      const absolute = path.join(root, childRelative);
      const metadata = await stat(absolute);
      files.push({ path: childRelative.split(path.sep).join("/"), sha256: await sha256(absolute), size: metadata.size });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function manifestHash(manifest: Omit<BackupManifest, "manifestHash">): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function readManifest(directory: string): Promise<BackupManifest> {
  const parsed: unknown = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (parsed === null || typeof parsed !== "object") throw new Error("Backup manifest is invalid.");
  const record = parsed as Record<string, unknown>;
  if (record.formatVersion !== 1) throw new Error("Backup manifest version is unsupported.");
  const manifest = parsed as BackupManifest;
  const { manifestHash: expected, ...base } = manifest;
  if (expected !== manifestHash(base)) throw new Error("Backup manifest integrity check failed.");
  if (!/^[a-f0-9]{64}$/.test(manifest.database.sha256)) {
    throw new Error("Backup database metadata is invalid.");
  }
  return manifest;
}

async function validateBackup(directory: string): Promise<BackupManifest> {
  const manifest = await readManifest(directory);
  const databasePath = path.join(directory, manifest.database.filename);
  const metadata = await stat(databasePath);
  if (metadata.size !== manifest.database.size || await sha256(databasePath) !== manifest.database.sha256) {
    throw new Error("Backup database integrity check failed.");
  }
  for (const file of manifest.artifacts.files) {
    const relative = path.normalize(file.path);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Backup artifact path is invalid.");
    const artifactPath = path.join(directory, "artifacts", relative);
    const artifact = await stat(artifactPath);
    if (artifact.size !== file.size || await sha256(artifactPath) !== file.sha256) throw new Error("Backup artifact integrity check failed.");
  }
  return manifest;
}

function createBackupId(now: Date): string {
  return `backup_${now.toISOString().replaceAll(":", "-").replaceAll(".", "-")}_${createHash("sha256").update(String(now.getTime()) + String(Math.random())).digest("hex").slice(0, 8)}`;
}

export class BackupService {
  constructor(private readonly dependencies: {
    appVersion: string;
    artifactsDirectory: string;
    backupsDirectory: string;
    clock: Clock;
    database: RuntimeDatabase;
    migrationsDirectory?: string;
    userDataDirectory: string;
  }) {}

  async create(): Promise<BackupSummary> {
    const now = this.dependencies.clock.now();
    const backupId = createBackupId(now);
    await mkdir(this.dependencies.backupsDirectory, { recursive: true });
    const temporary = path.join(this.dependencies.backupsDirectory, `.creating-${backupId}`);
    const published = path.join(this.dependencies.backupsDirectory, backupId);
    await mkdir(temporary, { recursive: true });
    try {
      const databasePath = path.join(temporary, "runtime.sqlite");
      await this.dependencies.database.backupTo(databasePath);
      const sanitizedDatabase = new DatabaseSync(databasePath);
      try {
        const hasModelCredentials = sanitizedDatabase.prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'model_source_credentials'",
        ).get() !== undefined;
        if (hasModelCredentials) sanitizedDatabase.prepare("UPDATE model_source_credentials SET encrypted_blob = X''").run();
      } finally {
        sanitizedDatabase.close();
      }
      const artifactTarget = path.join(temporary, "artifacts");
      await mkdir(artifactTarget, { recursive: true });
      await cp(this.dependencies.artifactsDirectory, artifactTarget, { recursive: true, force: false, errorOnExist: true }).catch((error: unknown) => {
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") throw error;
      });
      const database = await stat(databasePath);
      const artifactFiles = await filesBelow(artifactTarget);
      const base: Omit<BackupManifest, "manifestHash"> = {
        appVersion: this.dependencies.appVersion,
        artifacts: {
          count: artifactFiles.length,
          files: artifactFiles,
          totalBytes: artifactFiles.reduce((total, file) => total + file.size, 0),
        },
        createdAt: now.toISOString(),
        database: { filename: "runtime.sqlite", sha256: await sha256(databasePath), size: database.size },
        formatVersion: 1,
        schemaVersion: this.dependencies.database.inspect().schemaVersion,
        secretsExcluded: true,
      };
      const manifest: BackupManifest = { ...base, manifestHash: manifestHash(base) };
      await writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, published);
      return { backupId, createdAt: manifest.createdAt, databaseBytes: database.size, manifestHash: manifest.manifestHash, schemaVersion: manifest.schemaVersion };
    } catch (error) {
      await rm(temporary, { force: true, recursive: true });
      throw error;
    }
  }

  async list(): Promise<BackupSummary[]> {
    const entries = await readdir(this.dependencies.backupsDirectory, { withFileTypes: true }).catch(() => []);
    const summaries: BackupSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !BACKUP_ID.test(entry.name)) continue;
      try {
        const manifest = await readManifest(path.join(this.dependencies.backupsDirectory, entry.name));
        summaries.push({ backupId: entry.name, createdAt: manifest.createdAt, databaseBytes: manifest.database.size, manifestHash: manifest.manifestHash, schemaVersion: manifest.schemaVersion });
      } catch {
        // Corrupt or incomplete backups are deliberately omitted from the usable list.
      }
    }
    return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async stageRestore(backupId: string): Promise<{ backupId: string; restartRequired: true }> {
    if (!BACKUP_ID.test(backupId)) throw new Error("Backup identifier is invalid.");
    const manifest = await validateBackup(path.join(this.dependencies.backupsDirectory, backupId));
    if (manifest.schemaVersion > this.dependencies.database.inspect().schemaVersion) {
      throw new DomainError("backup_schema_newer", "This backup requires a newer joi version.");
    }
    const unsafe = this.dependencies.database.transaction((database) => {
      const count = (sql: string) => (database.prepare(sql).get() as { count: number }).count;
      return {
        activeInvocations: count(`SELECT COUNT(*) AS count FROM invocations WHERE status NOT IN ('CANCELED', 'COMPLETED', 'FAILED', 'UNKNOWN_REQUIRES_REVIEW')`),
        activeWakes: count(`SELECT COUNT(*) AS count FROM wakes WHERE status IN ('CREATED', 'RUNNING')`),
        runningLives: count(`SELECT COUNT(*) AS count FROM lives WHERE state NOT IN ('PAUSED', 'STOPPED')`),
      };
    });
    if (unsafe.activeInvocations > 0 || unsafe.activeWakes > 0 || unsafe.runningLives > 0) {
      throw new DomainError("restore_runtime_active", "Pause every Life and wait for active Wake and Invocation work before restoring.");
    }
    await writeFile(path.join(this.dependencies.userDataDirectory, PENDING_RESTORE), JSON.stringify({ backupId, requestedAt: this.dependencies.clock.now().toISOString() }), "utf8");
    return { backupId, restartRequired: true };
  }

  async stageRecoveryRestore(backupId: string): Promise<{ backupId: string; restartRequired: true }> {
    if (!BACKUP_ID.test(backupId)) throw new DomainError("backup_id_invalid", "Backup identifier is invalid.");
    const manifest = await validateBackup(path.join(this.dependencies.backupsDirectory, backupId));
    if (manifest.schemaVersion > await latestMigrationVersion(this.dependencies.migrationsDirectory ?? path.resolve("resources/migrations"))) {
      throw new DomainError("backup_schema_newer", "This backup requires a newer joi version.");
    }
    await writeFile(path.join(this.dependencies.userDataDirectory, PENDING_RESTORE), JSON.stringify({
      backupId, requestedAt: this.dependencies.clock.now().toISOString(), recoveryMode: true,
    }), "utf8");
    return { backupId, restartRequired: true };
  }

  async storageHealth() {
    const [database, artifacts, backups, disk] = await Promise.all([
      stat(path.join(this.dependencies.userDataDirectory, "runtime.sqlite")).catch(() => null),
      filesBelow(this.dependencies.artifactsDirectory),
      this.list(),
      statfs(this.dependencies.userDataDirectory),
    ]);
    return {
      artifactsBytes: artifacts.reduce((total, file) => total + file.size, 0),
      backupsBytes: backups.reduce((total, item) => total + item.databaseBytes, 0),
      databaseBytes: database?.size ?? 0,
      diskAvailableBytes: disk.bavail * disk.bsize,
      state: disk.bavail * disk.bsize < 256 * 1024 * 1024 ? "low" as const : "ok" as const,
    };
  }
}

async function moveIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await rename(source, destination);
    return true;
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
}

export async function applyPendingRestore(userDataDirectory: string, migrationsDirectory = path.resolve("resources/migrations")): Promise<{ backupId: string; restored: boolean } | null> {
  const markerPath = path.join(userDataDirectory, PENDING_RESTORE);
  let marker: { backupId?: unknown };
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8")) as { backupId?: unknown };
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return null;
    throw error;
  }
  if (typeof marker.backupId !== "string" || !BACKUP_ID.test(marker.backupId)) throw new Error("Pending restore marker is invalid.");
  const backupDirectory = path.join(userDataDirectory, "backups", marker.backupId);
  const manifest = await validateBackup(backupDirectory);
  const supportedSchema = await latestMigrationVersion(migrationsDirectory);
  if (manifest.schemaVersion > supportedSchema) throw new DomainError("backup_schema_newer", "This backup requires a newer joi version.");
  const required = manifest.database.size + manifest.artifacts.totalBytes + 64 * 1024 * 1024;
  const disk = await statfs(userDataDirectory);
  if (disk.bavail * disk.bsize < required) throw new Error("Insufficient disk space for restore.");

  const quarantine = path.join(userDataDirectory, "quarantine", new Date().toISOString().replaceAll(":", "-"));
  await mkdir(quarantine, { recursive: true });
  const databasePath = path.join(userDataDirectory, "runtime.sqlite");
  const artifactsPath = path.join(userDataDirectory, "artifacts");
  let movedDatabase = false;
  let movedArtifacts = false;
  try {
    movedDatabase = await moveIfPresent(databasePath, path.join(quarantine, "runtime.sqlite"));
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    movedArtifacts = await moveIfPresent(artifactsPath, path.join(quarantine, "artifacts"));
    await copyFile(path.join(backupDirectory, "runtime.sqlite"), databasePath);
    await cp(path.join(backupDirectory, "artifacts"), artifactsPath, { recursive: true });

    const restored = new DatabaseSync(databasePath);
    try {
      const now = new Date().toISOString();
      restored.exec("PRAGMA foreign_keys = ON");
      restored.exec("PRAGMA journal_mode = WAL");
      restored.exec("PRAGMA busy_timeout = 5000");
      await applyMigrations(restored, migrationsDirectory);
      restored.prepare("UPDATE web_sessions SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
      restored.prepare("UPDATE agent_connections SET status = 'RECONFIRM_REQUIRED', token_required = 1, updated_at = ? WHERE status != 'DISABLED'").run(now);
      restored.prepare(`UPDATE invocations SET status = 'UNKNOWN_REQUIRES_REVIEW', updated_at = ?
        WHERE status NOT IN ('CANCELED', 'COMPLETED', 'FAILED', 'UNKNOWN_REQUIRES_REVIEW')`).run(now);
      const integrity = restored.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
      if (integrity?.integrity_check !== "ok") throw new Error("Restored database integrity check failed.");
    } finally {
      restored.close();
    }
    await rm(markerPath, { force: true });
    await writeFile(path.join(quarantine, "restore.json"), JSON.stringify({ backupId: marker.backupId, restoredAt: new Date().toISOString() }), "utf8");
    return { backupId: marker.backupId, restored: true };
  } catch (error) {
    await rm(databasePath, { force: true });
    await rm(artifactsPath, { force: true, recursive: true });
    if (movedDatabase) await rename(path.join(quarantine, "runtime.sqlite"), databasePath);
    if (movedArtifacts) await rename(path.join(quarantine, "artifacts"), artifactsPath);
    await rm(markerPath, { force: true });
    throw error;
  }
}
