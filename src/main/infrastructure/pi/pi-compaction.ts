import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getSupportedThinkingLevels, type Api, type Model, type Models, type AssistantMessage } from "@earendil-works/pi-ai";
import type { SummaryRetryState } from "../../application/ports/summary-state.js";
import { sessionAssistant } from "./conversation-session.js";
import { createHash } from "node:crypto";
import { modelRequiresAlwaysOnThinking } from "./provider-presets.js";

/**
 * Both Pi runtimes share summary validation, failure protection and checkpoint framing. Their
 * session owners retain responsibility for durable history and request-only projections.
 */

/** Marks a summary message as a checkpoint, and is how a restored transcript recognises one. */
export const CHECKPOINT_MARKER = "[joi session checkpoint]";
const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

export const SUMMARY_INSTRUCTIONS = "Preserve the current task, effective mandatory requirements, permissions, acceptance conditions, decisions, work status, conclusion endings, evidence references, conflicting evidence, and unresolved questions. Do not invent facts. Preserve identifiers for paginated evidence and context_read_history so omitted details remain retrievable.";

export const HISTORY_SOFT_TRIGGER_CHARS = 128_000;
export const HISTORY_SOFT_TARGET_CHARS = 64_000;
export const SUMMARY_TARGET_CHARS = 8_000;
export const SUMMARY_TIMEOUT_MS = 60_000;
export const SUMMARY_HARD_WAIT_MS = 5_000;

