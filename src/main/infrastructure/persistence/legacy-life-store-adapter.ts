/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { AvatarRepository, AvatarSummary, LegacyAvatarPolicyReader } from "../../application/ports/avatar-context.js";
import { createAvatar, type Avatar } from "../../domain/avatar/avatar.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

const requiredText = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw new Error("legacy_avatar_mapping_invalid");
  return value;
};

export class LegacyLifeStoreAdapter implements AvatarRepository, LegacyAvatarPolicyReader {
  constructor(private readonly database: TransactionalDatabase) {}

  async getAvatar(avatarId: string): Promise<Avatar | null> {
    const row = this.database.transaction((connection) => connection.prepare(`
      SELECT avatar_id, name, created_at, updated_at, persona_revision_id, persona_summary,
             scope_summary, project_label, workspace_ref, memory_namespace_id, task_summary
        FROM avatars WHERE avatar_id = ? AND status = 'ACTIVE'`).get(avatarId)) as Row | undefined;
    if (row === undefined) return null;
    const id = requiredText(row, "avatar_id");
    const name = requiredText(row, "name");
    return createAvatar({
      avatarId: id,
      createdAt: requiredText(row, "created_at"),
      memoryNamespaceId: requiredText(row, "memory_namespace_id"),
      name,
      personaRevisionId: requiredText(row, "persona_revision_id"),
      personaSummary: requiredText(row, "persona_summary"),
      project: {
        label: requiredText(row, "project_label"),
        ...(typeof row.workspace_ref === "string" ? { workspaceRef: row.workspace_ref } : {}),
      },
      scopeSummary: requiredText(row, "scope_summary"),
      taskContext: { activeWorkIds: [], summary: requiredText(row, "task_summary") },
    });
  }

  async listSummaries(): Promise<AvatarSummary[]> {
    return this.database.transaction((connection) => connection.prepare(`
      SELECT avatar_id, name, scope_summary, updated_at FROM avatars WHERE status = 'ACTIVE'
       ORDER BY updated_at DESC, avatar_id`).all()).map((value) => {
      const row = value as Row;
      return {
        avatarId: requiredText(row, "avatar_id"),
        name: requiredText(row, "name"),
        scopeSummary: requiredText(row, "scope_summary"),
        updatedAt: requiredText(row, "updated_at"),
      };
    });
  }

  async createAvatar(avatar: Avatar): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`INSERT INTO avatars
      (avatar_id, legacy_life_id, name, persona_revision_id, persona_summary, scope_summary,
       project_label, workspace_ref, memory_namespace_id, task_summary, status, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
    ).run(
      avatar.avatarId, avatar.profile.name, avatar.profile.personaRevisionId, avatar.profile.personaSummary,
      avatar.profile.scopeSummary, avatar.project.label, avatar.project.workspaceRef ?? null,
      avatar.memory.namespaceId, avatar.taskContext.summary, avatar.createdAt, avatar.updatedAt,
    ));
  }

  async getPreferredPartnerId(avatarId: string): Promise<string | null> {
    const mapped = this.database.transaction((connection) => connection.prepare(
      "SELECT preferred_partner_id FROM avatar_partner_policies WHERE avatar_id = ?",
    ).get(avatarId)) as Row | undefined;
    if (typeof mapped?.preferred_partner_id === "string") return mapped.preferred_partner_id;
    const legacy = this.database.transaction((connection) => connection.prepare(
      "SELECT main_agent_connection_id FROM lives WHERE life_id = ?",
    ).get(avatarId)) as Row | undefined;
    return typeof legacy?.main_agent_connection_id === "string" ? `partner_${legacy.main_agent_connection_id}` : null;
  }
}
