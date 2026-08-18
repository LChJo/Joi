/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { WorkbenchDetailDto } from "../../../shared/joi.js";
import type { WorkbenchManagementRepository } from "../../application/ports/workbench-context.js";
import { mapStoredEngine } from "./partner-engine-storage.js";
import { workbenchWorkspaceDisplayName } from "../../domain/workbench/workbench-naming.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function required(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("workbench_detail_record_invalid");
  return value;
}

export class SqliteWorkbenchManagementRepository implements WorkbenchManagementRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getDetail(workbenchId: string): Promise<WorkbenchDetailDto | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare(`SELECT a.workbench_id, a.name, a.persona_revision_id, a.scope_summary,
        a.project_label, a.updated_at, b.kind AS workspace_kind, b.status AS workspace_status,
        b.display_name AS workspace_display_name, b.failure_reason_code
        FROM workbenches a JOIN workbench_workspace_bindings b ON b.workbench_id = a.workbench_id
        WHERE a.workbench_id = ? AND a.status = 'ACTIVE'`).get(workbenchId) as Row | undefined;
      if (row === undefined) return null;
      const activeWork = connection.prepare(`SELECT work_id, workbench_id, title, status FROM work_items
        WHERE workbench_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING') ORDER BY created_at, work_id`).all(workbenchId).map((value) => {
        const item = value as Row;
        return { workbenchId: required(item, "workbench_id"), status: required(item, "status") as WorkbenchDetailDto["activeWork"][number]["status"], title: required(item, "title"), workId: required(item, "work_id") };
      });
      const recentResults = connection.prepare(`SELECT result_id, work_id, partner_revision_id, status, summary, is_late, created_at
        FROM work_results WHERE workbench_id = ? ORDER BY created_at DESC, result_id DESC LIMIT 10`).all(workbenchId).map((value) => {
        const item = value as Row;
        return {
          createdAt: required(item, "created_at"),
          isLate: item.is_late === 1,
          partnerRevisionId: required(item, "partner_revision_id"),
          resultId: required(item, "result_id"),
          status: required(item, "status") as WorkbenchDetailDto["recentResults"][number]["status"],
          summary: required(item, "summary"),
          workId: required(item, "work_id"),
        };
      });
      const instances = connection.prepare(`SELECT i.instance_id, i.partner_id, i.session_policy, i.status, i.engine,
        i.cli_protocol, i.last_used_at, r.display_name FROM partner_instances i
        JOIN partners p ON p.partner_id = i.partner_id
        JOIN partner_revisions r ON r.partner_revision_id = p.active_revision_id
        WHERE i.workbench_id = ? AND i.status <> 'DISPOSED' ORDER BY i.last_used_at DESC`).all(workbenchId).map((value) => {
        const item = value as Row;
        return {
          engine: mapStoredEngine(item.engine, item.cli_protocol),
          instanceId: required(item, "instance_id"),
          lastUsedAt: required(item, "last_used_at"),
          partnerId: required(item, "partner_id"),
          partnerName: required(item, "display_name"),
          sessionPolicy: required(item, "session_policy") as "EPHEMERAL" | "RESIDENT",
          status: required(item, "status") as "BUSY" | "IDLE",
        };
      });
      return {
        activeWork,
        workbenchId: required(row, "workbench_id"),
        instances,
        name: required(row, "name"),
        personaRevisionId: required(row, "persona_revision_id"),
        projectLabel: required(row, "project_label"),
        recentResults,
        responsibility: required(row, "scope_summary"),
        updatedAt: required(row, "updated_at"),
        workspace: {
          displayName: required(row, "workspace_display_name"),
          ...(typeof row.failure_reason_code === "string" ? { failureReasonCode: row.failure_reason_code } : {}),
          kind: required(row, "workspace_kind") as "BOUND" | "MANAGED",
          status: required(row, "workspace_status") as "FAILED" | "PROVISIONING" | "READY",
        },
      };
    });
  }

  async updateContext(input: { workbenchId: string; name?: string; personaBody?: string; personaRevisionId?: string; projectLabel?: string; responsibility?: string; updatedAt: string }): Promise<WorkbenchDetailDto | null> {
    this.database.transaction((connection) => {
      const current = connection.prepare("SELECT persona_revision_id FROM workbenches WHERE workbench_id = ? AND status = 'ACTIVE'").get(input.workbenchId);
      if (current === undefined) return;
      if (input.personaBody !== undefined && input.personaRevisionId !== undefined) {
        connection.prepare(`INSERT INTO workbench_persona_revisions (persona_revision_id, workbench_id, body, created_at)
          VALUES (?, ?, ?, ?)`).run(input.personaRevisionId, input.workbenchId, input.personaBody, input.updatedAt);
      }
      connection.prepare(`UPDATE workbenches SET name = COALESCE(?, name), project_label = COALESCE(?, project_label),
        scope_summary = COALESCE(?, scope_summary), persona_revision_id = COALESCE(?, persona_revision_id),
        persona_summary = COALESCE(?, persona_summary), updated_at = ? WHERE workbench_id = ? AND status = 'ACTIVE'`).run(
        input.name ?? null, input.projectLabel ?? null, input.responsibility ?? null, input.personaRevisionId ?? null,
        input.personaBody ?? null, input.updatedAt, input.workbenchId,
      );
      if (input.name !== undefined || input.projectLabel !== undefined || input.responsibility !== undefined) {
        const context = connection.prepare("SELECT name, project_label, scope_summary FROM workbenches WHERE workbench_id = ?").get(input.workbenchId) as { name?: unknown; project_label?: unknown; scope_summary?: unknown } | undefined;
        if (typeof context?.name === "string" && typeof context.project_label === "string" && typeof context.scope_summary === "string") {
          connection.prepare(`UPDATE workbench_workspace_bindings SET display_name = ?, updated_at = ?
            WHERE workbench_id = ? AND kind = 'MANAGED'`).run(workbenchWorkspaceDisplayName({ name: context.name, projectLabel: context.project_label, scopeSummary: context.scope_summary }), input.updatedAt, input.workbenchId);
        }
      }
    });
    return this.getDetail(input.workbenchId);
  }
}
