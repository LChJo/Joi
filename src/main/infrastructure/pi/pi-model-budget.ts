import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Shared sizing for a request against the pinned route's window.
 *
 * CJK-heavy text approaches one token per character, so characters map roughly 1:1 to tokens and a
 * fixed output reserve stays free; the legacy fixed cap remains the ceiling for large-window routes.
 * A route whose window cannot hold even the floor is still bounded by the floor so the tail stays
 * usable.
 */
/**
 * Used whenever a route's window is unknown — including by `DEFAULT_BACKGROUND_BUDGET_CHARS`
 * below, which CLI-backed partners that own their own window rely on. Deliberately kept at its
 * historical value: raising it would silently widen those partners' system-prompt budget instead
 * of this route's message budget.
 */
const CONTEXT_UNKNOWN_WINDOW_MAX_CHARS = 120_000;
/**
 * A request body is JSON-encoded whole and sent in one go, so even a million-token route must not
 * assemble a multi-megabyte payload. This bounds transport, not the model.
 */
const CONTEXT_CEILING_CHARS = 1_000_000;
const CONTEXT_OUTPUT_RESERVE_TOKENS = 16_000;
const CONTEXT_MIN_CHARS = 8_000;
const CONTEXT_MAX_MESSAGES = 32;

/** Keeps the current request plus a structurally valid recent tail before every provider call. */
export function boundModelContext(messages: AgentMessage[], maxChars: number = CONTEXT_UNKNOWN_WINDOW_MAX_CHARS): AgentMessage[] {
  if (messages.length <= CONTEXT_MAX_MESSAGES && JSON.stringify(messages).length <= maxChars) return messages;
  let start = Math.max(0, messages.length - CONTEXT_MAX_MESSAGES);
  while (start < messages.length && messages[start]?.role === "toolResult") start += 1;
  const leading = leadingSystemMessage(messages);
  const latestUserBefore = (): AgentMessage | undefined => {
    for (let index = start - 1; index >= 0; index -= 1) if (messages[index]?.role === "user") return messages[index];
    return undefined;
  };
  const assemble = (): AgentMessage[] => {
    const anchor = latestUserBefore();
    return [
      ...(leading === undefined ? [] : [leading]),
      ...(anchor === undefined ? [] : [anchor]),
      ...messages.slice(start),
    ];
  };
  let context = assemble();
  while (context.length > 2 && JSON.stringify(context).length > maxChars) {
    start += 1;
    while (start < messages.length && messages[start]?.role === "toolResult") start += 1;
    context = assemble();
  }
  return context;
}

/**
 * The transcript's leading system message, when it has one. Never dropped by a trim.
 *
 * pi 0.82 carries the system prompt outside the transcript, in `AgentState.systemPrompt`, so the
 * message list opens on the user's request. Later pi versions move it into a leading system message
 * instead. A trim that only knew the first shape would drop that message — and with it the runtime
 * permission boundary, leaving the model to read its own constraints as ordinary conversation.
 */
export function leadingSystemMessage(messages: readonly AgentMessage[]): AgentMessage | undefined {
  return messages[0]?.role === "system" ? messages[0] : undefined;
}

/**
 * The opening messages a trim must never drop, limited to those the retained tail does not already
 * carry. Covers both transcript shapes described on `leadingSystemMessage`, plus pi 0.82's habit of
 * opening on the task itself.
 */
function anchorBefore(messages: readonly AgentMessage[], start: number): AgentMessage[] {
  const leading = messages[0];
  const candidates = leading?.role === "system"
    ? [leading, ...(messages[1]?.role === "user" ? [messages[1]] : [])]
    : leading?.role === "user" ? [leading] : [];
  return candidates.filter((_, index) => index < start);
}

/**
 * The character budget a route can hold. Characters approximate tokens closely enough for CJK
 * text that this doubles as the token estimate the rest of the pipeline is sized against.
 *
 * The reserve is at most half the window, so `window - reserve` never collapses on small routes
 * and no separate share floor is needed. The only remaining bound is the transport ceiling: the
 * old fixed 120k cap made every window above ~136k behave identically, which is why a model
 * advertising a million tokens was still being fed the same context as a 128k one.
 */
export function modelContextMaxChars(model: { contextWindow?: number }): number {
  const window = model.contextWindow;
  if (window === undefined || !Number.isFinite(window) || window <= 0) return CONTEXT_UNKNOWN_WINDOW_MAX_CHARS;
  const reserve = Math.min(CONTEXT_OUTPUT_RESERVE_TOKENS, Math.floor(window / 2));
  return Math.max(CONTEXT_MIN_CHARS, Math.min(CONTEXT_CEILING_CHARS, window - reserve));
}

/**
 * One request pays for two payloads out of the same window: the assembled system prompt (Workbench
 * evidence, knowledge, Skills) and the message list. Sizing each against the whole window let their
 * sum reach twice it, so the window is divided once here and both sides are held to their share.
 */
export interface ModelRequestBudget {
  messagesMaxChars: number;
  systemMaxChars: number;
}

/** The background is reference material; the conversation needs the larger share. */
const SYSTEM_BACKGROUND_SHARE = 1 / 3;
const SYSTEM_BACKGROUND_MIN_CHARS = 1_000;

export function modelRequestBudget(model: { contextWindow?: number }): ModelRequestBudget {
  const total = modelContextMaxChars(model);
  const systemMaxChars = Math.max(SYSTEM_BACKGROUND_MIN_CHARS, Math.floor(total * SYSTEM_BACKGROUND_SHARE));
  return { messagesMaxChars: total - systemMaxChars, systemMaxChars };
}

/**
 * Joins the background sections and holds them to the share of the window the system prompt owns.
 * Every engine that hands these sections to a model needs this — a CLI-backed partner has no other
 * bound at all, since the CLI owns its own message history.
 */
