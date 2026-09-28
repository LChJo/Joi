import { abbreviateAbsolutePaths } from "../../domain/text/path-abbreviation.js";
import type { AgentConversationEntryDto } from "../../../shared/joi.js";

const MAX_CHUNK = 32 * 1024;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*|(?<![:/\p{L}\p{N}._-])\/(?:[^\s<>()`"']+\/)*[^\s<>()`"']+)/gu;
const UNC_PATH = /\\\\[^\s\\]+\\[^\s]+/gu;
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/giu;
const NAMED_SECRET = /\b(token|api[_ -]?key|apikey|secret|password|cookie|csrf(?:[_-]?token)?)\s*[=:]\s*[^\s,;]+/giu;

export interface AgentConversationDraft {
  createdAt?: string;
  artifact?: { artifactRef?: string; mimeType: string; name: string; size: number };
  kind: AgentConversationEntryDto["kind"];
  role: AgentConversationEntryDto["role"];
  text?: string;
  /** Opaque engine call id; links the entry to its private tool body. Never a payload. */
  toolCallId?: string;
  toolName?: string;
}

export interface NormalizedAgentConversationEntry extends Omit<AgentConversationEntryDto, "artifact" | "sequence"> {
  artifact?: { artifactRef?: string; mimeType: string; name: string; size: number };
  order: number;
  runId: string;
}

/** Masks secrets only; paths stay visible for local user-facing projections of the user's own text. */
export function maskSecretText(value: string): string {
  return value
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(NAMED_SECRET, (_match, name: string) => `${name}=[redacted]`);
}

/**
 * Masks secrets and prints absolute paths as their root plus their last few segments.
 * UNC paths go first: the posix shape would otherwise match a fragment of the same path
 * and leave the rest of it untouched.
 */
export function sanitizeAgentConversationText(value: string): string {
  return abbreviateAbsolutePaths(abbreviateAbsolutePaths(maskSecretText(value), UNC_PATH), ABSOLUTE_PATH);
}

/**
 * Erases the `[redacted-path]` literal still stored in rows written before paths were
 * abbreviated. This is a legacy-data eraser, not a display policy: rows written since the
 * change carry no marker, so it is a no-op for them. The trailing-space collapse it used
 * to perform is gone — on new rows that would be its only remaining effect, and it
 * silently destroys GFM hard breaks (a trailing double space) in home-feed markdown.
 */
export function stripPathRedactions(value: string): string {
  return value.replace(/\[redacted-path\][ \t]?/gu, "").trim();
}

export const COMPLETION_SUMMARY_LIMIT = 32_768;

/**
 * Goal-outcome final answer. Unlike flattened feed previews this keeps markdown
 * structure (headings, lists, GFM tables, code fences) intact so the result renders
 * as formatted markdown downstream; over-limit text is cut at a line boundary and
 * any dangling code fence is closed so truncation never breaks rendering.
 */
export function normalizeCompletionSummary(value: string): string {
  const normalized = sanitizeAgentConversationText(value)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (normalized.length <= COMPLETION_SUMMARY_LIMIT) return normalized;
  const sliced = normalized.slice(0, COMPLETION_SUMMARY_LIMIT);
  const boundary = sliced.lastIndexOf("\n");
  return closeOpenCodeFence((boundary > 0 ? sliced.slice(0, boundary) : sliced).trimEnd());
}

function closeOpenCodeFence(value: string): string {
  const fences = value.match(/^ {0,3}```/gmu);
  return fences !== null && fences.length % 2 === 1 ? `${value}\n\`\`\`` : value;
}

/** An engine's own identifier for one tool call, whatever its protocol calls it. */
function toolCallIdOf(row: Record<string, unknown>): string | undefined {
  for (const key of ["id", "toolCallId", "tool_call_id", "tool_use_id"]) {
    const value = row[key];
    if (typeof value === "string" && value !== "") return value.slice(0, 200);
  }
  return undefined;
}

/**
 * pi and the official SDKs nest output as `content: [{type:"text",text}]`, which the flat
 * `row.text ?? row.result ?? row.content` lookup silently missed — every such tool result was
 * dropped from the transcript. Longer form first, then the older flat shapes.
 */
function toolResultText(row: Record<string, unknown>): string | undefined {
  const content = row.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block !== null && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof row.text === "string") return row.text;
  if (typeof row.result === "string") return row.result;
  return typeof content === "string" ? content : undefined;
}

/**
 * Converts engine-owned messages to a bounded display projection. Tool payloads and
 * internal reasoning are intentionally excluded; only tool names, correlation ids,
 * textual results, and the final answer cross the presentation boundary.
 *
 * Tool calls are emitted one per call in message order rather than collapsed by name: the
 * id is what links an entry to its private body, so de-duplicating them would silently
 * strip the debug affordance from every run that lands on this fallback path.
 */
export function draftAgentConversation(
  taskProjection: string,
  outputBody: string,
  messages: readonly unknown[],
): AgentConversationDraft[] {
  const drafts: AgentConversationDraft[] = [{ kind: "MARKDOWN", role: "USER", text: taskProjection }];
  const seen = new Set<unknown>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 6 || drafts.length > 200 || candidate === null || typeof candidate !== "object") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    const row = candidate as Record<string, unknown>;
    const type = typeof row.type === "string" ? row.type.toLowerCase() : "";
    const role = typeof row.role === "string" ? row.role.toLowerCase() : "";
    const name = typeof row.name === "string" ? row.name
      : typeof row.toolName === "string" ? row.toolName
        : typeof row.tool_name === "string" ? row.tool_name : undefined;
    const toolCallId = toolCallIdOf(row);
    if (name !== undefined && (type.includes("tool") || row.input !== undefined || row.arguments !== undefined)) {
      drafts.push({
        kind: "TOOL_CALL", role: "TOOL", toolName: name.slice(0, 120),
        ...(toolCallId === undefined ? {} : { toolCallId }),
      });
    }
    if (role.includes("tool") || type.includes("tool_result")) {
      const text = toolResultText(row);
      if (text !== undefined && text.trim() !== "") {
        drafts.push({
          kind: "TOOL_RESULT", role: "TOOL", text,
          ...(toolCallId === undefined ? {} : { toolCallId }),
          ...(name === undefined ? {} : { toolName: name.slice(0, 120) }),
        });
      }
    }
    for (const [key, value] of Object.entries(row)) {
      if (["input", "arguments", "thinking", "reasoning", "systemPrompt"].includes(key)) continue;
      if (typeof value === "object" && value !== null) visit(value, depth + 1);
    }
  };
  for (const message of messages) visit(message, 0);
  if (outputBody.trim() !== "") drafts.push({ kind: "MARKDOWN", role: "AGENT", text: outputBody });
  return drafts;
}

