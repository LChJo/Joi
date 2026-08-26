/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";

import type { AgentConversationPageDto, WorkbenchAgentCardDto, WorkbenchAgentStatusDto } from "../../../shared/joi.js";
import type { WorkbenchAgentRepository } from "../../application/ports/workbench-agents.js";
import type { NormalizedAgentConversationEntry } from "../../application/partners/agent-conversation-presentation.js";
import { DomainError } from "../../domain/errors.js";
import { mapStoredEngine } from "./partner-engine-storage.js";

interface TransactionalDatabase { transaction<T>(operation: (database: DatabaseSync) => T): T }
type Row = Record<string, unknown>;

function required(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("workbench_agent_record_invalid");
  return value;
}

function mapStatus(row: Row): WorkbenchAgentStatusDto {
  if (row.goal_execution_status === "RUNNING") return "RUNNING";
  if (row.goal_execution_status === "WAITING_INPUT" || row.goal_execution_status === "WAITING_AUTH") return "WAITING";
  if (row.goal_execution_status === "COMPLETED") return "COMPLETED";
  if (row.goal_execution_status === "FAILED") return "FAILED";
  if (row.goal_execution_status === "UNKNOWN") return "UNKNOWN";
  if (row.backing_kind === "LOCAL_INSTANCE") {
    if (row.execution_status === "RUNNING") return "RUNNING";
    if (row.execution_status === "WAITING_INPUT" || row.execution_status === "WAITING_AUTH") return "WAITING";
    if (row.runtime_status === "BUSY") return "RUNNING";
    if (row.runtime_status === "IDLE") return "IDLE";
    const reason = typeof row.disposal_reason === "string" ? row.disposal_reason : "";
    if (reason.includes("failed") || reason === "crash") return "FAILED";
    if (reason.includes("cancel")) return "CANCELED";
    return "COMPLETED";
  }
  if (row.runtime_status === "RUNNING") return "RUNNING";
  if (row.runtime_status === "WAITING_INPUT" || row.runtime_status === "WAITING_AUTH") return "WAITING";
  if (row.runtime_status === "COMPLETED") return "COMPLETED";
  if (row.runtime_status === "FAILED") return "FAILED";
  return "UNKNOWN";
}

function terminal(status: WorkbenchAgentStatusDto): boolean {
  return ["COMPLETED", "FAILED", "CANCELED", "UNKNOWN"].includes(status);
}