export function boundBackgroundSections(sections: readonly string[], maxChars: number): string {
  const background = sections.filter((section) => section !== "").join("\n\n");
  if (background.length <= maxChars) return background;
  return `${background.slice(0, maxChars)}\n[truncated: Workbench background exceeded ${String(maxChars)} characters]`;
}

/**
 * For engines whose route is chosen by an external CLI (Claude Code, Codex) rather than pinned to a
 * source joi resolved: the CLI owns its own window, so the background gets the same conservative
 * default share the window-less case already uses.
 */
export const DEFAULT_BACKGROUND_BUDGET_CHARS = modelRequestBudget({}).systemMaxChars;

/**
 * A route's window is a property of the provider that joi can only estimate: presets are edited by
 * hand, and a generic gateway forwards to whatever model the user configured. Providers do state the
 * real limit when they reject an oversized request, so a rejection is the cheapest place to learn it
 * — record what they said and size later requests to that instead of to the preset. Keyed by source
 * and model together, because switching either one invalidates what was learned.
 */
interface ObservedRouteLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

const observedRouteLimits = new Map<string, ObservedRouteLimits>();

function routeLimitKey(sourceId: string, modelId: string): string {
  return `${sourceId} ${modelId}`;
}

function remember(sourceId: string, modelId: string, patch: ObservedRouteLimits): void {
  const key = routeLimitKey(sourceId, modelId);
  observedRouteLimits.set(key, { ...observedRouteLimits.get(key), ...patch });
}

export function rememberObservedContextWindow(sourceId: string, modelId: string, contextWindow: number): void {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
  remember(sourceId, modelId, { contextWindow: Math.floor(contextWindow) });
}

export function observedContextWindow(sourceId: string, modelId: string): number | undefined {
  return observedRouteLimits.get(routeLimitKey(sourceId, modelId))?.contextWindow;
}

/**
 * The output cap is a separate limit that the window clamp does not enforce, so it is learned the
 * same way: a provider that refuses an over-large completion says what it allows, and the next
 * request on that route is sized to it. Only a rejection is evidence — a preset stays the starting
 * point, because the first attempt that trips the cap still fails its Work.
 */
export function rememberObservedMaxOutputTokens(sourceId: string, modelId: string, maxOutputTokens: number): void {
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return;
  remember(sourceId, modelId, { maxOutputTokens: Math.floor(maxOutputTokens) });
}

export function observedMaxOutputTokens(sourceId: string, modelId: string): number | undefined {
  return observedRouteLimits.get(routeLimitKey(sourceId, modelId))?.maxOutputTokens;
}

/**
 * Reads the real window out of a provider's oversized-request rejection. Providers word these
 * differently, so only shapes that state a limit unambiguously are accepted: a wrong guess here
 * would size every later request on that route.
 */
export function parseContextWindowFromError(detail: string): number | undefined {
  // "prompt is too long: 210000 tokens > 128000 maximum"
  const exceeded = /(\d{3,})\s*tokens?\s*>\s*(\d{3,})\s*(?:maximum|max|limit)/iu.exec(detail);
  if (exceeded?.[2] !== undefined) return Number(exceeded[2]);
  // "maximum context length is 128000 tokens" / "context window of 128000 tokens"
  const stated = /(?:context (?:length|window)|maximum)[^0-9]{0,24}(\d{3,})\s*tokens?/iu.exec(detail);
  return stated?.[1] === undefined ? undefined : Number(stated[1]);
}

/**
 * Reads a completion cap out of a request the provider refused for asking for too much output. Both
 * branches require an explicit comparator, because a bare number in this text is as likely to be the
 * value joi asked for as the one the route allows — and guessing high would fail every later request
 * on the route.
 */
export function parseMaxOutputTokensFromError(detail: string): number | undefined {
  // "max_tokens: 65536 > 16384, which is the maximum allowed"
  const exceeded = /max[_ ]?(?:output[_ ]?)?tokens?[^0-9]{0,24}(\d+)\s*>\s*(\d+)/iu.exec(detail);
  if (exceeded?.[2] !== undefined) return Number(exceeded[2]);
  // "max_tokens must be less than or equal to 8192" / "maximum max_tokens is 8192"
  const capped = /max[_ ]?(?:output[_ ]?)?tokens?[^0-9]{0,40}?(?:less than or equal to|at most|maximum(?: is)?|up to|<=)\s*(\d+)/iu.exec(detail);
  return capped?.[1] === undefined ? undefined : Number(capped[1]);
}

/**
 * Per-request backstop that keeps one request inside the window by dropping the oldest messages.
 *
 * This is not the context manager: compaction owns the session's durable shape, and it runs only at
 * Turn boundaries. Without a per-request bound a single Turn that makes many tool calls grows past
 * the window mid-flight, the provider clamps `max_tokens` down to whatever is left, and the Turn
 * ends truncated — which reads downstream as a model that stopped talking rather than as an
 * overflow. The bound therefore trims only the request; the session keeps its full history, and the
 * opening message is retained as the anchor that still tells the model what it was asked.
 */
export function boundRequestByChars(messages: readonly AgentMessage[], maxChars: number): AgentMessage[] {
  if (JSON.stringify(messages).length <= maxChars) return [...messages];
  let start = 0;
  while (start < messages.length && JSON.stringify(messages.slice(start)).length > maxChars) start += 1;
  // A request must never begin on an orphaned tool result: providers reject a result whose call is gone.
  while (start < messages.length && messages[start]?.role === "toolResult") start += 1;
  if (start === 0) return [...messages];
  return [...anchorBefore(messages, start), ...messages.slice(start)];
}
