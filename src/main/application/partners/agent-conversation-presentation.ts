import type { AgentConversationEntryDto } from "../../../shared/joi.js";

const MAX_CHUNK = 32 * 1024;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*|(?<![:/\p{L}\p{N}._-])\/(?:[^\s<>()`"']+\/)*[^\s<>()`"']+)/gu;
const UNC_PATH = /\\\\[^\s\\]+\\[^\s]+/gu;
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/giu;
const NAMED_SECRET = /\b(token|api[_ -]?key|apikey|secret|password|cookie|csrf(?:[_-]?token)?)\s*[=:]\s*[^\s,;]+/giu;

export interface AgentConversationDraft {
  artifact?: { artifactRef?: string; mimeType: string; name: string; size: number };
  kind: AgentConversationEntryDto["kind"];
  role: AgentConversationEntryDto["role"];
  text?: string;
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

export function sanitizeAgentConversationText(value: string): string {
  return maskSecretText(value)
    .replace(UNC_PATH, "[redacted-path]")
    .replace(ABSOLUTE_PATH, "[redacted-path]");
}

/** Card-facing projections drop the path placeholder entirely: the raw path stays hidden and secret masking is untouched. */
export function stripPathRedactions(value: string): string {
  return value.replace(/\[redacted-path\][ \t]?/gu, "").replace(/[ \t]{2,}/gu, " ").replace(/[ \t]+$/gmu, "").trim();
}

export const COMPLETION_SUMMARY_LIMIT = 4096;

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

/**
 * Converts engine-owned messages to a bounded display projection. Tool payloads and
 * internal reasoning are intentionally excluded; only tool names, textual results,
 * and the final answer cross the presentation boundary.
 */
export function draftAgentConversation(
  taskProjection: string,
  outputBody: string,
  messages: readonly unknown[],
): AgentConversationDraft[] {
  const drafts: AgentConversationDraft[] = [{ kind: "MARKDOWN", role: "USER", text: taskProjection }];
  const seen = new Set<unknown>();
  const toolCalls = new Set<string>();
  const toolResults: string[] = [];
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 6 || drafts.length + toolResults.length > 200 || candidate === null || typeof candidate !== "object") return;
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
    if (name !== undefined && (type.includes("tool") || row.input !== undefined || row.arguments !== undefined)) toolCalls.add(name.slice(0, 120));
    if (role.includes("tool") || type.includes("tool_result")) {
      const text = typeof row.text === "string" ? row.text
        : typeof row.result === "string" ? row.result
          : typeof row.content === "string" ? row.content : undefined;
      if (text !== undefined && text.trim() !== "") toolResults.push(text);
    }
    for (const [key, value] of Object.entries(row)) {
      if (["input", "arguments", "thinking", "reasoning", "systemPrompt"].includes(key)) continue;
      if (typeof value === "object" && value !== null) visit(value, depth + 1);
    }
  };
  for (const message of messages) visit(message, 0);
  for (const toolName of toolCalls) drafts.push({ kind: "TOOL_CALL", role: "TOOL", toolName });
  for (const text of toolResults) drafts.push({ kind: "TOOL_RESULT", role: "TOOL", text });
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
        createdAt: context.startedAt,
        entryId: `agent_entry:${context.agentId}:${context.runId}:${String(draftIndex)}:${String(chunkIndex)}`,
        kind: draft.kind,
        order: entries.length,
        role: draft.role,
        runId: context.runId,
        ...(text === undefined ? {} : { text }),
        ...(draft.toolName === undefined ? {} : { toolName: draft.toolName.slice(0, 120) }),
      });
    });
  });
  return entries;
}