function mapCard(row: Row): WorkbenchAgentCardDto {
  const status = mapStatus(row);
  const engine = row.backing_kind === "A2A_RUN" ? "pi-core" : mapStoredEngine(row.engine, row.cli_protocol);
  return {
    agentId: required(row, "agent_id"),
    workbenchId: required(row, "workbench_id"),
    canDelete: row.session_policy === "EPHEMERAL" && terminal(status),
    createdAt: required(row, "created_at"),
    engine,
    lastActivityAt: required(row, "last_activity_at"),
    partnerId: required(row, "partner_id"),
    partnerName: required(row, "partner_name"),
    sessionPolicy: required(row, "session_policy") as WorkbenchAgentCardDto["sessionPolicy"],
    status,
    transport: row.backing_kind === "A2A_RUN" ? "A2A" : "LOCAL",
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DomainError("workbench_agent_cursor_invalid", "Agent cursor is invalid.");
  return parsed;
}

function cardSelect(goalScoped: boolean): string {
  return `SELECT s.agent_id, s.workbench_id, s.partner_id, s.backing_kind, s.backing_id,
  s.session_policy, s.created_at, r.display_name AS partner_name,
  i.status AS runtime_status, i.engine, i.cli_protocol, i.last_used_at, i.disposal_reason,
  pr.updated_at AS run_updated_at,
  CASE
    WHEN s.backing_kind = 'LOCAL_INSTANCE' AND EXISTS (
      SELECT 1 FROM partner_runs lr JOIN dispatch_attempts la ON la.dispatch_attempt_id = lr.dispatch_attempt_id
      WHERE la.instance_id = s.backing_id AND lr.status = 'RUNNING'
    ) THEN 'RUNNING'
    WHEN s.backing_kind = 'LOCAL_INSTANCE' AND EXISTS (
      SELECT 1 FROM partner_runs lr JOIN dispatch_attempts la ON la.dispatch_attempt_id = lr.dispatch_attempt_id
      WHERE la.instance_id = s.backing_id AND lr.status IN ('WAITING_INPUT', 'WAITING_AUTH')
    ) THEN 'WAITING_INPUT'
    ELSE NULL
  END AS execution_status,
  (SELECT MAX(lr.updated_at) FROM partner_runs lr
    JOIN dispatch_attempts la ON la.dispatch_attempt_id = lr.dispatch_attempt_id
    WHERE s.backing_kind = 'LOCAL_INSTANCE' AND la.instance_id = s.backing_id) AS execution_updated_at,
  ${goalScoped ? `(SELECT gr.status FROM partner_runs gr
    JOIN dispatch_attempts ga ON ga.dispatch_attempt_id = gr.dispatch_attempt_id
    JOIN work_items gw ON gw.work_id = gr.work_id
    WHERE gw.input_id = ? AND (
      (s.backing_kind = 'LOCAL_INSTANCE' AND ga.instance_id = s.backing_id)
      OR (s.backing_kind = 'A2A_RUN' AND gr.run_id = s.backing_id)
    )
    ORDER BY CASE WHEN gr.status IN ('RUNNING', 'WAITING_INPUT', 'WAITING_AUTH') THEN 0 ELSE 1 END,
      gr.created_at DESC, gr.run_id DESC LIMIT 1)` : "NULL"} AS goal_execution_status
  FROM workbench_agent_sessions s
  JOIN partner_revisions r ON r.partner_revision_id = s.partner_revision_id
  LEFT JOIN partner_instances i ON s.backing_kind = 'LOCAL_INSTANCE' AND i.instance_id = s.backing_id
  LEFT JOIN partner_runs pr ON s.backing_kind = 'A2A_RUN' AND pr.run_id = s.backing_id`;
}

function cardRows(connection: DatabaseSync, workbenchId: string, limit: number, offset: number, agentId?: string, goalId?: string): Row[] {
  const clause = `${agentId === undefined ? "" : " AND s.agent_id = ?"}${goalId === undefined ? "" : ` AND EXISTS (
    SELECT 1 FROM dispatch_attempts da JOIN work_items dw ON dw.work_id = da.work_id
      WHERE s.backing_kind = 'LOCAL_INSTANCE' AND da.instance_id = s.backing_id AND dw.input_id = ?
    UNION ALL
    SELECT 1 FROM partner_runs pr JOIN work_items pw ON pw.work_id = pr.work_id
      WHERE s.backing_kind = 'A2A_RUN' AND pr.run_id = s.backing_id AND pw.input_id = ?)`}`;
  const values: (number | string)[] = [];
  if (goalId !== undefined) values.push(goalId);
  values.push(workbenchId);
  if (agentId !== undefined) values.push(agentId);
  if (goalId !== undefined) values.push(goalId, goalId);
  values.push(limit, offset);
  const rows = connection.prepare(`${cardSelect(goalId !== undefined)}
    WHERE s.workbench_id = ? AND s.dismissed_at IS NULL${clause}
    ORDER BY s.created_at DESC, s.agent_id DESC LIMIT ? OFFSET ?`).all(...values) as Row[];
  return rows.map((row) => ({
    ...row,
    last_activity_at: typeof row.last_used_at === "string" ? row.last_used_at
      : typeof row.execution_updated_at === "string" ? row.execution_updated_at
        : typeof row.run_updated_at === "string" ? row.run_updated_at : row.created_at,
  }));
}

export class SqliteWorkbenchAgentRepository implements WorkbenchAgentRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async listAgents(input: { workbenchId: string; cursor?: string; goalId?: string; limit: number }): Promise<{ items: WorkbenchAgentCardDto[]; nextCursor?: string }> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const offset = decodeCursor(input.cursor);
    const rows = this.database.transaction((connection) => cardRows(connection, input.workbenchId, limit + 1, offset, undefined, input.goalId));
    const items = rows.slice(0, limit).map(mapCard);
    return { items, ...(rows.length > limit ? { nextCursor: encodeCursor(offset + limit) } : {}) };
  }

  async append(agentId: string, entries: NormalizedAgentConversationEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.database.transaction((connection) => {
      const base = connection.prepare("SELECT COALESCE(MAX(sequence), -1) AS value FROM workbench_agent_conversation_entries WHERE agent_id = ?")
        .get(agentId) as { value?: unknown } | undefined;
      const start = typeof base?.value === "number" ? base.value + 1 : 0;
      const insert = connection.prepare(`INSERT OR IGNORE INTO workbench_agent_conversation_entries
        (entry_id, agent_id, run_id, sequence, role, kind, text, tool_name, artifact_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const entry of entries) insert.run(
        entry.entryId, agentId, entry.runId, start + entry.order,
        entry.role, entry.kind, entry.text ?? null, entry.toolName ?? null,
        entry.artifact === undefined ? null : JSON.stringify(entry.artifact), entry.createdAt,
      );
    });
  }

  async conversation(input: { agentId: string; workbenchId: string; cursor?: string; limit: number }): Promise<AgentConversationPageDto> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const offset = decodeCursor(input.cursor);
    return this.database.transaction((connection) => {
      const cardRow = cardRows(connection, input.workbenchId, 1, 0, input.agentId)[0];
      if (cardRow === undefined) throw new DomainError("workbench_agent_not_found", "Agent was not found.");
      const rows = connection.prepare(`SELECT entry_id, sequence, role, kind, text, tool_name, artifact_json, created_at
        FROM workbench_agent_conversation_entries WHERE agent_id = ? ORDER BY sequence, entry_id LIMIT ? OFFSET ?`)
        .all(input.agentId, limit + 1, offset) as Row[];
      const items = rows.slice(0, limit).map((row) => {
        const artifact = typeof row.artifact_json === "string" ? JSON.parse(row.artifact_json) as { mimeType: string; name: string; size: number } : undefined;
        return {
          ...(artifact === undefined ? {} : { artifact }),
          createdAt: required(row, "created_at"),
          entryId: required(row, "entry_id"),
          kind: required(row, "kind") as AgentConversationPageDto["items"][number]["kind"],
          role: required(row, "role") as AgentConversationPageDto["items"][number]["role"],
          sequence: typeof row.sequence === "number" ? row.sequence : 0,
          ...(typeof row.text === "string" ? { text: row.text } : {}),
          ...(typeof row.tool_name === "string" ? { toolName: row.tool_name } : {}),
        };
      });
      return { agent: mapCard(cardRow), items, ...(rows.length > limit ? { nextCursor: encodeCursor(offset + limit) } : {}) };
    });
  }

  async dismiss(input: { agentId: string; workbenchId: string; dismissedAt: string }): Promise<void> {
    this.database.transaction((connection) => {
      const row = cardRows(connection, input.workbenchId, 1, 0, input.agentId)[0];
      if (row === undefined) throw new DomainError("workbench_agent_not_found", "Agent was not found.");
      if (row.session_policy !== "EPHEMERAL") throw new DomainError("workbench_agent_resident_delete_forbidden", "Resident Agents cannot be deleted.");
      if (!terminal(mapStatus(row))) throw new DomainError("workbench_agent_not_terminal", "Agent is still running.");
      connection.prepare("DELETE FROM workbench_agent_conversation_entries WHERE agent_id = ?").run(input.agentId);
      connection.prepare("UPDATE workbench_agent_sessions SET dismissed_at = ? WHERE agent_id = ? AND workbench_id = ?")
        .run(input.dismissedAt, input.agentId, input.workbenchId);
    });
  }
}
