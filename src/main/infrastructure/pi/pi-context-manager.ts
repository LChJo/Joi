import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  shouldCompact,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

import { checkpointMessage, omissionNotice, summarizeSegment } from "./pi-compaction.js";
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
  | { compactedMessages: number; count: number; tokensBefore: number; type: "joi.partner.context_compacted" }
  | { reasonCode: string; type: "joi.partner.context_summary_failed" }
  | { omittedChars: number; omittedMessages: number; type: "joi.partner.context_truncated" };

/** The compacted prefix of a run's transcript, and the summary that stands in for it. */
export interface PiContextCheckpoint {
  /** `messages.slice(cut)` is the retained tail; everything before it is covered by `summary`. */
  cut: number;
  summary: string;
  count: number;
  compactedMessages: number;
  lastCompactedAt: string;
  messagesBefore: number;
  tokensBefore: number;
}

export interface PiContextManagerOptions {
  /** The route being sized. A different model invalidates the checkpoint. */
  model: Model<Api>;
  models: Models;
  /** Character budget for one request's messages. */
  messagesMaxChars: number;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onDiagnostic?: (event: PiContextDiagnostic) => void;
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
  if (leadingSystemMessage(messages) !== undefined) {
    // The task follows the transcript's leading system message in every shape pi has produced.
    return messages[1]?.role === "user" ? 2 : 1;
  }
  return messages[0]?.role === "user" ? 1 : 0;
}

export function createPiContextManager(options: PiContextManagerOptions): PiContextManager {
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    reserveTokens: compactionReserveTokens(options.model, options.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens),
  };
  let checkpoint = options.restored;
  // Prefix sums of per-message cost, addressed by message index and extended as the transcript
  // grows. Without them every request would re-price the run's entire history, which over thousands
  // of requests is quadratic in the number of tool calls a run makes.
  let tokenPrefix: number[] = [0];
  let charPrefix: number[] = [0];

  const price = (messages: readonly AgentMessage[]): void => {
    if (tokenPrefix.length - 1 > messages.length) {
      tokenPrefix = [0];
      charPrefix = [0];
    }
    while (tokenPrefix.length - 1 < messages.length) {
      const index = tokenPrefix.length - 1;
      const message = messages[index];
      if (message === undefined) break;
      tokenPrefix.push((tokenPrefix[index] ?? 0) + estimateTokens(message));
      charPrefix.push((charPrefix[index] ?? 0) + JSON.stringify(message).length);
    }
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
    const charBudget = Math.floor(options.messagesMaxChars * TAIL_SHARE);
    let index = messages.length;
    while (index > floor
      && tokensIn(index - 1, messages.length) < KEEP_RECENT_TOKENS
      && charsIn(index - 1, messages.length) < charBudget) index -= 1;
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

  const assemble = (messages: readonly AgentMessage[], cut: number): AgentMessage[] => [
    ...messages.slice(0, anchorEnd(messages)),
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
    const chars = charsIn(0, floor) + standing + charsIn(cut, messages.length);
    if (chars > options.messagesMaxChars) return true;
    if (options.model.contextWindow <= 0) return false;
    return shouldCompact(tokensIn(0, floor) + tokensIn(cut, messages.length), options.model.contextWindow, settings);
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
    let start = Math.max(floor, targetCut(messages, floor));
    const nextUser = cutAt(messages, start, floor);
    if (nextUser !== undefined) start = nextUser;
    while (start < messages.length && messages[start]?.role === "toolResult") start += 1;
    if (start <= floor) return assemble(messages, floor);
    const head = [...messages.slice(0, floor), ...summaryMessages()];
    const covered = checkpoint === undefined ? floor : Math.min(start, Math.max(floor, checkpoint.cut));
    if (start <= covered) return [...head, ...messages.slice(start)];
    const omitted = start - covered;
    const omittedChars = charsIn(covered, start);
    options.onDiagnostic?.({ omittedChars, omittedMessages: omitted, type: "joi.partner.context_truncated" });
    return [...head, omissionNotice(omitted, omittedChars), ...messages.slice(start)];
  };

  const compact = async (messages: readonly AgentMessage[], floor: number, signal: AbortSignal | undefined): Promise<boolean> => {
    const from = checkpoint === undefined ? floor : Math.max(floor, checkpoint.cut);
    const target = Math.max(from, targetCut(messages, floor));
    const cut = cutAt(messages, target, floor + 1);
    // Nothing safe to cut, or nothing new since the last compaction.
    if (cut === undefined || cut <= from) return false;
    const segment = messages.slice(from, cut);
    const generated = await summarizeSegment({
      model: options.model,
      models: options.models,
      previousSummary: checkpoint?.summary,
      reserveTokens: settings.reserveTokens,
      segment,
      signal,
      thinkingLevel: options.thinkingLevel,
    });
    if (!generated.ok) {
      options.onDiagnostic?.({ reasonCode: generated.reasonCode, type: "joi.partner.context_summary_failed" });
      return false;
    }
    const now = new Date().toISOString();
    checkpoint = {
      compactedMessages: (checkpoint?.compactedMessages ?? 0) + segment.length,
      count: (checkpoint?.count ?? 0) + 1,
      cut,
      lastCompactedAt: now,
      messagesBefore: messages.length,
      summary: generated.summary,
      tokensBefore: tokensIn(0, messages.length),
    };
    options.onDiagnostic?.({
      compactedMessages: checkpoint.compactedMessages,
      count: checkpoint.count,
      tokensBefore: checkpoint.tokensBefore,
      type: "joi.partner.context_compacted",
    });
    return true;
  };

  return {
    checkpoint: () => checkpoint,
    transformContext: async (messages, signal) => {
      try {
        price(messages);
        const floor = anchorEnd(messages);
        // No checkpoint means nothing has been summarized yet, so the whole transcript after the
        // anchors is the tail and the request is the transcript unchanged.
        let cut = checkpoint === undefined ? floor : Math.max(floor, checkpoint.cut);
        const standing = summaryChars();
        if (!overBudget(messages, cut, floor, standing)) return assemble(messages, cut);
        if (await compact(messages, floor, signal)) {
          cut = Math.max(floor, checkpoint?.cut ?? floor);
          if (!overBudget(messages, cut, floor, summaryChars())) return assemble(messages, cut);
        }
        return trimWithNotice(messages, floor);
      } catch {
        // pi's contract for this hook is that it must not throw or reject: throwing interrupts the
        // agent loop without a normal event sequence. A request that is merely too large is
        // recoverable; a broken loop is not, so the fallback is the bounded one.
        options.onDiagnostic?.({ reasonCode: "compaction_threw", type: "joi.partner.context_summary_failed" });
        try {
          return trimWithNotice(messages, anchorEnd(messages));
        } catch {
          return messages;
        }
      }
    },
  };
}
