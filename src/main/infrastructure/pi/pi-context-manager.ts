import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, shouldCompact } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

import { checkpointMessage, HISTORY_SOFT_TARGET_CHARS, HISTORY_SOFT_TRIGGER_CHARS, isCheckpointMessage, omissionNotice, summarizeSegment, taskAnchorIndices, transcriptFingerprint, SummaryRetryGuard, summaryCandidateKey, summarySavings } from "./pi-compaction.js";
import { compactionReserveTokens, leadingSystemMessage } from "./pi-model-budget.js";

/**
 * A partner run makes a single `agent.prompt()` call and then works for as long as the task takes,
 * issuing thousands of tool calls. pi applies `transformContext` to every provider request, and
 * that hook may only reshape the *request*: writing back to `agent.state.messages` would cost the
 * run its own transcript, which is where the final body and the entire UI timeline are read from.
 * The compacted history therefore has to live beside the agent rather than inside it, which is what
 * this module owns.
 *
 * What it replaces: a window that kept the newest 32 messages and silently dropped everything
 * older, with no marker and no summary. A long run had roughly sixteen tool calls of memory,
 * anchored to its original task description — so when it found files on disk that it could not
 * remember writing, it concluded another process had been editing its workspace and set out to
 * investigate. The disk was never touched; the history was.
 */

/** How much of the tail survives a compaction, in pi's own token estimate. */
const KEEP_RECENT_TOKENS = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

/** Share of the message budget the retained tail may take; the rest covers anchors and the summary. */
const TAIL_SHARE = 0.5;

export type PiContextDiagnostic =
  | { candidateChars: number;type: "joi.partner.context_summary_started" }
  | { charsBefore: number; charsAfter: number; savedChars: number; reasonCode: "summary_no_savings"; type: "joi.partner.context_summary_rejected" }
  | { retryAfterMs: number; type: "joi.partner.context_summary_backoff" }
  | { compactedMessages: number; count: number; tokensBefore: number; charsBefore?: number; charsAfter?: number; durationMs?: number; runtime?: "pi"; type: "joi.partner.context_compacted" }
  | { reasonCode: string; type: "joi.partner.context_summary_failed" }
  | { runtime: "pi"; contextChars: number; historyChars: number; requiredChars: number; backgroundChars: number; budgetFallbacks: number; type: "joi.context.request" }
  | { omittedChars: number; omittedMessages: number; type: "joi.partner.context_truncated" };

/** The compacted prefix of a run's transcript, and the summary that stands in for it. */
export interface PiContextCheckpoint {
  routeKey?: string;
  /** `messages.slice(cut)` is the retained tail; everything before it is covered by `summary`. */
  cut: number;
  summary: string;
  count: number;
  compactedMessages: number;
  lastCompactedAt: string;
  messagesBefore: number;
  tokensBefore: number;
  /** Identity of the exact source prefix. System prompts are refreshed outside this transcript. */
  sourceFingerprint: string;
  /** Source messages retained verbatim rather than covered by this summary. */
  preservedIndices: number[];
}

export interface PiContextManagerOptions {
  now?: () => number;
  /** The route being sized. A different model invalidates the checkpoint. */
  model: Model<Api>;
  models: Models;
  /** Character budget for one request's messages. */
  messagesMaxChars: number;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onDiagnostic?: (event: PiContextDiagnostic) => void;
  requiredChars?: number;
  backgroundChars?: number;
  /** Reserved for the summary call and its output. */
  reserveTokens?: number;
  /**
   * A checkpoint restored from a previous turn of the same resident instance. `cut` indexes the
   * transcript it was taken against, so a caller handing back a different transcript must drop it
   * instead of passing it.
   */
  restored?: PiContextCheckpoint;
}

export interface PiContextManager {
  /** The `transformContext` implementation. Never throws: pi's contract forbids it. */
  transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** The checkpoint as it stands, for a caller that carries it across resident turns. */
  checkpoint: () => PiContextCheckpoint | undefined;
}

/**
 * The first index a cut may take: everything before it is summarized, everything from it is kept.
 *
 * A cut may land on a user or an assistant message but never on a tool result, because the request
 * must not carry a result whose call was summarized away — providers reject the pairing, and the
 * retained tail always inherits the anchors ahead of it, so opening on an assistant is safe. The
 * rule deliberately admits assistant messages: a partner run makes a single `agent.prompt()` call,
 * so its transcript holds exactly one user message and a user-only cut could never compact it.
 *
 * When no such boundary exists at or after the target, the caller keeps the transcript intact
 * instead. Declining to compact one request is recoverable; splitting a call from its result is not.
 */
function cutAt(messages: readonly AgentMessage[], target: number, floor: number): number | undefined {
  for (let index = Math.max(floor, target); index < messages.length; index += 1) {
    const role = messages[index]?.role;
    if (role === "user" || role === "assistant") return index;
  }
  return undefined;
}

