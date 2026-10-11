/* Pi hooks require Promise-returning callbacks. */
/* eslint-disable @typescript-eslint/require-await */
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { DomainError } from "../../domain/errors.js";
import { normalizeContext, type Api, type Context, type ImageContent, type Message, type Model, type ModelThinkingLevel, type Models } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";

import { checkpointMessage, isCheckpointMessage, omissionNotice, summarizeSegment } from "./pi-compaction.js";
import { withRequestPrompt } from "./pi-request-prompt.js";
import { boundBackgroundSections, boundRequestByChars, leadingSystemMessage, modelContextMaxChars, modelRequestBudget } from "./pi-model-budget.js";
import type { UsageRecorder, UsageContext } from "../../application/ports/usage.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";
import { GOAL_REQUIREMENTS_MAX_CHARS } from "../../application/ports/goal-requirements.js";
import { trackPiModels, trackPiStream } from "./pi-usage.js";
import type {
  JoiReasoningSessionSnapshot,
  JoiReasoningOutcome,
  PrimaryReasoningEvent,
  PrimaryReasoningRuntime,
  ReasoningSessionStore,
  StartReasoningTurnInput,
} from "../../application/ports/primary-reasoning-runtime.js";

export const JOI_REASONING_TOOL_NAMES = [
  "goal_read_inputs", "goal_update_requirements", "work_list_goal", "work_read_brief", "work_update_brief",
  "workbench_list_summaries",
  "workbench_select",
  "workbench_create",
  "workbench_bind_workspace",
  "workbench_suggest_merge",
  "workbench_suggest_archive",
  "model_list_sources",
  "partner_list_skills",
  "joi_read_skill",
  "partner_list_available",
  "partner_inspect_revision",
  "partner_create",
  "partner_set_model",
  "partner_set_skills",
  "partner_set_tools",
  "partner_create_instance",
  "partner_list_instances",
  "partner_dispose_instance",
  "work_create",
  "work_add_dependency",
  "work_dispatch",
  "work_supplement",
  "work_read_result",
  "attachment_read",
  "work_wait",
  "work_cancel",
  "work_reassign",
  "work_resume",
  "memory_search",
  "memory_append_candidate",
  "schedule_plan",
  "create_automation",
  "list_automations",
  "get_automation",
  "update_automation",
  "delete_automation",
  "run_automation_now",
  "goal_resume",
  "user_ask",
  "turn_complete",
  "harness_name_destination",
  "harness_chart_path",
  "harness_record_decision",
  "harness_note_fog",
] as const;

const allowedToolNames = new Set<string>(JOI_REASONING_TOOL_NAMES);
const HISTORY_OMISSION_RESERVE_CHARS = 1_024;

interface PiReasoningRuntimeOptions {
  diagnostics?: RuntimeDiagnostics;
  usage?: UsageRecorder;
  /**
   * Any field left out falls back to DEFAULT_COMPACTION. Only `compactAtPercent` is reachable
   * from the settings page (it is set per model); the rest stay runtime defaults, because a
   * percent threshold scales with the route's window while a message count does not.
   */
  compaction?: Partial<ResolvedCompactionOptions>;
  model: Model<Api>;
  models: Models;
  sessionStore: ReasoningSessionStore;
  /** The level every request on this route runs at, resolved once from the model source. */
  thinkingLevel: ModelThinkingLevel;
  /** Fixed tools, or a per-turn factory when tool closures bind turn context (inputId/turnId). */
  tools: AgentTool[] | ((input: StartReasoningTurnInput) => AgentTool[]);
}

interface SessionRuntime {
  requirementsError: DomainError | undefined;
  agent: Agent;
  current: StartReasoningTurnInput | undefined;
  /** Whether this Turn started a tool whose effects may need to stay in the transcript. */
  delivered: { tool: boolean };
  /** A successful user_ask or structured dispatch rejection intentionally stopped the stream. */
  terminatedByTool: boolean;
  metadata: Omit<JoiReasoningSessionSnapshot, "messages" | "updatedAt">;
  /**
   * Where this Turn's transcript began, so a Turn that fails without committing anything can be
   * taken back out of the session instead of being replayed into the next attempt.
   *
   * A failed Turn is re-queued and prompted again on this same session. Whatever it wrote stays
   * in the history and is read back as this run's own precedent — a Turn that answered with its
   * tool calls written as plain text taught every retry to do the same, and the retries degraded
   * identically until the crash-loop breaker parked the input. Removing the failed attempt is
   * what makes a retry an actual retry.
   *
   * A snapshot of the whole message array rather than one anchor message: compaction only ever
   * drops a prefix and reuses the surviving message objects, but the array itself is replaced on
   * every write, and a boundary that can go missing needs a fallback path this does not.
   */
  rollbackPoint: {
    compaction: Omit<JoiReasoningSessionSnapshot, "messages" | "updatedAt">["compaction"];
    messages: AgentMessage[];
    turnId: string;
  } | undefined;
}

function streamStoppedByTool(session: SessionRuntime): boolean {
  return session.terminatedByTool;
}

