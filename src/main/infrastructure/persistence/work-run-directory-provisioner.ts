import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../../application/ports/runtime-store.js";
import { DomainError } from "../../domain/errors.js";

interface DirectoryRecord { kind: "MANAGED" | "BOUND"; root_path: string; }

/** Called only from dispatch outbox preparation, before tools or model startup. */
export class WorkRunDirectoryProvisioner {
  constructor(private readonly dependencies: {
    baseDirectory: string;
    clock: Clock;
    database: { transaction<T>(operation: (database: DatabaseSync) => T): T };
  }) {}

  async ensureForWork(input: { workbenchId: string; workId: string }): Promise<void> {
    const record = this.dependencies.database.transaction((db) => {
      const work = db.prepare("SELECT 1 FROM work_items WHERE work_id = ? AND workbench_id = ?").get(input.workId, input.workbenchId);
      if (work === undefined) throw new DomainError("workbench_context_not_found", "Work execution context was not found.");
      const existing = db.prepare("SELECT kind, root_path FROM work_run_directories WHERE work_id = ?").get(input.workId) as DirectoryRecord | undefined;
      if (existing !== undefined) return existing;
      const binding = db.prepare(`SELECT b.kind, r.root_path FROM workbench_workspace_bindings b
        LEFT JOIN workbench_workspace_roots r ON r.workspace_ref = b.workspace_ref WHERE b.workbench_id = ?`).get(input.workbenchId) as Partial<DirectoryRecord> | undefined;
      const now = this.dependencies.clock.now().toISOString();
      const kind = binding?.kind === "BOUND" ? "BOUND" : "MANAGED";
      if (kind === "BOUND" && typeof binding?.root_path !== "string") {
        throw new DomainError("workbench_workspace_not_ready", "The selected Workbench directory is unavailable.");
      }
      const rootPath = kind === "BOUND" && binding?.root_path !== undefined
        ? binding.root_path : path.join(this.dependencies.baseDirectory, `${now.replaceAll(":", "-")}_${randomUUID()}`);
      db.prepare(`INSERT INTO work_run_directories (work_id, workbench_id, kind, root_path, status, created_at)
        VALUES (?, ?, ?, ?, 'PROVISIONING', ?)`).run(input.workId, input.workbenchId, kind, rootPath, now);
      return { kind, root_path: rootPath };
    });
    try {
      if (record.kind === "MANAGED") await mkdir(record.root_path, { recursive: true });
      if (!(await stat(record.root_path)).isDirectory()) throw new Error("not_directory");
    } catch {
      throw new DomainError("work_run_directory_unavailable", "The working directory could not be prepared. Check directory access and retry.");
    }
    this.dependencies.database.transaction((db) => {
      db.prepare("UPDATE work_run_directories SET status = 'READY' WHERE work_id = ? AND workbench_id = ?").run(input.workId, input.workbenchId);
    });
  }
}
