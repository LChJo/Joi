/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { AvatarDetailDto } from "../../../shared/joi.js";
import type { AvatarManagementRepository } from "../../application/ports/avatar-context.js";
import { mapStoredEngine } from "./partner-engine-storage.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function required(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("avatar_detail_record_invalid");
  return value;
}

export class SqliteAvatarManagementRepository implements AvatarManagementRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getDetail(avatarId: string): Promise<AvatarDetailDto | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare(`SELECT a.avatar_id, a.name, a.persona_revision_id, a.scope_summary,
        a.project_label, a.updated_at, b.kind AS workspace_kind, b.status AS workspace_status,
        b.display_name AS workspace_display_name, b.failure_reason_code
        FROM avatars a JOIN avatar_workspace_bindings b ON b.avatar_id = a.avatar_id
        WHERE a.avatar_id = ? AND a.status = 'ACTIVE'`).get(avatarId) as Row | undefined;
      if (row === undefined) return null;
      const activeWork = connection.prepare(`SELECT work_id, avatar_id, title, status FROM work_items
        WHERE avatar_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING') ORDER BY created_at, work_id`).all(avatarId).map((value) => {
        const item = value as Row;
        return { avatarId: required(item, "avatar_id"), status: required(item, "status") as AvatarDetailDto["activeWork"][number]["status"], title: required(item, "title"), workId: required(item, "work_id") };
      });
      const recentResults = connection.prepare(`SELECT result_id, work_id, partner_revision_id, status, summary, is_late, created_at
        FROM work_results WHERE avatar_id = ? ORDER BY created_at DESC, result_id DESC LIMIT 10`).all(avatarId).map((value) => {
        const item = value as Row;
        return {
          createdAt: required(item, "created_at"),
          isLate: item.is_late === 1,
          partnerRevisionId: required(item, "partner_revision_id"),
          resultId: required(item, "result_id"),
          status: required(item, "status") as AvatarDetailDto["recentResults"][number]["status"],
          summary: required(item, "summary"),
          workId: required(item, "work_id"),
        };
      });
      const instances = connection.prepare(`SELECT i.instance_id, i.partner_id, i.session_policy, i.status, i.engine,
        i.cli_protocol, i.last_used_at, r.display_name FROM partner_instances i
        JOIN partners p ON p.partner_id = i.partner_id
        JOIN partner_revisions r ON r.partner_revision_id = p.active_revision_id
        WHERE i.avatar_id = ? AND i.status <> 'DISPOSED' ORDER BY i.last_used_at DESC`).all(avatarId).map((value) => {
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
        avatarId: required(row, "avatar_id"),
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

  async updateContext(input: { avatarId: string; name?: string; personaBody?: string; personaRevisionId?: string; projectLabel?: string; responsibility?: string; updatedAt: string }): Promise<AvatarDetailDto | null> {
    this.database.transaction((connection) => {
      const current = connection.prepare("SELECT persona_revision_id FROM avatars WHERE avatar_id = ? AND status = 'ACTIVE'").get(input.avatarId);
      if (current === undefined) return;
      if (input.personaBody !== undefined && input.personaRevisionId !== undefined) {
        connection.prepare(`INSERT INTO avatar_persona_revisions (persona_revision_id, avatar_id, body, created_at)
          VALUES (?, ?, ?, ?)`).run(input.personaRevisionId, input.avatarId, input.personaBody, input.updatedAt);
      }
      connection.prepare(`UPDATE avatars SET name = COALESCE(?, name), project_label = COALESCE(?, project_label),
        scope_summary = COALESCE(?, scope_summary), persona_revision_id = COALESCE(?, persona_revision_id),
        persona_summary = COALESCE(?, persona_summary), updated_at = ? WHERE avatar_id = ? AND status = 'ACTIVE'`).run(
        input.name ?? null, input.projectLabel ?? null, input.responsibility ?? null, input.personaRevisionId ?? null,
        input.personaBody ?? null, input.updatedAt, input.avatarId,
      );
      if (input.name !== undefined) connection.prepare(`UPDATE avatar_workspace_bindings
        SET display_name = ? || ' 工作区', updated_at = ? WHERE avatar_id = ? AND kind = 'MANAGED'`)
        .run(input.name, input.updatedAt, input.avatarId);
    });
    return this.getDetail(input.avatarId);
  }
}