/** Failure protection belongs to the session's pinned route, independently of appended source. */
export class SummaryRetryGuard {
  #failure: SummaryRetryState | undefined;
  constructor(private readonly now: () => number = Date.now, restored?: SummaryRetryState) {
    if (restored !== undefined && typeof restored.routeKey === "string" && /^[a-f0-9]{64}$/u.test(restored.routeKey)
      && Number.isSafeInteger(restored.failures) && restored.failures > 0 && Number.isFinite(restored.until) && restored.until >= 0) this.#failure = { ...restored };
  }
  remaining(routeKey: string): number { return this.#failure?.routeKey === routeKey ? Math.max(0, this.#failure.until - this.now()) : 0; }
  failed(routeKey: string): void {
    const failures = Math.min(3, (this.#failure?.routeKey === routeKey ? this.#failure.failures : 0) + 1);
    this.#failure = { routeKey, failures, until: this.now() + ([30_000, 120_000, 300_000][failures - 1] ?? 300_000) };
  }
  snapshot(): SummaryRetryState | undefined { return this.#failure === undefined ? undefined : { ...this.#failure }; }
  reset(): void { this.#failure = undefined; }
}

export function summaryCandidateKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Includes framing, anchors and checkpoint markers exactly as present in the outgoing view. */
export function summarySavings(before: readonly AgentMessage[],after: readonly AgentMessage[]) {
  const charsBefore = JSON.stringify(before).length,charsAfter = JSON.stringify(after).length;
  return { charsBefore,charsAfter,savedChars: charsBefore - charsAfter };
}

/** Request prompts are refreshed independently; coverage identifies only the private transcript. */
export function transcriptFingerprint(messages: readonly AgentMessage[], cut: number): string {
  const digest = createHash("sha256");
  for (let index = 0; index < cut; index += 1) {
    const message = messages[index];
    if (message?.role !== "system") digest.update(JSON.stringify(message)).update("\n");
  }
  return digest.digest("hex");
}

/** The initial goal and the current user instruction survive independently of summary quality. */
export function taskAnchorIndices(messages: readonly AgentMessage[]): number[] {
  const first = messages.findIndex(message => message.role === "user" && !isCheckpointMessage(message));
  const last = messages.findLastIndex(message => message.role === "user" && !isCheckpointMessage(message));
  return [...new Set([first, last])].filter(index => index >= 0);
}

/** The text of a checkpoint message, in the shape both runtimes write and both can read back. */
export function checkpointText(summary: string): string {
  return `${COMPACTION_SUMMARY_PREFIX}${CHECKPOINT_MARKER}\n${summary}${COMPACTION_SUMMARY_SUFFIX}`;
}

/**
 * The message a compaction leaves behind.
 *
 * The summary travels as a plain user message rather than as pi's own `compactionSummary` role,
 * because the Agent's default `convertToLlm` keeps only the four roles a provider understands and
 * would drop it. Wrapping the text in pi's delimiters produces the same bytes on the wire as pi's
 * own conversion does, without a second `convertToLlm` that could swallow the system prompt.
 */
export function checkpointMessage(summary: string, timestampMillis: number): AgentMessage {
  return {
    content: [{ text: checkpointText(summary), type: "text" }],
    role: "user",
    timestamp: timestampMillis,
  };
}

/** Whether a message is a checkpoint. Reads both the block and the older plain-string shape. */
export function isCheckpointMessage(message: AgentMessage | undefined): boolean {
  if (message === undefined) return false;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.includes(CHECKPOINT_MARKER);
  if (!Array.isArray(content)) return false;
  return content.some((block) => block !== null && typeof block === "object"
    && typeof (block as { text?: unknown }).text === "string"
    && (block as { text: string }).text.includes(CHECKPOINT_MARKER));
}

export type SummaryFailureReason = "summary_truncated" | "summary_canceled" | "summary_incomplete" | "summary_provider_error"
  | "summary_tool_call" | "summary_empty" | "summary_input_capacity" | "summary_timed_out" | "summary_threw";
const RESPONSE_FAILURES: Partial<Record<AssistantMessage["stopReason"], SummaryFailureReason>> = {
  length: "summary_truncated", aborted: "summary_canceled", pending: "summary_incomplete", deferred: "summary_incomplete",
  error: "summary_provider_error", toolUse: "summary_tool_call",
};

export interface SummaryGenerationDiagnostic {
  reasonCode: SummaryFailureReason | "summary_generated";
  stopReason: AssistantMessage["stopReason"] | "unknown";
  durationMs: number;
  inputChars: number;
  outputChars: number;
  outputTokens: number;
  maxOutputTokens: number;
}

export type SummarizeResult =
  | { ok: true; summary: string }
  | { ok: false; reasonCode: SummaryFailureReason };

/**
 * Summarizes one segment of a conversation, updating the previous summary when there is one.
 *
 * `previousSummary` is what keeps a long run affordable: pi switches to its update prompt, which
 * preserves what the earlier summary already established and moves work from in-progress to done,
 * so each compaction reads only what is new instead of re-reading the whole prefix.
 *
 * Failures come back as a reason code rather than an exception. A provider that refuses to
 * summarize is a condition both callers must survive — the reasoning runtime keeps the transcript
 * it has, the partner runtime bounds the request and says so — and neither should be interrupted by
 * a throw from inside a hook pi requires not to throw.
 */
export async function summarizeSegment(input: {
  segment: readonly AgentMessage[];
  models: Models;
  model: Model<Api>;
  reserveTokens: number;
  /** `undefined` explicitly, because callers forward a checkpoint that may not exist yet. */
  previousSummary?: string | undefined;
  signal?: AbortSignal | undefined;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  targetChars?: number;
  timeoutMs?: number;
  onDiagnostic?: (event: SummaryGenerationDiagnostic) => void;
}): Promise<SummarizeResult> {
  const controller = new AbortController();
  const signal = input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal]);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, input.timeoutMs ?? SUMMARY_TIMEOUT_MS);
  timer.unref();
  const startedAt = performance.now();
  let reason: SummaryFailureReason | undefined;
  const currentFailure = (): SummaryFailureReason | undefined => reason;
  let response: AssistantMessage | undefined;
  let inputChars = 0, maxOutputTokens = 0;
  const supported = getSupportedThinkingLevels(input.model);
  const requiredThinking = modelRequiresAlwaysOnThinking(input.model.baseUrl);
  const thinking = supported.includes("off") && !requiredThinking ? "off"
    : requiredThinking && supported.includes("low") ? "low" : supported.find(level => level !== "off") ?? "off";
  const canceledReason = (): SummaryFailureReason => timedOut ? "summary_timed_out" : "summary_canceled";
  const isCanceled = (): boolean => signal.aborted;
  try {
    if (signal.aborted) return { ok: false, reasonCode: reason = canceledReason() };
    const generated = await generateSummary(
      [...input.segment],
      input.model,
      input.reserveTokens,
      undefined,
      undefined,
      signal,
      `${SUMMARY_INSTRUCTIONS} Keep the summary within ${String(input.targetChars ?? SUMMARY_TARGET_CHARS)} characters.`,
      input.previousSummary,
      thinking,
      (model,context,options) => {
        const stream = createAssistantMessageEventStream();
        inputChars = JSON.stringify(context).length;
        const outputCapacity = Math.max(1, Math.floor(model.maxTokens));
        const available = model.contextWindow > 0 ? model.contextWindow - inputChars - Math.min(1024, Math.ceil(model.contextWindow * 0.05)) : outputCapacity;
        maxOutputTokens = Math.max(0, Math.min(outputCapacity, Math.floor(available)));
        let ended = false;
        const finish = (value: AssistantMessage, fromProvider = false): void => {
          if (ended) return;
          ended = true;
          signal.removeEventListener("abort", abort);
          if (fromProvider) response = value;
          if (value.stopReason === "error" || value.stopReason === "aborted" || value.stopReason === "pending") stream.push({ type: "error", reason: value.stopReason === "aborted" ? "aborted" : "error", error: value });
          else stream.push({ type: "done", reason: value.stopReason, message: value });
          stream.end(value);
        };
        const failure = (): AssistantMessage => ({ ...sessionAssistant([]), stopReason: "error", errorMessage: "summary_failed" }) as AssistantMessage;
        const abort = (): void => { reason = canceledReason(); finish(failure()); };
        if (maxOutputTokens < 1) { reason = "summary_input_capacity"; finish(failure()); return stream; }
        if (signal.aborted) { abort(); return stream; }
        signal.addEventListener("abort", abort, { once: true });
        const requestOptions = { ...options, signal, maxTokens: maxOutputTokens };
        if (thinking === "off") delete requestOptions.reasoning;
        else requestOptions.reasoning = thinking;
        const summaryModel = { ...model, maxTokens: maxOutputTokens };
        // The configured Models boundary owns transport and credentials; no SDK discovery is used.
        void Promise.resolve().then(() => signal.aborted ? failure() : input.models.completeSimple(summaryModel, context, requestOptions)).then(value => {
          if (signal.aborted) { abort(); return; }
          if (value.stopReason !== "stop") reason = RESPONSE_FAILURES[value.stopReason] ?? "summary_incomplete";
          else if (value.content.some(block => block.type === "toolCall")) reason = "summary_tool_call";
          finish(value, true);
        }, () => { reason ??= signal.aborted ? canceledReason() : "summary_provider_error"; finish(failure()); });
        return stream;
      },
      undefined,
      { enabled: false,maxRetries: 0,baseDelayMs: 0 },
    );
    if (isCanceled()) reason = canceledReason();
    const failureReason = currentFailure();
    if (failureReason !== undefined) return { ok: false, reasonCode: failureReason };
    if (generated.trim() === "") return { ok: false, reasonCode: reason = "summary_empty" };
    return { ok: true, summary: generated };
  } catch {
    reason ??= signal.aborted ? canceledReason() : "summary_threw";
    return { ok: false, reasonCode: reason };
  } finally {
    clearTimeout(timer);
    const outputChars = response?.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0) ?? 0;
    const measured = response?.usage.output ?? 0;
    try { input.onDiagnostic?.({ reasonCode: reason ?? "summary_generated", stopReason: response?.stopReason ?? "unknown",
      durationMs: Math.max(0, performance.now() - startedAt), inputChars, outputChars,
      outputTokens: Number.isFinite(measured) && measured >= 0 ? measured : 0, maxOutputTokens }); } catch { /* Observers cannot change summary behavior. */ }
  }
}

/**
 * Omitted history remains retrievable and establishes no summary coverage or permission to replay
 * actions. The request names that gap explicitly rather than implying external workspace changes.
 */
export function omissionNotice(omittedMessages: number, omittedChars: number): AgentMessage {
  return {
    content: [{
      text: `[joi context notice] ${String(omittedMessages)} earlier messages of this run were left out of this one`
        + ` request to keep it inside the model window (${String(omittedChars)} characters over budget). They were not`
        + " lost; no other process modified your workspace. They are NOT covered by the checkpoint above. Use context_read_history"
        + " with offset=0 and limit=8000 to inspect the retained history and page through it. An omitted message"
        + " is not evidence that no prior work or evidence exists.",
      type: "text",
    }],
    role: "user",
    timestamp: Date.now(),
  };
}
