/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import { Buffer } from "node:buffer";
import { realpath, stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type { AgentConversationPageDto, WorkbenchAgentCardDto, WorkbenchAgentStatusDto, WorkbenchArtifactDto, WorkbenchToolTraceDto } from "../../../shared/joi.js";
import type { WorkbenchAgentRepository, WorkbenchToolTraceInput, WorkbenchToolTraceRevealInput } from "../../application/ports/workbench-agents.js";
import type { ResolvedWorkbenchArtifact, WorkbenchArtifactResolutionInput } from "../../application/ports/workbench-artifacts.js";
import type { NormalizedAgentConversationEntry } from "../../application/partners/agent-conversation-presentation.js";
import { stripPathRedactions } from "../../application/partners/agent-conversation-presentation.js";
import { TOOL_TRACE_MAX_BODY_CHARS } from "../../application/partners/tool-trace-presentation.js";
import { DomainError } from "../../domain/errors.js";
import { workResultArtifactId, workspaceArtifactDirectory, workspaceArtifactRelativePath } from "../../domain/work/workspace-artifact-reference.js";
import { mapStoredEngine } from "./partner-engine-storage.js";

interface TransactionalDatabase { transaction<T>(operation: (database: DatabaseSync) => T): T }
type Row = Record<string, unknown>;

interface StoredConversationArtifact {
  artifactRef?: string;
  mimeType: string;
  name: string;
  size: number;
}

function storedArtifact(value: unknown): StoredConversationArtifact | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.mimeType !== "string" || typeof parsed.name !== "string" || typeof parsed.size !== "number") return undefined;
    return {
      ...(typeof parsed.artifactRef === "string" ? { artifactRef: parsed.artifactRef } : {}),
      mimeType: parsed.mimeType,
      name: parsed.name,
      size: parsed.size,
    };
  } catch {
    return undefined;
  }
}

function publicArtifact(artifact: StoredConversationArtifact, artifactId: string): WorkbenchArtifactDto {
  const relativePath = workspaceArtifactRelativePath(artifact.artifactRef);
  const isDirectory = artifact.mimeType === "inode/directory";
  const directory = relativePath === undefined ? undefined : isDirectory ? relativePath : workspaceArtifactDirectory(relativePath);
  return {
    ...(relativePath === undefined ? {} : { artifactId }),
    ...(directory === undefined ? {} : { directory }),
    kind: isDirectory ? "DIRECTORY" : "FILE",
    mimeType: artifact.mimeType,
    name: artifact.name,
    size: artifact.size,
  };
}

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

