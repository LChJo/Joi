import { maskSecretText, sanitizeAgentConversationText } from "./agent-conversation-presentation.js";

/**
 * Bounds for the two faces of one tool call. The **summary** stays inline in the main
 * timeline, so it is written and re-compared on every live snapshot and must stay tiny.
 * The **trace body** is a private local record read on demand only (AC-61) and never
 * enters the timeline, the home feed, diagnostics, SSE or the remote surface.
 */
export const TOOL_TRACE_MAX_BODY_CHARS = 8_192;
export const TOOL_CALL_SUMMARY_MAX_CHARS = 200;
export const TOOL_TRACE_TRUNCATION_NOTE = "\n[truncated: exceeded the 8 KB trace budget]";

/**
 * Raw budget applied before masking. The sanitizer's absolute-path rule replaces a match
 * with the 15-character `[redacted-path]`, so masking can make a short string *longer* —
 * the post-sanitize cap is what actually holds the invariant. This first cap exists so the
 * regexes never scan an unbounded payload (a `write` argument can carry a whole file).
 */
const SUMMARY_RAW_BUDGET_CHARS = 600;
const JSON_MAX_DEPTH = 6;
const JSON_MAX_KEYS = 40;

export interface ToolTraceDraft {
  /** The tool's own command/arguments, credentials masked and paths kept, bounded. */
  command: string;
  isError: boolean;
  /** The tool's textual output, credentials masked and paths kept, bounded. */
  result: string;
  toolCallId: string;
  toolName: string;
  truncated: boolean;
}

export interface BoundedToolBody {
  body: string;
  truncated: boolean;
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** Bounded, cycle-safe JSON for arguments we have no readable projection for. */
function boundedJson(value: unknown): string {
  if (value === undefined) return "";
  const seen = new Set<unknown>();
  const render = (candidate: unknown, depth: number): unknown => {
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (seen.has(candidate) || depth > JSON_MAX_DEPTH) return "[…]";
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.slice(0, JSON_MAX_KEYS).map((item) => render(item, depth + 1));
    const row = candidate as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row).slice(0, JSON_MAX_KEYS)) out[key] = render(row[key], depth + 1);
    return out;
  };
  try {
    const encoded: unknown = JSON.stringify(render(value, 0));
    return typeof encoded === "string" ? encoded : "[unserializable]";
  } catch {
    return "[unserializable]";
  }
}

function objectArgs(args: unknown): Record<string, unknown> | undefined {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : undefined;
}

/**
 * The one readable line for a call: for bash the command itself, for a file tool its path,
 * for research tools the query. Multi-line arguments are collapsed because a shell script's
 * first line is usually `set -euo pipefail` — keeping only it would discard the real work.
 */
function summarySource(toolName: string, args: unknown): string {
  const row = objectArgs(args);
  if (row === undefined) return typeof args === "string" ? args : boundedJson(args);
  const text = (key: string): string | undefined => stringField(row, key);
  switch (toolName) {
    case "bash":
    case "shell":
      return text("command") ?? boundedJson(args);
    case "js":
      return text("code") ?? boundedJson(args);
    case "read":
    case "ls":
    case "find":
      return text("path") ?? boundedJson(args);
    case "write":
    case "edit": {
      const target = stringField(row, "path", "file_path") ?? "";
      const content = stringField(row, "content", "newText", "new_string", "new_str") ?? "";
      if (content === "") return target === "" ? boundedJson(args) : target;
      return `${target} · ${String(content.length)} 字符`;
    }
    case "grep": {
      const pattern = text("pattern") ?? "";
      const target = text("path") ?? "";
      if (pattern === "") return target === "" ? boundedJson(args) : target;
      return target === "" ? pattern : `${pattern} @ ${target}`;
    }
    case "web_search":
      return text("query") ?? boundedJson(args);
    case "fetch_content":
      return text("url") ?? boundedJson(args);
    case "get_search_content":
      return stringField(row, "responseId", "findText", "url") ?? boundedJson(args);
    case "ask_user":
      return text("question") ?? boundedJson(args);
    default:
      return boundedJson(args);
  }
}

/**
 * Produces the inline timeline summary. Order is deliberately cap → sanitize → cap: the
 * first cap bounds the regex input, and the second cap is required because masking can
 * lengthen the string.
 */
