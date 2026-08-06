/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { WorkbenchRepository, WorkbenchSummary, LegacyWorkbenchPolicyReader } from "../../application/ports/workbench-context.js";
import { createWorkbench, type Workbench } from "../../domain/workbench/workbench.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

const requiredText = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw new Error("legacy_workbench_mapping_invalid");
  return value;
};

export class LegacyLifeStoreAdapter implements WorkbenchRepository, LegacyWorkbenchPolicyReader {
  constructor(private readonly database: TransactionalDatabase) {}

  async getWorkbench(workbenchId: string): Promise<Workbench | null> {
    const row = this.database.transaction((connection) => connection.prepare(`
      SELECT workbench_id, name, created_at, updated_at, persona_revision_id, persona_summary,
             scope_summary, project_label, memory_namespace_id, task_summary
        FROM workbenches WHERE workbench_id = ? AND status = 'ACTIVE'`).get(workbenchId)) as Row | undefined;
    if (row === undefined) return null;
    const id = requiredText(row, "workbench_id");
    const name = requiredText(row, "name");
    return createWorkbench({
      workbenchId: id,
      createdAt: requiredText(row, "created_at"),
      memoryNamespaceId: requiredText(row, "memory_namespace_id"),
      name,
      personaRevisionId: requiredText(row, "persona_revision_id"),
      personaSummary: requiredText(row, "persona_summary"),
      project: { label: requiredText(row, "project_label") },
      scopeSummary: requiredText(row, "scope_summary"),
      taskContext: { activeWorkIds: [], summary: requiredText(row, "task_summary") },
    });
  }

  async listSummaries(): Promise<WorkbenchSummary[]> {
    return this.database.transaction((connection) => connection.prepare(`
      SELECT workbench_id, name, scope_summary, updated_at FROM workbenches WHERE status = 'ACTIVE'
       ORDER BY updated_at DESC, workbench_id`).all()).map((value) => {
      const row = value as Row;
      return {
        workbenchId: requiredText(row, "workbench_id"),
        name: requiredText(row, "name"),
        scopeSummary: requiredText(row, "scope_summary"),
        updatedAt: requiredText(row, "updated_at"),
      };
    });
  }

  async createWorkbench(workbench: Workbench): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO workbenches
        (workbench_id, legacy_life_id, name, persona_revision_id, persona_summary, scope_summary,
         project_label, workspace_ref, memory_namespace_id, task_summary, status, created_at, updated_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, 'ACTIVE', ?, ?)`
      ).run(
        workbench.workbenchId, workbench.profile.name, workbench.profile.personaRevisionId, workbench.profile.personaSummary,
        workbench.profile.scopeSummary, workbench.project.label, workbench.memory.namespaceId,
        workbench.taskContext.summary, workbench.createdAt, workbench.updatedAt,
      );
    });
  }

  async getPreferredPartnerId(workbenchId: string): Promise<string | null> {
    const mapped = this.database.transaction((connection) => connection.prepare(
      "SELECT preferred_partner_id FROM workbench_partner_policies WHERE workbench_id = ?",
    ).get(workbenchId)) as Row | undefined;
    if (typeof mapped?.preferred_partner_id === "string") return mapped.preferred_partner_id;
    const legacy = this.database.transaction((connection) => connection.prepare(
      "SELECT main_agent_connection_id FROM lives WHERE life_id = ?",
    ).get(workbenchId)) as Row | undefined;
    return typeof legacy?.main_agent_connection_id === "string" ? `partner_${legacy.main_agent_connection_id}` : null;
  }
}