/**
 * Output headroom a Turn needs (thinking budget plus a visible answer). When the estimated
 * context leaves less than this, pi-ai clamps max_tokens toward 1 and providers reject the
 * request, so the session must be compacted before prompting instead of after the damage.
 * The configured threshold normally exceeds this; it is the floor for routes so small that a
 * percentage of the window would leave too little to write the summary itself.
 */
const COMPACTION_MIN_OUTPUT_HEADROOM = 4_096;
/** Progressively smaller tails tried when an overflowing session is compacted by token budget. */
const COMPACTION_TAIL_STEPS = [32, 16, 8, 4, 2] as const;

/** The threshold may not be the whole window: by then the provider has already clamped
 *  max_tokens toward 1, which is the failure compaction exists to prevent. */
const COMPACTION_PERCENT_FLOOR = 50;
const COMPACTION_PERCENT_CEILING = 95;
const COMPACTION_DEFAULT_PERCENT = 85;

const DEFAULT_COMPACTION = {
  compactAtPercent: COMPACTION_DEFAULT_PERCENT,
  keepRecentMessages: 80,
  maxMessages: 200,
  maxSummaryCharacters: 12_000,
} as const;

/**
 * The output headroom a percent threshold implies. "Compact once the input reaches p% of the
 * window" and "leave (100−p)% of the window free for output" are the same inequality, so the
 * threshold folds into the existing check without changing how it is evaluated — pi-ai's own
 * estimate and safety margin still do the counting.
 *
 * Exported so the contract test can pin the arithmetic directly: measuring it through a real
 * session would need a hundred thousand tokens of input to separate two thresholds.
 */
export function compactionHeadroom(contextWindow: number, compactAtPercent: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return COMPACTION_MIN_OUTPUT_HEADROOM;
  return Math.max(COMPACTION_MIN_OUTPUT_HEADROOM, Math.floor(contextWindow * (1 - compactAtPercent / 100)));
}

interface ResolvedCompactionOptions {
  compactAtPercent: number;
  keepRecentMessages: number;
  maxMessages: number;
  maxSummaryCharacters: number;
}

function roleOf(message: AgentMessage | undefined): string | undefined {
  return message !== undefined && "role" in message
    && typeof message.role === "string" ? message.role : undefined;
}

/**
 * An assistant turn that carries nothing at all.
 *
 * A stream killed mid-flight leaves one behind — answering a parked question aborts the turn
 * that asked it — and an assistant message with no content is not a legal request input for
 * most providers. It survives every save and restore, so once a session had one it kept
 * re-sending it. The session that was diagnosed with this then answered with its tool calls
 * written as plain text instead of native calls, which downstream reads as turns that never
 * called the tool they were required to call: the goal kept failing its resume gate, retried
 * on the same transcript, and degraded the same way until the crash-loop breaker parked it.
 *
 * Dropping it belongs here rather than at the write site. This method is the one place that
 * shapes a request, so the same filter covers the live transcript and the history read back
 * from the store. It is silent on purpose: the message has no content, so its absence tells
 * the model nothing that `omissionNotice` — written to explain history a request was too
 * small to hold — would not misstate.
 */
function isEmptyAssistantMessage(message: AgentMessage): boolean {
  if (roleOf(message) !== "assistant") return false;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.length === 0;
}

function fallbackSummary(messages: AgentMessage[], maxCharacters: number): string {
  const lines = messages.map((message) => {
    const record = message as unknown as Record<string, unknown>;
    const content = typeof record.content === "string"
      ? record.content
      : JSON.stringify(record.content);
    return `${typeof record.role === "string" ? record.role : "event"}: ${content}`;
  });
  return lines.join("\n").slice(0, maxCharacters);
}

function validateToolNames(tools: AgentTool[]): void {
  const unsafeTool = tools.find((tool) => !allowedToolNames.has(tool.name));
  if (unsafeTool !== undefined) {
    throw Object.assign(new Error("A registered reasoning tool is not allowlisted."), { code: "unsafe_reasoning_tool" });
  }
}

function safeToolResultReasonCode(result: unknown): string | undefined {
  const parsed = safeToolResultRecord(result);
  if (parsed === undefined) return undefined;
  if (parsed.status === "RETRY_REQUIRED") return undefined;
  const reasonCode = parsed.reasonCode;
  return typeof reasonCode === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(reasonCode) ? reasonCode : undefined;
}

function safeToolResultRecord(result: unknown): Record<string, unknown> | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find((item: unknown): item is { text: string } => {
    if (item === null || typeof item !== "object") return false;
    return typeof (item as { text?: unknown }).text === "string";
  });
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.text);
    return parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      ? undefined
      : parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function safeTurnOutcome(toolName: string, result: unknown): JoiReasoningOutcome | undefined {
  if (toolName !== "turn_complete") return undefined;
  const outcome = safeToolResultRecord(result)?.outcome;
  return outcome === "DIRECT_ANSWER" || outcome === "TEAM_READY" || outcome === "RESULT_SYNTHESIZED" || outcome === "RESULT_CONTINUE" || outcome === "RESULT_BLOCKED" || outcome === "MAP_CLEARED"
    ? outcome
    : undefined;
}