export function toolCallSummary(toolName: string, args: unknown): string {
  const raw = summarySource(toolName, args).replace(/\s+/gu, " ").trim().slice(0, SUMMARY_RAW_BUDGET_CHARS);
  if (raw === "") return "";
  const safe = sanitizeAgentConversationText(raw);
  return safe.length <= TOOL_CALL_SUMMARY_MAX_CHARS
    ? safe
    : `${safe.slice(0, TOOL_CALL_SUMMARY_MAX_CHARS - 1)}…`;
}

function bound(value: string): BoundedToolBody {
  return value.length <= TOOL_TRACE_MAX_BODY_CHARS
    ? { body: value, truncated: false }
    : { body: `${value.slice(0, TOOL_TRACE_MAX_BODY_CHARS)}${TOOL_TRACE_TRUNCATION_NOTE}`, truncated: true };
}

/** Full arguments for the private trace. Newlines are preserved so a script stays readable. */
function commandSource(toolName: string, args: unknown): string {
  const row = objectArgs(args);
  if (row === undefined) return typeof args === "string" ? args : boundedJson(args);
  switch (toolName) {
    case "bash":
    case "shell":
      return stringField(row, "command") ?? boundedJson(args);
    case "js":
      return stringField(row, "code") ?? boundedJson(args);
    case "write": {
      const target = stringField(row, "path", "file_path") ?? "";
      const content = stringField(row, "content") ?? "";
      return [target, content].filter((part) => part !== "").join("\n\n");
    }
    case "edit": {
      const target = stringField(row, "path", "file_path") ?? "";
      const before = stringField(row, "oldText", "old_string", "old_str") ?? "";
      const after = stringField(row, "newText", "new_string", "new_str") ?? "";
      return [target, before === "" ? "" : `--- before\n${before}`, after === "" ? "" : `--- after\n${after}`]
        .filter((part) => part !== "").join("\n\n");
    }
    default:
      return boundedJson(args);
  }
}

/** pi delivers tool output as `{content:[{type:"text",text}], details}`; flatten it readably. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  const row = objectArgs(result);
  if (row === undefined) return boundedJson(result);
  const parts: string[] = [];
  const content = row.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block !== null && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  } else if (typeof content === "string") parts.push(content);
  const details = objectArgs(row.details);
  if (details !== undefined && Object.keys(details).length > 0) parts.push(`--- details ---\n${boundedJson(details)}`);
  if (parts.length === 0) return boundedJson(result);
  return parts.join("\n");
}

/**
 * Credentials are masked before persistence, absolute paths are deliberately kept: a bash
 * command is mostly its paths, and `cd "[redacted-path]" && npm test` documents nothing.
 * This is the same posture as the AC-59 prompt reveal, and it is why the trace is a
 * separate private channel rather than a display entry (ADR 0008).
 */
export function toolCallCommand(toolName: string, args: unknown): BoundedToolBody {
  return bound(maskSecretText(commandSource(toolName, args)));
}

export function toolCallResultBody(result: unknown): BoundedToolBody {
  return bound(maskSecretText(resultText(result)));
}

/**
 * A short label for a call whose arguments must not leave the infrastructure.
 *
 * The CLI-backed engines can describe a call from the tool's name but not from its arguments:
 * ADR 0014 requires parameters, commands and results to be dropped before the event port, and a
 * shell command's text is exactly what that rule is about. The timeline therefore gets a readable
 * verb instead of the engine's internal tool name, which is the difference between a row that says
 * "apply_patch" and one a reader understands.
 *
 * pi derives its summary from arguments instead, because its arguments never came from a black box
 * the way a CLI's do. The two are deliberately not the same thing.
 */
export function toolCallLabel(toolName: string): string {
  // The CLI engines capitalise their tool names (`Read`, `Write`) where pi does not, and the two
  // should read the same in the timeline.
  switch (toolName.toLowerCase()) {
    case "bash":
    case "shell":
    case "command_execution":
      return "运行命令";
    case "read":
      return "读取文件";
    case "write":
      return "写入文件";
    case "edit":
    case "apply_patch":
    case "file_change":
      return "修改文件";
    case "find":
    case "grep":
    case "ls":
      return "检索文件";
    case "web_search":
    case "fetch_content":
    case "get_search_content":
      return "检索网络";
    case "ask_user":
      return "询问用户";
    default:
      // An unknown tool still gets a bounded label; its name is an identifier, not a payload.
      return toolName.slice(0, TOOL_CALL_SUMMARY_MAX_CHARS);
  }
}
