import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

import { checkpointMessage, HISTORY_SOFT_TARGET_CHARS, HISTORY_SOFT_TRIGGER_CHARS, isCheckpointMessage, omissionNotice, summarizeSegment, taskAnchorIndices, transcriptFingerprint, SummaryRetryGuard, summaryCandidateKey, summarySavings, SUMMARY_TARGET_CHARS, SUMMARY_HARD_WAIT_MS, type SummarizeResult, type SummaryGenerationDiagnostic } from "./pi-compaction.js";
import { compactionReserveTokens, leadingSystemMessage } from "./pi-model-budget.js";
import type { SummaryRetryState } from "../../application/ports/summary-state.js";

/**
 * Request checkpoints and one background job belong to the execution session. Transforming a
 * request never rewrites the Agent's canonical source transcript; final bodies, UI history and
 * context_read_history continue to read that complete source. Only the session owner collects a
 * result after validating its frozen prefix, parent checkpoint and execution epoch.
 */

/** How much of the tail survives a compaction, in pi's own token estimate. */
const KEEP_RECENT_TOKENS = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

/** Share of the message budget the retained tail may take; the rest covers anchors and the summary. */
const TAIL_SHARE = 0.5;

export type PiContextDiagnostic =
  | (SummaryGenerationDiagnostic & { type: "joi.context.summary_generated" })
  | { type: "joi.context.summary_boundary"; stage: "hard_wait" | "cleanup"; durationMs: number; outcome: "ready" | "deadline" | "canceled" | "idle" }
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
  softPending?: boolean;
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
  /** Input planning headroom, independent of the model's summary output allowance. */
  reserveTokens?: number;
  /** Source/model revisions form the retry identity; permission phases do not. */
  routeRevision?: string;
  retryGuard?: SummaryRetryGuard;
  retryState?: SummaryRetryState;
  maxSummaryCharacters?: number;
  maxMessages?: number;
  keepRecentMessages?: number;
  summaryTimeoutMs?: number;
  hardWaitMs?: number;
  /** Checks refreshed policy, required context, tool declarations and output headroom together. */
  fitsRequest?: (messages: readonly AgentMessage[]) => boolean;
  /** An execution owner can keep background work across an SDK permission-phase abort. */
  backgroundSignal?: AbortSignal | null;
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
  retryState: () => SummaryRetryState | undefined;
  /** Collect already completed work; the session owner alone may commit coverage. */
  collect: (messages: readonly AgentMessage[]) => void;
  cancel: () => void;
  /** Finish the owned job before persisting or releasing its execution boundary. */
  close: (messages: readonly AgentMessage[], canceled?: boolean) => Promise<void>;
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
  const retry = options.retryGuard ?? new SummaryRetryGuard(options.now, options.retryState);
  const routeKey = summaryCandidateKey([options.routeRevision, options.model.provider, options.model.id, options.model.contextWindow, options.model.maxTokens]);
  const summaryMaxChars = options.maxSummaryCharacters ?? SUMMARY_TARGET_CHARS;
  let softCampaign = options.restored?.softPending === true;
  let epoch = 0;
  interface Candidate {
    cut: number;
    segment: AgentMessage[];
    anchors: number[];
    fingerprint: string;
    parent: PiContextCheckpoint | undefined;
    tokensBefore: number;
    messagesBefore: number;
  }
  let flight: { candidate: Candidate; controller: AbortController; promise: Promise<void>; result: SummarizeResult | undefined; epoch: number; startedAt: number } | undefined;
  const report = (event: PiContextDiagnostic): void => { try { options.onDiagnostic?.(event); } catch { /* Diagnostics cannot affect request preparation. */ } };
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
    if (messages.length > (options.maxMessages ?? Number.POSITIVE_INFINITY) && options.keepRecentMessages !== undefined) {
      index = Math.max(index, messages.length - options.keepRecentMessages);
    }
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
  const hardOverflow = (request: readonly AgentMessage[]): boolean => JSON.stringify(request).length > options.messagesMaxChars || options.fitsRequest?.(request) === false;
  const historyChars = (request: readonly AgentMessage[]): number => request.filter(message => message.role !== "system")
    .reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  const softOverflow = (request: readonly AgentMessage[]): boolean => {
    const chars = historyChars(request);
    if (chars >= HISTORY_SOFT_TRIGGER_CHARS) softCampaign = true;
    if (chars <= HISTORY_SOFT_TARGET_CHARS) softCampaign = false;
    return softCampaign || request.length > (options.maxMessages ?? Number.POSITIVE_INFINITY);
  };

  /**
   * A hard-capacity fallback omits older uncovered history with an explicit notice and preserves
   * required anchors and the latest complete tool exchange.
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
      if (!hardOverflow(request)) break;
    }
    if (omitted > 0) report({ omittedChars,omittedMessages: omitted,type: "joi.partner.context_truncated" });
    return request;
  };

  const candidateFor = (messages: readonly AgentMessage[], floor: number): Candidate | undefined => {
    const from = checkpoint === undefined ? floor : Math.max(floor, checkpoint.cut);
    const target = Math.max(from, targetCut(messages, floor));
    const end = cutAt(messages, target, floor + 1);
    if (end === undefined || end <= from) return undefined;
    const anchors = taskAnchorIndices(messages);
    const released = (checkpoint?.preservedIndices ?? []).filter(index => index < from && !anchors.includes(index))
      .map(index => messages[index]).filter((message): message is AgentMessage => message !== undefined);
    const capacity = options.model.contextWindow > 0 ? Math.max(1, options.model.contextWindow - (checkpoint?.summary.length ?? 0) - settings.reserveTokens - 4096) : HISTORY_SOFT_TARGET_CHARS;
    const batchChars = Math.min(HISTORY_SOFT_TARGET_CHARS, capacity);
    let cut = from;
    for (let next = from + 1; next <= end; next += 1) {
      if (messages[next]?.role !== "user" && messages[next]?.role !== "assistant") continue;
      const portion = [...released, ...messages.slice(from, next).filter((message, index) => message.role !== "system" && !isCheckpointMessage(message) && !anchors.includes(from + index))];
      if (JSON.stringify(portion).length > batchChars && cut > from) break;
      cut = next;
      if (JSON.stringify(portion).length >= batchChars) break;
    }
    if (cut <= from) return undefined;
    const segment = [...released, ...messages.slice(from, cut).filter((message, index) => message.role !== "system" && !isCheckpointMessage(message) && !anchors.includes(from + index))];
    if (segment.length === 0) return undefined;
    return { cut, segment: structuredClone(segment), anchors, fingerprint: transcriptFingerprint(messages, cut), parent: checkpoint,
      messagesBefore: messages.length, tokensBefore: tokensIn(0, messages.length) };
  };

  const cancel = (): void => { epoch += 1; flight?.controller.abort(); };
  const collect = (messages: readonly AgentMessage[]): void => {
    const done = flight;
    if (done?.result === undefined) return;
    flight = undefined;
    const { candidate, result } = done;
    if (done.epoch !== epoch || done.controller.signal.aborted || checkpoint !== candidate.parent
      || candidate.cut > messages.length || candidate.fingerprint !== transcriptFingerprint(messages, candidate.cut)) return;
    if (!result.ok || result.summary.length > summaryMaxChars) {
      const reasonCode = result.ok ? "summary_exceeds_capacity" : result.reasonCode;
      report({ reasonCode, type: "joi.partner.context_summary_failed" });
      if (reasonCode !== "summary_canceled") retry.failed(routeKey);
      return;
    }
    const previous = checkpoint;
    const before = assemble(messages, checkpoint?.cut ?? anchorEnd(messages));
    checkpoint = {
      routeKey,
      compactedMessages: (checkpoint?.compactedMessages ?? 0) + candidate.segment.length,
      count: (checkpoint?.count ?? 0) + 1,
      cut: candidate.cut,
      lastCompactedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      messagesBefore: candidate.messagesBefore,
      summary: result.summary,
      tokensBefore: candidate.tokensBefore,
      sourceFingerprint: candidate.fingerprint,
      preservedIndices: candidate.anchors.filter(index => index < candidate.cut),
    };
    checkpoint.softPending = softCampaign && historyChars(assemble(messages, candidate.cut)) > HISTORY_SOFT_TARGET_CHARS;
    const savings = summarySavings(before,assemble(messages,candidate.cut));
    if (savings.savedChars <= 0) {
      checkpoint = previous;retry.failed(routeKey);
      report({ ...savings,reasonCode: "summary_no_savings",type: "joi.partner.context_summary_rejected" });
      return;
    }
    retry.reset();
    report({
      compactedMessages: checkpoint.compactedMessages,
      count: checkpoint.count,
      tokensBefore: checkpoint.tokensBefore,
      charsBefore: savings.charsBefore,
      charsAfter: savings.charsAfter,
      durationMs: Math.max(0, performance.now() - done.startedAt),
      runtime: "pi",
      type: "joi.partner.context_compacted",
    });
  };

  const start = (messages: readonly AgentMessage[], floor: number, signal: AbortSignal | undefined): void => {
    if (flight !== undefined || signal?.aborted) return;
    const retryAfterMs = retry.remaining(routeKey);
    if (retryAfterMs > 0) { report({ retryAfterMs, type: "joi.partner.context_summary_backoff" }); return; }
    const candidate = candidateFor(messages, floor);
    if (candidate === undefined) return;
    const controller = new AbortController();
    const job = { candidate, controller, epoch, startedAt: performance.now(), promise: Promise.resolve(), result: undefined as SummarizeResult | undefined };
    flight = job;
    report({ candidateChars: JSON.stringify(candidate.segment).length, type: "joi.partner.context_summary_started" });
    const parentSignal = options.backgroundSignal === undefined ? signal : options.backgroundSignal;
    job.promise = summarizeSegment({ model: options.model, models: options.models, segment: candidate.segment,
      previousSummary: candidate.parent?.summary, reserveTokens: settings.reserveTokens, thinkingLevel: "off",
      targetChars: summaryMaxChars, ...(options.summaryTimeoutMs === undefined ? {} : { timeoutMs: options.summaryTimeoutMs }),
      signal: parentSignal == null ? controller.signal : AbortSignal.any([parentSignal, controller.signal]),
      onDiagnostic: diagnostic => report({ ...diagnostic, type: "joi.context.summary_generated" }),
    }).then(result => { job.result = result; });
  };

  const wait = async (promise: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = performance.now();
    let outcome: "ready" | "deadline" = "ready";
    try { outcome = await Promise.race([promise.then(() => "ready" as const), new Promise<"deadline">(resolve => { timer = setTimeout(() => { resolve("deadline"); }, options.hardWaitMs ?? SUMMARY_HARD_WAIT_MS); })]); }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      report({ type: "joi.context.summary_boundary", stage: "hard_wait", durationMs: Math.max(0, performance.now() - startedAt), outcome });
    }
  };

  return {
    checkpoint: () => checkpoint,
    retryState: () => retry.snapshot(),
    collect,
    cancel,
    close: async (messages, canceled = false) => {
      const startedAt = performance.now();
      if (!canceled) collect(messages);
      const pending = flight;
      cancel();
      await pending?.promise;
      collect(messages);
      report({ type: "joi.context.summary_boundary", stage: "cleanup", durationMs: Math.max(0, performance.now() - startedAt), outcome: pending === undefined ? "idle" : "canceled" });
    },
    transformContext: async (messages, signal) => {
      const finish = (request: AgentMessage[]): AgentMessage[] => {
        report({
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
          || checkpoint.sourceFingerprint !== transcriptFingerprint(messages, checkpoint.cut))) { cancel(); checkpoint = undefined; }
        collect(messages);
        const floor = anchorEnd(messages);
        // No checkpoint means nothing has been summarized yet, so the whole transcript after the
        // anchors is the tail and the request is the transcript unchanged.
        let request = assemble(messages, checkpoint === undefined ? floor : Math.max(floor, checkpoint.cut));
        if (!softOverflow(request) && !hardOverflow(request)) return finish(request);
        start(messages, floor, signal);
        if (!hardOverflow(request)) return finish(request);
        if (flight !== undefined) await wait(flight.promise);
        collect(messages);
        request = assemble(messages, checkpoint === undefined ? floor : Math.max(floor, checkpoint.cut));
        return finish(hardOverflow(request) ? trimWithNotice(messages, floor) : request);
      } catch {
        // pi's contract for this hook is that it must not throw or reject: throwing interrupts the
        // agent loop without a normal event sequence. A request that is merely too large is
        // recoverable; a broken loop is not, so the fallback is the bounded one.
        report({ reasonCode: "compaction_threw", type: "joi.partner.context_summary_failed" });
        try {
          return finish(trimWithNotice(messages, anchorEnd(messages)));
        } catch {
          return messages;
        }
      }
    },
  };
}