export class PiReasoningRuntime implements PrimaryReasoningRuntime {
  readonly #diagnostics: RuntimeDiagnostics | undefined;
  readonly #model: Model<Api>;
  readonly #models: Models;
  readonly #thinkingLevel: ModelThinkingLevel;
  readonly #usage: UsageRecorder | undefined;
  readonly #compaction: ResolvedCompactionOptions;
  readonly #sessionStore: ReasoningSessionStore;
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #tools: AgentTool[] | ((input: StartReasoningTurnInput) => AgentTool[]);

  constructor(options: PiReasoningRuntimeOptions) {
    if (Array.isArray(options.tools)) validateToolNames(options.tools);
    this.#diagnostics = options.diagnostics;
    this.#model = options.model;
    this.#models = options.models;
    this.#thinkingLevel = options.thinkingLevel;
    this.#usage = options.usage;
    // Field by field rather than a spread: an explicitly passed `undefined` would otherwise
    // overwrite the default it is meant to fall back to.
    this.#compaction = {
      compactAtPercent: options.compaction?.compactAtPercent ?? DEFAULT_COMPACTION.compactAtPercent,
      keepRecentMessages: options.compaction?.keepRecentMessages ?? DEFAULT_COMPACTION.keepRecentMessages,
      maxMessages: options.compaction?.maxMessages ?? DEFAULT_COMPACTION.maxMessages,
      maxSummaryCharacters: options.compaction?.maxSummaryCharacters ?? DEFAULT_COMPACTION.maxSummaryCharacters,
    };
    if (this.#compaction.keepRecentMessages < 2
      || this.#compaction.maxMessages <= this.#compaction.keepRecentMessages
      || this.#compaction.maxSummaryCharacters < 80
      || this.#compaction.compactAtPercent < COMPACTION_PERCENT_FLOOR
      || this.#compaction.compactAtPercent > COMPACTION_PERCENT_CEILING) throw new Error("reasoning_compaction_invalid");
    this.#sessionStore = options.sessionStore;
    this.#tools = Array.isArray(options.tools) ? [...options.tools] : options.tools;
  }