function historyBoundary(cursor: string | undefined): [number, string] | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0]) && value[0] >= 0 && typeof value[1] === "string") return value as [number, string];
  } catch { /* reject malformed or legacy cursors in history mode */ }
  throw new DomainError("workbench_agent_cursor_invalid", "Agent cursor is invalid.");
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
        (entry_id, agent_id, run_id, sequence, role, kind, text, tool_name, tool_call_id, artifact_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const entry of entries) insert.run(
        entry.entryId, agentId, entry.runId, start + entry.order,
        entry.role, entry.kind, entry.text ?? null, entry.toolName ?? null, entry.toolCallId ?? null,
        entry.artifact === undefined ? null : JSON.stringify(entry.artifact), entry.createdAt,
      );
    });
  }

  async appendToolTrace(input: WorkbenchToolTraceInput): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`INSERT OR REPLACE INTO workbench_agent_tool_traces
        (agent_id, run_id, tool_call_id, tool_name, command, result, is_error, truncated, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.agentId, input.runId, input.trace.toolCallId.slice(0, 200), input.trace.toolName,
        input.trace.command, input.trace.result, input.trace.isError ? 1 : 0,
        input.trace.truncated ? 1 : 0, input.createdAt,
      );
    });
  }

  async replaceRun(agentId: string, runId: string, entries: NormalizedAgentConversationEntry[]): Promise<void> {
    this.database.transaction((connection) => {
      const existing = connection.prepare("SELECT entry_id FROM workbench_agent_conversation_entries WHERE agent_id = ? AND run_id = ?").all(agentId, runId) as Row[];
      const retained = new Set(entries.map(entry => entry.entryId));
      const remove = connection.prepare("DELETE FROM workbench_agent_conversation_entries WHERE agent_id = ? AND run_id = ? AND entry_id = ?");
      for (const row of existing) if (!retained.has(required(row, "entry_id"))) remove.run(agentId, runId, required(row, "entry_id"));
      const known = new Set(existing.map(row => required(row, "entry_id")));
      const base = connection.prepare("SELECT COALESCE(MAX(sequence), -1) AS value FROM workbench_agent_conversation_entries WHERE agent_id = ?")
        .get(agentId) as { value?: unknown } | undefined;
      let sequence = typeof base?.value === "number" ? base.value + 1 : 0;
      const insert = connection.prepare(`INSERT INTO workbench_agent_conversation_entries
        (entry_id, agent_id, run_id, sequence, role, kind, text, tool_name, tool_call_id, artifact_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      // `tool_call_id` must stay inside the change guard: an entry persisted before this
      // column existed carries NULL, and without the comparison the live snapshot would
      // never backfill the id and the reveal affordance would silently stay missing.
      const update = connection.prepare(`UPDATE workbench_agent_conversation_entries
        SET role = ?, kind = ?, text = ?, tool_name = ?, tool_call_id = ?, artifact_json = ?, created_at = ?
        WHERE agent_id = ? AND run_id = ? AND entry_id = ?
        AND (role IS NOT ? OR kind IS NOT ? OR text IS NOT ? OR tool_name IS NOT ? OR tool_call_id IS NOT ? OR artifact_json IS NOT ? OR created_at IS NOT ?)`);
      for (const entry of entries) {
        const values = [entry.role, entry.kind, entry.text ?? null, entry.toolName ?? null, entry.toolCallId ?? null,
          entry.artifact === undefined ? null : JSON.stringify(entry.artifact), entry.createdAt];
        if (known.has(entry.entryId)) update.run(...values, agentId, runId, entry.entryId, ...values);
        else insert.run(entry.entryId, agentId, runId, sequence++, ...values);
      }
    });
  }

  async revealToolTrace(input: WorkbenchToolTraceRevealInput): Promise<WorkbenchToolTraceDto> {
    const row = this.database.transaction((connection) => {
      // Same gate shape as resolveArtifact: prove the agent belongs to this workbench first.
      const card = cardRows(connection, input.workbenchId, 1, 0, input.agentId)[0];
      if (card === undefined) throw new DomainError("workbench_agent_not_found", "Agent was not found.");
      // The join to a visible TOOL_CALL entry is the authorization link: a trace is only
      // readable while its call is still part of this agent's conversation.
      return connection.prepare(`SELECT t.command, t.is_error, t.result, t.tool_name, t.truncated
        FROM workbench_agent_tool_traces t
        JOIN workbench_agent_conversation_entries e
          ON e.agent_id = t.agent_id AND e.run_id = t.run_id AND e.tool_call_id = t.tool_call_id
        WHERE t.agent_id = ? AND t.tool_call_id = ? AND e.kind = 'TOOL_CALL'
        ORDER BY e.sequence DESC LIMIT 1`).get(input.agentId, input.toolCallId);
    });
    if (row === undefined) throw new DomainError("workbench_tool_trace_not_found", "This tool call has no stored output.");
    return {
      // Defensive re-clamp: rows written under an older or larger budget still leave bounded.
      command: String(row.command).slice(0, TOOL_TRACE_MAX_BODY_CHARS),
      isError: row.is_error === 1,
      result: String(row.result).slice(0, TOOL_TRACE_MAX_BODY_CHARS),
      toolCallId: input.toolCallId,
      toolName: String(row.tool_name),
      truncated: row.truncated === 1,
    };
  }

  async conversation(input: { agentId: string; workbenchId: string; goalId?: string; cursor?: string; latest?: boolean; limit: number }): Promise<AgentConversationPageDto> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const offset = input.latest ? 0 : decodeCursor(input.cursor);
    const boundary = input.latest ? historyBoundary(input.cursor) : undefined;
    return this.database.transaction((connection) => {
      const cardRow = cardRows(connection, input.workbenchId, 1, 0, input.agentId, input.goalId)[0];
      if (cardRow === undefined) throw new DomainError("workbench_agent_not_found", "Agent was not found.");
      const scope = input.goalId === undefined ? "" : ` AND run_id IN (
        SELECT pr.run_id FROM partner_runs pr JOIN work_items w ON w.work_id = pr.work_id
        WHERE w.input_id = ? AND w.workbench_id = ?)`;
      const rows = connection.prepare(`SELECT entry_id, sequence, role, kind, text, tool_name, tool_call_id, artifact_json, created_at
        FROM workbench_agent_conversation_entries WHERE agent_id = ?${scope}${boundary === undefined ? "" : " AND (sequence, entry_id) < (?, ?)"}
        ORDER BY sequence ${input.latest ? "DESC" : "ASC"}, entry_id ${input.latest ? "DESC" : "ASC"} LIMIT ? OFFSET ?`)
        .all(input.agentId, ...(input.goalId === undefined ? [] : [input.goalId, input.workbenchId]), ...(boundary ?? []), limit + 1, offset) as Row[];
      const items = rows.slice(0, limit).map((row) => {
        const artifact = storedArtifact(row.artifact_json);
        const entryId = required(row, "entry_id");
        return {
          ...(artifact === undefined ? {} : { artifact: publicArtifact(artifact, entryId) }),
          createdAt: required(row, "created_at"),
          entryId,
          kind: required(row, "kind") as AgentConversationPageDto["items"][number]["kind"],
          role: required(row, "role") as AgentConversationPageDto["items"][number]["role"],
          sequence: typeof row.sequence === "number" ? row.sequence : 0,
          ...(typeof row.text === "string" ? { text: stripPathRedactions(row.text) } : {}),
          ...(typeof row.tool_call_id === "string" ? { toolCallId: row.tool_call_id } : {}),
          ...(typeof row.tool_name === "string" ? { toolName: row.tool_name } : {}),
        };
      });
      const last = items.at(-1);
      const nextCursor = input.latest && last !== undefined
        ? Buffer.from(JSON.stringify([last.sequence, last.entryId]), "utf8").toString("base64url") : encodeCursor(offset + limit);
      if (input.latest) items.reverse();
      return { agent: mapCard(cardRow), items, ...(rows.length > limit ? { nextCursor } : {}) };
    });
  }

  async resolveArtifact(input: WorkbenchArtifactResolutionInput): Promise<ResolvedWorkbenchArtifact> {
    const stored = this.database.transaction((connection) => {
      let artifact: StoredConversationArtifact | undefined;
      let workId: string | undefined;
      if (input.source === "AGENT") {
        const card = cardRows(connection, input.workbenchId, 1, 0, input.sourceId)[0];
        if (card === undefined) return undefined;
        const row = connection.prepare(`SELECT e.artifact_json, pr.work_id FROM workbench_agent_conversation_entries e
          LEFT JOIN partner_runs pr ON pr.run_id = e.run_id
          WHERE e.agent_id = ? AND e.entry_id = ? AND e.kind = 'ARTIFACT'`).get(input.sourceId, input.artifactId) as Row | undefined;
        artifact = storedArtifact(row?.artifact_json);
        if (typeof row?.work_id === "string") workId = row.work_id;
      } else {
        const rows = connection.prepare(`SELECT r.result_id, r.artifacts_json, r.work_id FROM work_results r
          JOIN work_items w ON w.work_id = r.work_id
          WHERE r.workbench_id = ? AND w.input_id = ? AND r.is_authoritative = 1 AND r.status = 'COMPLETED'
          ORDER BY r.created_at, r.result_id`).all(input.workbenchId, input.sourceId) as Row[];
        for (const row of rows) {
          if (typeof row.result_id !== "string" || typeof row.artifacts_json !== "string") continue;
          let artifacts: unknown;
          try { artifacts = JSON.parse(row.artifacts_json); } catch { continue; }
          if (!Array.isArray(artifacts)) continue;
          const index = artifacts.findIndex((_candidate, artifactIndex) => workResultArtifactId(row.result_id as string, artifactIndex) === input.artifactId);
          if (index < 0) continue;
          artifact = storedArtifact(JSON.stringify(artifacts[index]));
          if (typeof row.work_id === "string") workId = row.work_id;
          break;
        }
      }
      const relativePath = workspaceArtifactRelativePath(artifact?.artifactRef);
      if (relativePath === undefined) return undefined;
      const runRoot = connection.prepare(`SELECT root_path FROM work_run_directories
        WHERE work_id = ? AND workbench_id = ? AND status = 'READY'`).get(workId ?? "", input.workbenchId) as Row | undefined;
      const root = runRoot ?? connection.prepare(`SELECT roots.root_path FROM workbench_workspace_bindings binding
        JOIN workbench_workspace_roots roots ON roots.workspace_ref = binding.workspace_ref
        WHERE binding.workbench_id = ? AND binding.status = 'READY'`).get(input.workbenchId);
      if (typeof root?.root_path !== "string") return undefined;
      return { relativePath, rootPath: root.root_path };
    });
    if (stored === undefined) throw new DomainError("workbench_artifact_unavailable", "This artifact is not available to open.");
    try {
      const canonicalRoot = await realpath(stored.rootPath);
      const candidate = path.resolve(canonicalRoot, ...stored.relativePath.split("/"));
      const candidateRelative = path.relative(canonicalRoot, candidate);
      if (candidateRelative === "" || candidateRelative.startsWith("..") || path.isAbsolute(candidateRelative)) throw new Error("outside_workspace");
      const canonicalTarget = await realpath(candidate);
      const targetRelative = path.relative(canonicalRoot, canonicalTarget);
      if (targetRelative === "" || targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new Error("outside_workspace");
      const facts = await stat(canonicalTarget);
      if (!facts.isFile() && !facts.isDirectory()) throw new Error("unsupported_artifact");
      return { kind: facts.isDirectory() ? "DIRECTORY" : "FILE", targetPath: canonicalTarget };
    } catch {
      throw new DomainError("workbench_artifact_unavailable", "This artifact is not available to open.");
    }
  }

  async dismiss(input: { agentId: string; workbenchId: string; dismissedAt: string }): Promise<void> {
    this.database.transaction((connection) => {
      const row = cardRows(connection, input.workbenchId, 1, 0, input.agentId)[0];
      if (row === undefined) throw new DomainError("workbench_agent_not_found", "Agent was not found.");
      if (row.session_policy !== "EPHEMERAL") throw new DomainError("workbench_agent_resident_delete_forbidden", "Resident Agents cannot be deleted.");
      if (!terminal(mapStatus(row))) throw new DomainError("workbench_agent_not_terminal", "Agent is still running.");
      connection.prepare("DELETE FROM workbench_agent_tool_traces WHERE agent_id = ?").run(input.agentId);
      connection.prepare("DELETE FROM workbench_agent_conversation_entries WHERE agent_id = ?").run(input.agentId);
      connection.prepare("UPDATE workbench_agent_sessions SET dismissed_at = ? WHERE agent_id = ? AND workbench_id = ?")
        .run(input.dismissedAt, input.agentId, input.workbenchId);
    });
  }
}
