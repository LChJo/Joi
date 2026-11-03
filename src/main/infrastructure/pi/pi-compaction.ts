import {
  BACKGROUND_CONTEXT,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  generateSummary,
  withAbortSignal,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";

/**
 * The pieces both pi runtimes need to compact a conversation.
 *
 * They differ in where the compacted history lives — the reasoning runtime owns its session and
 * rewrites the transcript, while a partner run may only reshape one request — but they must agree on
 * what a checkpoint *is*. Two independently written summary calls would drift in their instructions
 * and in the shape of the message left behind, and a transcript carried between them would read
 * differently depending on which side wrote it.
 */

/** Marks a summary message as a checkpoint, and is how a restored transcript recognises one. */
export const CHECKPOINT_MARKER = "[joi session checkpoint]";

export const SUMMARY_INSTRUCTIONS = "Preserve the current task, effective mandatory requirements, permissions, acceptance conditions, decisions, work status, conclusion endings, evidence references, conflicting evidence, and unresolved questions. Do not invent facts. Preserve identifiers for paginated evidence and context_read_history so omitted details remain retrievable.";

export const HISTORY_SOFT_TRIGGER_CHARS = 128_000;
export const HISTORY_SOFT_TARGET_CHARS = 64_000;

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

export type SummarizeResult =
  | { ok: true; summary: string }
  | { ok: false; reasonCode: string };

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
}): Promise<SummarizeResult> {
  try {
    const generated = await generateSummary(
      [...input.segment],
      input.models,
      input.model,
      input.reserveTokens,
      SUMMARY_INSTRUCTIONS,
      input.previousSummary,
      input.thinkingLevel,
      // No retry policy and no callbacks: a summary that fails is reported to the caller, which is
      // better placed to decide whether to retry the whole compaction than this call is.
      undefined,
      undefined,
      // A summary is not part of a user turn, and it must be cancellable when the run is — the
      // signal moved out of the argument list into the context, so cancellation is derived here.
      input.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(input.signal, BACKGROUND_CONTEXT),
    );
    if (!generated.ok) return { ok: false, reasonCode: generated.error.code };
    if (generated.value.trim() === "") return { ok: false, reasonCode: "summary_empty" };
    return { ok: true, summary: generated.value };
  } catch (error) {
    return {
      ok: false,
      reasonCode: error instanceof Error && error.name !== "" ? error.name.slice(0, 60) : "summary_threw",
    };
  }
}

/**
 * An explicit account of history a request could not hold, written to the model rather than left as
 * an absence.
 *
 * The failure this prevents was observed in a production run: a model that finds work on disk it
 * does not remember doing has no way to tell "my history was trimmed" from "another process changed
 * my files", and the second reading is the one it reached for. Naming the drop as this run's own
 * decision is what makes that inference unavailable.
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