  async startTurn(input: StartReasoningTurnInput): Promise<void> {
    let session = this.#sessions.get(input.sessionId);
    if (session === undefined) {
      await this.restore(input.sessionId);
      session = this.#sessions.get(input.sessionId) ?? this.#createSession({
        workbenchId: input.workbenchId,
        modelRevisionId: input.modelRevisionId,
        sessionId: input.sessionId,
        sourceRevisionId: input.sourceRevisionId,
        systemPrompt: input.systemPrompt,
      }, []);
    }
    if (session.agent.state.isStreaming) throw new Error("reasoning_session_busy");
    if (session.metadata.workbenchId !== input.workbenchId) throw new Error("reasoning_session_workbench_mismatch");

    session.current = input;
    session.delivered = { tool: false };
    session.terminatedByTool = false;
    session.requirementsError = undefined;
    session.metadata = {
      workbenchId: input.workbenchId,
      compaction: session.metadata.compaction,
      modelRevisionId: input.modelRevisionId,
      sessionId: input.sessionId,
      sourceRevisionId: input.sourceRevisionId,
      systemPrompt: input.systemPrompt,
    };
    session.agent.state.model = this.#model;
    session.agent.state.thinkingLevel = this.#thinkingLevel;
    // Refresh per-turn tools: factories bind turn context (inputId/turnId) into tool closures,
    // so a cached session must never reuse a previous turn's closures.
    const turnTools = typeof this.#tools === "function" ? this.#tools(input) : this.#tools;
    if (typeof this.#tools === "function") validateToolNames(turnTools);
    const refreshRequiredContext = input.refreshRequiredContext;
    session.agent.state.tools = refreshRequiredContext === undefined ? turnTools : turnTools.map(tool => ({ ...tool,
      execute: async (id, args, signal, onUpdate) => {
        input.requiredContext = await refreshRequiredContext();
        this.#requestPrompt(input, session.agent.state.messages, session.agent.state.tools);
        return await tool.execute(id, args, signal, onUpdate);
      },
    }));
    // An overflowing context would clamp the request's max_tokens to 1 and make every provider
    // call fail opaque; compact before prompting so the Turn starts inside the model window.
    // The snapshot save stays with the post-turn checkpoint write.
    await this.#compactIfNeeded(session, true);
    this.#markRollbackPoint(session, input.turnId);
    input.onEvent?.({ type: "turn_started", turnId: input.turnId });
    let promptError: unknown;
    try {
      const turnImages: ImageContent[] | undefined = input.images === undefined || input.images.length === 0
        ? undefined
        : input.images.map((image) => ({ data: image.data, mimeType: image.mimeType, type: "image" as const }));
      await session.agent.prompt(input.prompt, turnImages);
    } catch (error) {
      promptError = error;
    }
    const requirementsError = this.#sessions.get(input.sessionId)?.requirementsError;
    if (requirementsError !== undefined) promptError = requirementsError;
    // Pi can resolve prompt() after a provider error. Inspect the current attempt's final
    // assistant message even when an earlier provider request already delivered a tool call:
    // otherwise a failed follow-up request is reported as a successful Turn.
    if (promptError === undefined && !streamStoppedByTool(session)) {
      const failed = [...session.agent.state.messages].reverse().find((message) => roleOf(message) === "assistant") as
        | { errorMessage?: string; stopReason?: string }
        | undefined;
      if (failed?.stopReason === "error") {
        promptError = Object.assign(
          new Error((failed.errorMessage ?? "The reasoning stream failed without delivering content.").slice(0, 400)),
          { code: "reasoning_stream_error" },
        );
      }
    }
    // A tool call may already have committed durable work before the provider failed. Keep
    // that transcript so the next Turn can see what happened; the coordinator decides whether
    // an attempt with only replay-safe tools can be rolled back later.
    if (promptError !== undefined && !session.delivered.tool) this.#applyRollbackPoint(session, input.turnId);
    // A checkpoint failure must not mask the turn's true outcome: by this point the turn's
    // side effects are already committed, and reporting the save error as a turn failure would
    // re-drive the input and duplicate those side effects. The next turn's save repairs the
    // snapshot. The original prompt error is always rethrown below.
    try {
      await this.#compactAndSave(session);
    } catch {
      // Non-fatal: keep the turn's real result.
    }
    input.onEvent?.({ type: "turn_finished", turnId: input.turnId });
    session.current = undefined;
    if (promptError !== undefined) throw promptError as Error;
  }

  steer(sessionId: string, text: string): void {
    const session = this.#requireSession(sessionId);
    session.agent.steer({ role: "user", content: text, timestamp: Date.now() });
  }

  followUp(sessionId: string, text: string): void {
    const session = this.#requireSession(sessionId);
    session.agent.followUp({ role: "user", content: text, timestamp: Date.now() });
  }

  abort(sessionId: string): void {
    this.#sessions.get(sessionId)?.agent.abort();
  }

  /**
   * Takes this Turn's transcript back out of the session.
   *
   * A Turn can fail after `startTurn` has already returned — the resume gate refusing a recovery
   * Turn that never called `goal_resume` is exactly that shape — and by then its failing attempt
   * has been checkpointed. The coordinator calls this in the same catch that re-queues the input,
   * so the next attempt starts from the history the Turn was given rather than from its own
   * failure.
   *
   * Returns whether anything was rolled back. The caller reports the false case: a rollback that
   * quietly did nothing is how this failure would keep looking like the model's own doing.
   */
  async rollbackTurn(sessionId: string, turnId: string): Promise<boolean> {
    const session = this.#sessions.get(sessionId);
    // `abort()` only signals the stream, so truncating under one that is still writing would race
    // it. Keeping the transcript is the pre-rollback behaviour rather than a corrupted one.
    if (session === undefined || session.agent.state.isStreaming) return false;
    if (!this.#applyRollbackPoint(session, turnId)) return false;
    try {
      await this.#compactAndSave(session);
    } catch {
      // Same rule as the post-turn checkpoint: the next Turn's save repairs the snapshot.
    }
    return true;
  }

  #markRollbackPoint(session: SessionRuntime, turnId: string): void {
    // One Turn may prompt more than once — the coordinator repairs an uncommitted outcome by
    // continuing the same session — and every attempt carries the same turnId. Keeping the first
    // marker is what makes a rollback drop all of them instead of only the last one.
    if (session.rollbackPoint?.turnId === turnId) return;
    session.rollbackPoint = {
      compaction: session.metadata.compaction,
      messages: [...session.agent.state.messages],
      turnId,
    };
  }

  #applyRollbackPoint(session: SessionRuntime, turnId: string): boolean {
    const point = session.rollbackPoint;
    if (point?.turnId !== turnId) return false;
    session.rollbackPoint = undefined;
    session.agent.state.messages = [...point.messages];
    // The compaction metadata describes what the history holds. Restoring the messages without it
    // would leave the next compaction summarising a transcript that is no longer there.
    session.metadata = { ...session.metadata, compaction: point.compaction };
    return true;
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.#sessions.get(sessionId)?.agent.waitForIdle();
  }

  isRunning(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.agent.state.isStreaming ?? false;
  }

  async restore(sessionId: string): Promise<boolean> {
    if (this.#sessions.has(sessionId)) return true;
    const snapshot = await this.#sessionStore.load(sessionId);
    if (snapshot === null) return false;
    this.#createSession({
      workbenchId: snapshot.workbenchId,
      compaction: snapshot.compaction,
      modelRevisionId: snapshot.modelRevisionId,
      sessionId: snapshot.sessionId,
      sourceRevisionId: snapshot.sourceRevisionId,
      systemPrompt: snapshot.systemPrompt,
    }, snapshot.messages as AgentMessage[]);
    return true;
  }

  #createSession(
    metadata: Omit<JoiReasoningSessionSnapshot, "messages" | "updatedAt">,
    messages: AgentMessage[],
  ): SessionRuntime {
    const agent = new Agent({
      beforeToolCall: async ({ toolCall }) => allowedToolNames.has(toolCall.name)
        ? undefined
        : { block: true, reason: "tool_not_allowed" },
      followUpMode: "one-at-a-time",
      initialState: {
        messages,
        model: this.#model,
        systemPrompt: metadata.systemPrompt,
        thinkingLevel: this.#thinkingLevel,
        // Placeholder for factory-provided tools; startTurn assigns the per-turn set before prompting.
        tools: Array.isArray(this.#tools) ? this.#tools : [],
      },
      sessionId: metadata.sessionId,
      steeringMode: "one-at-a-time",
      streamFn: trackPiStream(this.#models, this.#usage, () => this.#usageContext(runtime, "orchestration")),
      toolExecution: "sequential",
      // Compaction only runs at Turn boundaries (startTurn and post-turn), so a Turn that makes many
      // tool calls could still grow past the window mid-flight: the provider clamps max_tokens down to
      // whatever is left and the Turn ends truncated, which reads downstream as a model that stopped
      // talking rather than as an overflow. This bound is request-only — the session keeps its history
      // and compaction still owns its durable shape.
      transformContext: (messages) => Promise.resolve(this.#boundRequest(messages, runtime.current, runtime.agent.state.tools)),
    });
    const runtime: SessionRuntime = { agent, current: undefined, delivered: { tool: false }, metadata, rollbackPoint: undefined, terminatedByTool: false, requirementsError: undefined };
    agent.subscribe(async (event) => {
      this.#emit(runtime, event);
    });
    // The Turn's prompt changes on every turn, and pi keeps the prompt inside the transcript where
    // it is read-only; install the current one for the length of each request instead.
    agent.prepareRequest = async ({ context }) => {
      const current = runtime.current;
      if (current === undefined) return undefined;
      if (current.refreshRequiredContext !== undefined) current.requiredContext = await current.refreshRequiredContext();
      return { context: { ...context, messages: withRequestPrompt(context.messages, this.#requestPrompt(current, context.messages, runtime.agent.state.tools)) } };
    };
    this.#sessions.set(metadata.sessionId, runtime);
    return runtime;
  }

  /** Fixed policy survives even when a small route has no room for reference data. */
  #requestPrompt(input: StartReasoningTurnInput, messages: readonly AgentMessage[], tools: NonNullable<Context["tools"]>, pendingPrompt = false): string {
    if (input.backgroundContext === undefined && input.requiredContext === undefined) return input.systemPrompt;
    const knownWindow = Number.isFinite(this.#model.contextWindow) && this.#model.contextWindow > 0;
    const required = input.requiredContext ?? "";
    if (required.length > (knownWindow ? 60_000 : 24_000)) this.#requirementsCapacityError(input);
    const base = required === "" ? input.systemPrompt : `${input.systemPrompt}\n\n${required}`;
    const history = withRequestPrompt(messages, base);
    const requestMessages: AgentMessage[] = pendingPrompt
      ? [...history, { role: "user", content: [
        { type: "text", text: input.prompt },
        ...(input.images ?? []).map((item) => ({ type: "image" as const, ...item })),
      ], timestamp: 0 }]
      : history;
    const budgetMessages = input.requiredContext === undefined ? requestMessages
      : this.#boundRequiredHistory(input, requestMessages, tools);
    // Transcript declarations and the active tool set represent the same schema overhead.
    const withoutDeclarations = budgetMessages.map((message) => roleOf(message) === "system"
      ? { ...message, toolsAdded: undefined, toolsRemoved: undefined } : message);
    const occupied = JSON.stringify(withoutDeclarations).length + JSON.stringify(tools).length;
    const omissionReserve = budgetMessages.length < requestMessages.length ? HISTORY_OMISSION_RESERVE_CHARS : 0;
    // The writable requirements ceiling reserves a share beside the fixed policy prompt.
    const systemCap = Math.max(
      modelRequestBudget(this.#model).systemMaxChars,
      input.systemPrompt.length + GOAL_REQUIREMENTS_MAX_CHARS + 2,
    );
    const optionalBudget = Math.max(0, Math.min(
      (knownWindow ? 60_000 : 24_000) - required.length,
      systemCap - base.length - 2,
      this.#maxRequestChars() - occupied - omissionReserve - 2,
    ));
    const serializedOptionalBudget = Math.max(0, this.#maxRequestChars() - occupied - omissionReserve);
    const optionalCost = (text: string): number => text === "" ? 0 : JSON.stringify(`\n\n${text}`).length - 2;
    let selected = input.backgroundContext ?? "";
    if (knownWindow) for (const candidate of input.backgroundContextVariants ?? []) {
      if (candidate.length <= optionalBudget && optionalCost(candidate) <= serializedOptionalBudget && this.#headroomSatisfied(budgetMessages, {
        systemPrompt: `${base}\n\n${candidate}`, tools,
      })) selected = candidate;
    }
    let background = selected.length <= optionalBudget ? selected
      : optionalBudget < 128 ? "" : boundBackgroundSections([selected], optionalBudget - 128);
    // JSON escaping also consumes the optional share; mandatory context never pays that overhead.
    if (optionalCost(background) > serializedOptionalBudget) {
      let low = 0;
      let high = Math.max(0, Math.min(selected.length, optionalBudget - 128));
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (optionalCost(boundBackgroundSections([selected], middle)) <= serializedOptionalBudget) low = middle;
        else high = middle - 1;
      }
      background = boundBackgroundSections([selected], low);
      if (optionalCost(background) > serializedOptionalBudget) background = "";
    }
    return background === "" ? base : `${base}\n\n${background}`;
  }

  #maxRequestChars(): number {
    return Number.isFinite(this.#model.contextWindow) && this.#model.contextWindow > 0
      ? Math.min(modelContextMaxChars(this.#model), Math.max(0, this.#model.contextWindow - this.#compactionHeadroom()))
      : modelContextMaxChars(this.#model);
  }

  #requirementsCapacityError(input: StartReasoningTurnInput): never {
    const error = new DomainError("goal_requirements_capacity_exceeded", "The mandatory goal requirements do not fit this request's remaining context capacity.");
    const session = this.#sessions.get(input.sessionId);
    if (session !== undefined) { session.requirementsError = error; session.agent.abort(); }
    throw error;
  }

  /** Policy, task anchors and the latest tool exchange are required; older history yields capacity first. */
  #boundRequiredHistory(input: StartReasoningTurnInput, messages: readonly AgentMessage[], tools: NonNullable<Context["tools"]>): AgentMessage[] {
    const toolChars = JSON.stringify(tools).length;
    const maximum = this.#maxRequestChars();
    const weights = messages.map(message => JSON.stringify(roleOf(message) === "system"
      ? { ...message, toolsAdded: undefined, toolsRemoved: undefined } : message).length + 1);
    const suffixWeights = new Array<number>(messages.length + 1).fill(0);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      suffixWeights[index] = (weights[index] ?? 0) + (suffixWeights[index + 1] ?? 0);
    }
    const fullChars = messages.length === 0 ? 2 : (suffixWeights[0] ?? 0) + 1;
    if (fullChars + toolChars <= maximum) return [...messages];
    const anchors = new Set([
      ...(leadingSystemMessage(messages) === undefined ? [] : [0]),
      messages.findIndex(message => roleOf(message) === "user"),
      messages.findLastIndex(message => roleOf(message) === "user"),
    ]);
    let latestExchange = messages.length - 1;
    while (latestExchange > 0 && roleOf(messages[latestExchange]) === "toolResult") latestExchange -= 1;
    // Count retained anchors and the suffix together without serializing the whole history at each cut.
    for (let start = 1; start <= latestExchange; start += 1) {
      if (roleOf(messages[start]) === "toolResult") continue;
      const prefixIndices = [...anchors].filter(index => index >= 0 && index < start).sort((left, right) => left - right);
      const prefixWeight = prefixIndices.reduce((sum, index) => sum + (weights[index] ?? 0), 0);
      const chars = prefixWeight + (suffixWeights[start] ?? 0) + 1;
      if (chars + toolChars + HISTORY_OMISSION_RESERVE_CHARS <= maximum) {
        const prefix = messages.slice(0, start).filter((_message, index) => anchors.has(index));
        return [...prefix, ...messages.slice(start)];
      }
    }
    return this.#requirementsCapacityError(input);
  }

  /**
   * Bounds one request inside the route's window, and says so when that costs the session history.
   *
   * A Turn that makes many tool calls cannot compact mid-flight — compaction runs at Turn
   * boundaries, which is what gives the session its durable shape — so the per-request bound is the
   * only thing standing between a long Turn and a provider that clamps `max_tokens` toward 1. But a
   * bound that drops the oldest messages without a word is the same silent loss a long partner run
   * was diagnosed with, and it produced the same wrong conclusion: a model that finds its own work
   * on disk and cannot remember doing it decides something else must have changed its files. The
   * request therefore carries the omission rather than only its effect.
   */
  #boundRequest(messages: readonly AgentMessage[], current?: StartReasoningTurnInput, tools: NonNullable<Context["tools"]> = []): AgentMessage[] {
    const requestMessages = current === undefined ? messages : withRequestPrompt(messages, this.#requestPrompt(current, messages, tools));
    const usable = requestMessages.filter((message) => !isEmptyAssistantMessage(message));
    const bounded = current?.requiredContext === undefined ? boundRequestByChars(usable, modelContextMaxChars(this.#model))
      : this.#boundRequiredHistory(current, usable, tools);
    const omitted = usable.length - bounded.length;
    if (omitted <= 0) return bounded;
    // The bound keeps an opening anchor, and it hands back the very same message objects, so the
    // prefix it kept can be recovered by identity rather than by re-deriving its rules here.
    let kept = 0;
    while (kept < bounded.length && bounded[kept] === usable[kept]) kept += 1;
    const retained = new Set(bounded);
    const omittedChars = usable.filter(message => !retained.has(message))
      .reduce((total, message) => total + JSON.stringify(message).length, 0);
    return [...bounded.slice(0, kept), omissionNotice(omitted, omittedChars), ...bounded.slice(kept)];
  }

  /**
   * Reports a transcript carrying tool calls that no result answers.
   *
   * A terminating tool aborts its batch, so the calls behind it in the same response never run —
   * and a call that never ran emits no event of its own. The assistant message that still names it
   * is the only trace, which is why it is worth recording rather than inferring from later
   * failures. Runs before compaction, so a summary cannot hide the shape first.
   */
  #reportDanglingToolCalls(runtime: SessionRuntime): void {
    const diagnostics = this.#diagnostics;
    if (diagnostics === undefined) return;
    const calls = new Set<string>();
    const answered = new Set<string>();
    const messages = runtime.agent.state.messages as readonly { content?: unknown; role?: string; toolCallId?: string }[];
    for (const message of messages) {
      if (message.role === "toolResult") {
        if (typeof message.toolCallId === "string") answered.add(message.toolCallId);
        continue;
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content as { id?: string; type?: string }[]) {
        if (part.type === "toolCall" && typeof part.id === "string") calls.add(part.id);
      }
    }
    let danglingCount = 0;
    for (const id of calls) if (!answered.has(id)) danglingCount += 1;
    if (danglingCount === 0) return;
    emitRuntimeDiagnostic(diagnostics, "joi.turn.dangling_tool_call", {
      danglingCount,
      inputId: runtime.current?.inputId ?? runtime.metadata.sessionId,
      observedToolCount: calls.size,
      turnId: runtime.current?.turnId ?? "",
      workbenchId: runtime.metadata.workbenchId,
    });
  }

  async #compactAndSave(runtime: SessionRuntime): Promise<void> {
    this.#reportDanglingToolCalls(runtime);
    await this.#compactIfNeeded(runtime);
    await this.#sessionStore.save({
      ...runtime.metadata,
      messages: runtime.agent.state.messages,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Compacts once the context reaches the configured share of the route's window, or once the
   * message count trips the safety net below. That count is deliberately not configurable: a
   * large window may never reach the percentage, but a session stuffed with tiny messages still
   * must not grow without bound.
   */
  async #compactIfNeeded(runtime: SessionRuntime, pendingPrompt = false): Promise<void> {
    const state = runtime.agent.state;
    const currentMessages = state.messages;
    const systemPrompt = runtime.current === undefined ? state.systemPrompt : this.#requestPrompt(runtime.current, currentMessages, state.tools, pendingPrompt);
    const request = { systemPrompt, tools: state.tools };
    // pi 0.83 and later keep the system prompt inside the transcript as its leading message. It is
    // fixed overhead rather than conversation, so it neither counts against the message cap nor is
    // covered by a summary — and a rebuild of the shape `[summary, ...tail]`, correct while the
    // prompt lived in `AgentState.systemPrompt`, would now delete it along with the runtime
    // permission boundary on the first compaction.
    const leading = currentMessages[0];
    const prompt = leadingSystemMessage(currentMessages) === undefined || leading === undefined ? [] : [leading];
    const floor = prompt.length;
    const conversationLength = currentMessages.length - floor;
    const overflow = !this.#headroomSatisfied(currentMessages, request);
    if (!overflow && conversationLength <= this.#compaction.maxMessages) return;
    // An overflowing session must also shrink its kept tail: the fixed recent-message window
    // can itself exceed the model window, which is exactly what clamped max_tokens to 1.
    const keep = overflow ? this.#fittingTailKeep(currentMessages, request) : this.#compaction.keepRecentMessages;
    {
      const targetIndex = Math.max(floor, currentMessages.length - keep);
      let firstKeptIndex = targetIndex;
      while (firstKeptIndex > floor) {
        const candidate = currentMessages[firstKeptIndex];
        if (candidate !== undefined && roleOf(candidate) === "user") break;
        firstKeptIndex -= 1;
      }
      if (firstKeptIndex > floor) {
        const previous = runtime.metadata.compaction;
        // Everything between the preserved prompt and the cut is what the summary replaces. The
        // prompt is not history and a previous checkpoint is already a summary, so neither is
        // summarized again; the checkpoint sits directly after the prompt.
        const prefix = currentMessages.slice(floor, firstKeptIndex);
        const withoutCheckpoint = isCheckpointMessage(prefix[0]) ? prefix.slice(1) : prefix;
        let generatedSummary: string | undefined;
        if (withoutCheckpoint.length > 0) {
          try {
            const generated = await summarizeSegment({
              model: this.#model,
              models: trackPiModels(this.#models, this.#usage, () => this.#usageContext(runtime, "summary")),
              previousSummary: previous?.summary,
              reserveTokens: Math.max(256, Math.ceil(this.#compaction.maxSummaryCharacters / 4)),
              segment: withoutCheckpoint,
              thinkingLevel: this.#thinkingLevel,
            });
            if (generated.ok) generatedSummary = generated.summary;
          } catch {
            // A provider failure must not prevent a bounded local checkpoint from being saved.
          }
        }
        const summary = (generatedSummary ?? fallbackSummary(withoutCheckpoint, this.#compaction.maxSummaryCharacters))
          .slice(0, this.#compaction.maxSummaryCharacters);
        const lastCompactedAt = new Date().toISOString();
        runtime.metadata.compaction = {
          compactedMessages: (previous?.compactedMessages ?? 0) + withoutCheckpoint.length,
          count: (previous?.count ?? 0) + 1,
          lastCompactedAt,
          summary,
        };
        runtime.agent.state.messages = [
          ...prompt,
          checkpointMessage(summary, Date.parse(lastCompactedAt)),
          ...currentMessages.slice(firstKeptIndex),
        ];
      }
    }
  }

  #compactionHeadroom(): number {
    return compactionHeadroom(this.#model.contextWindow, this.#compaction.compactAtPercent);
  }

  /** True when the estimated context still leaves room for thinking plus a visible answer. */
  #headroomSatisfied(messages: readonly AgentMessage[], request: Pick<Context, "systemPrompt" | "tools">): boolean {
    if (this.#model.contextWindow <= 0) return true;
    // Reuses pi-ai's own estimate and safety margin: if even a headroom-sized request gets
    // clamped below the headroom, the next real request would be clamped as well. The system
    // prompt and tool schemas belong in the context: pi-ai only counts them when no assistant
    // usage anchors the session yet, and they are fixed overhead every request pays regardless.
    const headroom = this.#compactionHeadroom();
    // Providers see a normalized transcript, where the prompt and tool declarations have already
    // been folded into a leading system message; sizing against a raw `Context` would price a
    // request shape that is never actually sent.
    const context = normalizeContext({
      messages: (request.systemPrompt === undefined ? [...messages] : withRequestPrompt(messages, request.systemPrompt)) as Message[],
      ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
      ...(request.tools === undefined ? {} : { tools: request.tools }),
    });
    return clampMaxTokensToContext(this.#model, context, headroom) >= headroom;
  }

  /** Smallest kept tail (summary checkpoint included) that restores the output headroom. */
  #fittingTailKeep(messages: readonly AgentMessage[], request: Pick<Context, "systemPrompt" | "tools">): number {
    const checkpoint: AgentMessage = {
      content: `[joi session checkpoint]\n${"x".repeat(this.#compaction.maxSummaryCharacters)}`,
      role: "user",
      timestamp: 0,
    };
    for (const keep of COMPACTION_TAIL_STEPS) {
      const tail = messages.slice(Math.max(1, messages.length - keep));
      if (this.#headroomSatisfied([checkpoint, ...tail], request)) return keep;
    }
    return 2;
  }

  #emit(runtime: SessionRuntime, event: Parameters<Parameters<Agent["subscribe"]>[0]>[0]): void {
    // Track tool execution before the onEvent guard: a later provider failure must preserve
    // any committed tool transcript even when this Turn has no coordinator listener.
    if (event.type === "tool_execution_start") runtime.delivered.tool = true;
    // Terminating orchestration tools must stop the current model turn even when
    // no event listener is attached. Tool execution is sequential, so aborting at
    // the successful end prevents any later calls emitted in the same response.
    if (event.type === "tool_execution_end") {
      if ((event.result as { terminate?: unknown } | undefined)?.terminate === true) {
        runtime.terminatedByTool = true;
        runtime.agent.abort();
      }
      // A structured dispatch rejection (the execute handler's reasonCode) is terminal for
      // this run: the coordinator turns it into a clarification or a failed Turn. An
      // argument-validation failure is raised before execute runs and therefore carries no
      // reasonCode; aborting on it would kill the Turn before the model can even see the
      // error and correct its own call, so those errors stay recoverable in-run.
      if (event.toolName === "work_dispatch" && event.isError
        && safeToolResultReasonCode(event.result) !== undefined) {
        runtime.terminatedByTool = true;
        runtime.agent.abort();
      }
      if (event.toolName === "user_ask" && !event.isError) {
        runtime.terminatedByTool = true;
        runtime.agent.abort();
      }
    }
    const active = runtime.current;
    if (active?.onEvent === undefined) return;
    let mapped: PrimaryReasoningEvent | undefined;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      mapped = { type: "text_delta", delta: event.assistantMessageEvent.delta, turnId: active.turnId };
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      mapped = { type: "thinking_delta", delta: event.assistantMessageEvent.delta, turnId: active.turnId };
    } else if (event.type === "tool_execution_start") {
      mapped = { type: "tool_started", toolCallId: event.toolCallId, toolName: event.toolName, turnId: active.turnId };
    } else if (event.type === "tool_execution_end") {
      const reasonCode = safeToolResultReasonCode(event.result);
      const outcome = safeTurnOutcome(event.toolName, event.result);
      mapped = {
        type: "tool_finished",
        isError: event.isError,
        ...(outcome === undefined ? {} : { outcome }),
        ...(reasonCode === undefined && event.isError ? { reasonCode: "tool_execution_error" } : reasonCode === undefined ? {} : { reasonCode }),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        turnId: active.turnId,
      };
      // Validation errors happen before a tool's execute handler and therefore
      // cannot return a terminating result. Stop this run at the runtime edge
      // so the coordinator can persist one clarification instead of retrying.
    }
    if (mapped !== undefined) active.onEvent(mapped);
  }

  #requireSession(sessionId: string): SessionRuntime {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error("reasoning_session_not_found");
    return session;
  }

  #usageContext(runtime: SessionRuntime, purpose: "orchestration" | "summary"): UsageContext {
    const current = runtime.current;
    return { engine: "pi", purpose, workbenchId: runtime.metadata.workbenchId,
      ...(current === undefined ? {} : { goalId: current.goalInputId ?? current.inputId, sourceId: current.sourceId, modelId: current.modelId }),
    };
  }
}