function chunks(value: string): string[] {
  if (value.length === 0) return [""];
  const result: string[] = [];
  for (let offset = 0; offset < value.length; offset += MAX_CHUNK) result.push(value.slice(offset, offset + MAX_CHUNK));
  return result;
}

export function normalizeAgentConversationEntries(
  context: { agentId: string; runId: string; startedAt: string },
  drafts: AgentConversationDraft[],
): NormalizedAgentConversationEntry[] {
  const entries: NormalizedAgentConversationEntry[] = [];
  drafts.forEach((draft, draftIndex) => {
    const textChunks = draft.text === undefined ? [undefined] : chunks(sanitizeAgentConversationText(draft.text));
    textChunks.forEach((text, chunkIndex) => {
      entries.push({
        ...(draft.artifact === undefined ? {} : { artifact: {
          ...(draft.artifact.artifactRef === undefined ? {} : { artifactRef: draft.artifact.artifactRef }),
          mimeType: draft.artifact.mimeType.slice(0, 120),
          name: sanitizeAgentConversationText(draft.artifact.name).slice(0, 240),
          size: draft.artifact.size,
        } }),
        createdAt: draft.createdAt ?? context.startedAt,
        entryId: `agent_entry:${context.agentId}:${context.runId}:${String(draftIndex)}:${String(chunkIndex)}`,
        kind: draft.kind,
        order: entries.length,
        role: draft.role,
        runId: context.runId,
        ...(text === undefined ? {} : { text }),
        ...(draft.toolCallId === undefined ? {} : { toolCallId: draft.toolCallId.slice(0, 200) }),
        ...(draft.toolName === undefined ? {} : { toolName: draft.toolName.slice(0, 120) }),
      });
    });
  });
  return entries;
}