/** How many messages a compaction must keep whatever else it drops: the prompt and the task. */
function anchorEnd(messages: readonly AgentMessage[]): number {
  return leadingSystemMessage(messages) === undefined ? 0 : 1;
}

export function createPiContextManager(options: PiContextManagerOptions): PiContextManager {
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    reserveTokens: compactionReserveTokens(options.model, options.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens),
  };
  let checkpoint = options.restored;
  const retry = new SummaryRetryGuard(options.now);
  const routeKey = summaryCandidateKey([options.model.provider,options.model.id,options.model.contextWindow,options.thinkingLevel,options.messagesMaxChars,settings.reserveTokens]);
  // Prefix sums of per-message cost, addressed by message index and extended as the transcript
  // grows. Without them every request would re-price the run's entire history, which over thousands
  // of requests is quadratic in the number of tool calls a run makes.
  let tokenPrefix: number[] = [0];
  let charPrefix: number[] = [0];
  let firstChars = 0;
  let priced: AgentMessage[] = [];
  let pricedSizes: number[] = [];

  const price = (messages: readonly AgentMessage[]): void => {
    const sizes = messages.map(message => JSON.stringify(message).length);
    if (tokenPrefix.length - 1 > messages.length || priced.some((message,index) => index > 0 && (messages[index] !== message || pricedSizes[index] !== sizes[index]))) {
      tokenPrefix = [0];
      charPrefix = [0];
    }
    const currentFirstChars = messages[0] === undefined ? 0 : JSON.stringify(messages[0]).length;
    if (charPrefix.length > 1 && firstChars !== currentFirstChars) {
      const delta = currentFirstChars - firstChars;
      for (let index = 1; index < charPrefix.length; index += 1) charPrefix[index] = (charPrefix[index] ?? 0) + delta;
    }
    firstChars = currentFirstChars;
    while (tokenPrefix.length - 1 < messages.length) {
      const index = tokenPrefix.length - 1;
      const message = messages[index];
      if (message === undefined) break;
      tokenPrefix.push((tokenPrefix[index] ?? 0) + estimateTokens(message));
      charPrefix.push((charPrefix[index] ?? 0) + JSON.stringify(message).length);
    }
    priced = [...messages];
    pricedSizes = sizes;
  };

  const tokensIn = (from: number, to: number): number => (tokenPrefix[to] ?? 0) - (tokenPrefix[from] ?? 0);
  const charsIn = (from: number, to: number): number => (charPrefix[to] ?? 0) - (charPrefix[from] ?? 0);

  /**
   * Where the retained tail starts. The tail has to satisfy both budgets — pi's token estimate is
   * what the model window cares about, the character budget is the CJK correction — so the walk
   * stops at whichever runs out first. A tail that fitted only one of them would compact the history
   * and then have to drop the very messages it had just summarized.
   */
  const targetCut = (messages: readonly AgentMessage[], floor: number): number => {
    const charBudget = Math.floor(Math.min(options.messagesMaxChars, HISTORY_SOFT_TARGET_CHARS) * TAIL_SHARE);
    let index = messages.length;
    while (index > floor
      && tokensIn(index - 1, messages.length) < KEEP_RECENT_TOKENS
      && charsIn(index - 1, messages.length) < charBudget) index -= 1;
    // The latest tool exchange is indivisible even when it exceeds the soft target.
    const lastResult = messages.findLastIndex(message => message.role === "toolResult");
    if (lastResult >= floor) {
      let exchange = lastResult;
      while (exchange > floor && messages[exchange]?.role === "toolResult") exchange -= 1;
      index = Math.min(index, exchange);
    }
    return index;
  };

  /**
   * The summary message a request carries, when a checkpoint exists.
   *
   * Every path that assembles a request goes through this. A request that dropped the summary
   * while still announcing a drop would point the model at a summary it does not contain, and
   * would cost the run the compaction it had just paid a model call for.
   */
  const summaryMessages = (): AgentMessage[] => checkpoint === undefined
    ? []
    : [checkpointMessage(checkpoint.summary, Date.parse(checkpoint.lastCompactedAt))];

  /** What the summary costs the request's budget, measured as it is actually sent. */
  const summaryChars = (): number => summaryMessages()
    .reduce((total, message) => total + JSON.stringify(message).length, 0);

  const anchorsBefore = (messages: readonly AgentMessage[], cut: number): AgentMessage[] => [...new Set([
    ...taskAnchorIndices(messages), ...(checkpoint?.preservedIndices ?? []),
  ])].sort((left, right) => left - right)
    .filter(index => index < cut).map(index => messages[index]).filter((message): message is AgentMessage => message !== undefined);
  const assemble = (messages: readonly AgentMessage[], cut: number): AgentMessage[] => [
    ...messages.slice(0, anchorEnd(messages)),
    ...anchorsBefore(messages, cut),
    ...summaryMessages(),
    ...messages.slice(cut),
  ];

  /**
   * pi's `estimateTokens` prices CJK at roughly one token per four characters and returns 0 for a
   * system message. joi's routes are CJK-heavy and its system prompt can be a third of the window,
   * so the token estimate on its own fires late. The character budget is the independent trigger
   * that covers the gap, and it is the same budget the request was assembled against.
   */
  const overBudget = (messages: readonly AgentMessage[], cut: number, floor: number, standing: number): boolean => {
    const anchorChars = anchorsBefore(messages, cut).reduce((sum, message) => sum + JSON.stringify(message).length, 0);
    const chars = charsIn(0, floor) + standing + anchorChars + charsIn(cut, messages.length);
    const fixedChars = leadingSystemMessage(messages) === undefined ? 0 : charsIn(0, 1);
    // Summaries only reduce history; fixed policy, requirements and tools still count toward capacity.
    if (chars >= options.messagesMaxChars || chars - fixedChars >= HISTORY_SOFT_TRIGGER_CHARS) return true;
    if (options.model.contextWindow <= 0) return false;
    const standingTokens = [...anchorsBefore(messages, cut), ...summaryMessages()].reduce((sum, message) => sum + estimateTokens(message), 0);
    return shouldCompact(tokensIn(0, floor) + standingTokens + tokensIn(cut, messages.length), options.model.contextWindow, settings);
  };

  /**
   * Last resort when a summary could not be produced: keep inside the window by dropping the oldest
   * messages, but say so. Never silent — an unexplained gap in its own history is what made a run
   * decide that something outside it had been rewriting the workspace.
   *
   * A checkpoint that already exists still travels with the request. The summary stands in for the
   * messages it covers, so only what it does not cover is a loss, and only that is announced as
   * one: measuring the loss from the floor would report ordinary compression as data loss, and
   * dropping the summary would leave the notice pointing at something the request no longer holds.
   */
  const trimWithNotice = (messages: readonly AgentMessage[], floor: number): AgentMessage[] => {
    const covered = Math.max(floor,checkpoint?.cut ?? floor);
    let latestExchange = messages.findLastIndex(message => message.role === "toolResult");
    if (latestExchange < 0) latestExchange = Math.max(floor,messages.length - 1);
    while (latestExchange > floor && messages[latestExchange]?.role === "toolResult") latestExchange -= 1;
    const target = Math.min(latestExchange,Math.max(covered,targetCut(messages,floor)));
    let request = assemble(messages,covered),omittedChars = 0,omitted = 0;
    for (let start = target; start <= latestExchange; start += 1) {
      if (messages[start]?.role === "toolResult") continue;
      const anchors = anchorsBefore(messages,start),preserved = new Set(anchors);
      const source = messages.slice(covered,start).filter(message => !preserved.has(message) && !isCheckpointMessage(message));
      omitted = source.length;
      omittedChars = source.reduce((sum,message) => sum + JSON.stringify(message).length,0);
      request = [...messages.slice(0,floor),...anchors,...summaryMessages(),
        ...(omitted === 0 ? [] : [omissionNotice(omitted,omittedChars)]),...messages.slice(start)];
      if (JSON.stringify(request).length <= options.messagesMaxChars) break;
    }
    if (omitted > 0) options.onDiagnostic?.({ omittedChars,omittedMessages: omitted,type: "joi.partner.context_truncated" });
    return request;
  };

  const compact = async (messages: readonly AgentMessage[], floor: number, signal: AbortSignal | undefined): Promise<boolean> => {
    const from = checkpoint === undefined ? floor : Math.max(floor, checkpoint.cut);
    const target = Math.max(from, targetCut(messages, floor));
    const cut = cutAt(messages, target, floor + 1);
    // Nothing safe to cut, or nothing new since the last compaction.
    if (cut === undefined || cut <= from) return false;
    const anchors = taskAnchorIndices(messages);
    const released = (checkpoint?.preservedIndices ?? []).filter(index => index < from && !anchors.includes(index))
      .map(index => messages[index]).filter((message): message is AgentMessage => message !== undefined);
    const segment = [...released, ...messages.slice(from, cut).filter((message, index) => message.role !== "system" && !isCheckpointMessage(message) && !anchors.includes(from + index))];
    if (segment.length === 0) return false;
    const key = summaryCandidateKey([transcriptFingerprint(messages,cut),segment,checkpoint,routeKey]);
    if (signal?.aborted) { retry.reset();return false; }
    const retryAfterMs = retry.remaining(key);
    if (retryAfterMs > 0) { options.onDiagnostic?.({ retryAfterMs,type: "joi.partner.context_summary_backoff" });return false; }
    const startedAt = Date.now();
    options.onDiagnostic?.({ candidateChars: JSON.stringify(segment).length,type: "joi.partner.context_summary_started" });
    const generated = await summarizeSegment({
      model: options.model,
      models: options.models,
      previousSummary: checkpoint?.summary,
      reserveTokens: Math.min(settings.reserveTokens, Math.floor(HISTORY_SOFT_TARGET_CHARS / 8)),
      segment,
      signal,
      thinkingLevel: options.thinkingLevel,
    });
    if (signal?.aborted) { retry.reset();return false; }
    if (!generated.ok || generated.summary.length > HISTORY_SOFT_TARGET_CHARS / 2) {
      options.onDiagnostic?.({ reasonCode: generated.ok ? "summary_exceeds_capacity" : generated.reasonCode, type: "joi.partner.context_summary_failed" });
      retry.failed(key);
      return false;
    }
    const now = new Date().toISOString();
    const previous = checkpoint;
    const before = assemble(messages,checkpoint?.cut ?? floor);
    checkpoint = {
      routeKey,
      compactedMessages: (checkpoint?.compactedMessages ?? 0) + segment.length,
      count: (checkpoint?.count ?? 0) + 1,
      cut,
      lastCompactedAt: now,
      messagesBefore: messages.length,
      summary: generated.summary,
      tokensBefore: tokensIn(0, messages.length),
      sourceFingerprint: transcriptFingerprint(messages, cut),
      preservedIndices: anchors.filter(index => index < cut),
    };
    const savings = summarySavings(before,assemble(messages,cut));
    if (savings.savedChars <= 0) {
      checkpoint = previous;retry.failed(key);
      options.onDiagnostic?.({ ...savings,reasonCode: "summary_no_savings",type: "joi.partner.context_summary_rejected" });
      return false;
    }
    retry.reset();
    options.onDiagnostic?.({
      compactedMessages: checkpoint.compactedMessages,
      count: checkpoint.count,
      tokensBefore: checkpoint.tokensBefore,
      charsBefore: charsIn(0, messages.length),
      charsAfter: JSON.stringify(assemble(messages, cut)).length,
      durationMs: Math.max(0, Date.now() - startedAt),
      runtime: "pi",
      type: "joi.partner.context_compacted",
    });
    return true;
  };

  return {
    checkpoint: () => checkpoint,
    transformContext: async (messages, signal) => {
      const finish = (request: AgentMessage[]): AgentMessage[] => {
        options.onDiagnostic?.({
          type: "joi.context.request", runtime: "pi", contextChars: JSON.stringify(request).length,
          historyChars: request.filter(message => message.role !== "system").reduce((sum, message) => sum + JSON.stringify(message).length, 0),
          requiredChars: options.requiredChars ?? 0, backgroundChars: options.backgroundChars ?? 0,
          budgetFallbacks: JSON.stringify(request).length >= HISTORY_SOFT_TRIGGER_CHARS ? 1 : 0,
        });
        return request;
      };
      try {
        price(messages);
        // Complete source messages are immutable while a loop appends its tail. Restored coverage
        // is checked once; branching or rollback callers replace the manager with their transcript.
        if (checkpoint !== undefined && (!Number.isSafeInteger(checkpoint.cut) || checkpoint.cut > messages.length || checkpoint.cut < 0 || checkpoint.summary.trim() === ""
          || (checkpoint.routeKey !== undefined && checkpoint.routeKey !== routeKey)
          || checkpoint.sourceFingerprint !== transcriptFingerprint(messages, checkpoint.cut))) { checkpoint = undefined;retry.reset(); }
        const floor = anchorEnd(messages);
        // No checkpoint means nothing has been summarized yet, so the whole transcript after the
        // anchors is the tail and the request is the transcript unchanged.
        let cut = checkpoint === undefined ? floor : Math.max(floor, checkpoint.cut);
        const standing = summaryChars();
        if (!overBudget(messages, cut, floor, standing)) return finish(assemble(messages, cut));
        if (await compact(messages, floor, signal)) {
          cut = Math.max(floor, checkpoint?.cut ?? floor);
          if (!overBudget(messages, cut, floor, summaryChars())) return finish(assemble(messages, cut));
        }
        return finish(trimWithNotice(messages, floor));
      } catch {
        // pi's contract for this hook is that it must not throw or reject: throwing interrupts the
        // agent loop without a normal event sequence. A request that is merely too large is
        // recoverable; a broken loop is not, so the fallback is the bounded one.
        options.onDiagnostic?.({ reasonCode: "compaction_threw", type: "joi.partner.context_summary_failed" });
        try {
          return finish(trimWithNotice(messages, anchorEnd(messages)));
        } catch {
          return messages;
        }
      }
    },
  };
}
