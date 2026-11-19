import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionFactory, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { JoiReasoningSessionSnapshot, JoiReasoningOutcome, PrimaryReasoningEvent, PrimaryReasoningRuntime, ReasoningSessionStore, StartReasoningTurnInput } from "../../application/ports/primary-reasoning-runtime.js";
import type { RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";
import { emitRuntimeDiagnostic } from "../../application/ports/runtime-diagnostics.js";
import type { UsageContext, UsageRecorder } from "../../application/ports/usage.js";
import { DomainError } from "../../domain/errors.js";
import { parseGoalSynthesisDraft } from "../../domain/work/goal-synthesis-state.js";
import { reasoningStreamFailure } from "./pi-reasoning-failure-classifier.js";
import { createJoiPiSession, snapshotJoiPiSession } from "./joi-pi-session.js";
import { createContextHistoryTool } from "./pi-history-tools.js";
import { trackPiModels } from "./pi-usage.js";
import { PiSessionUsage } from "./pi-session-usage.js";
import type { PiNativeSessionStore } from "./pi-native-session-store.js";
import { PiObservationQueue } from "./pi-observation-queue.js";
import { renderHistoricalContext } from "../../domain/work/historical-context.js";
import { JOI_MEMORY_OWNER, type HistoricalMemoryReader } from "../../application/ports/historical-memory.js";
import { historicalMemoryTools } from "./pi-historical-memory-tools.js";
import { assertPiRequestCapacity, PI_REQUEST_CAPACITY_ERROR } from "./pi-model-budget.js";

export const JOI_REASONING_TOOL_NAMES = [
  "context_read_history",
  "workbench_read_history",
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
  "work_read_evidence",
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
interface PiReasoningRuntimeOptions {
  memory?: HistoricalMemoryReader;
  compactionThresholdPercent?: number;
  sourceName?: string;
  diagnostics?: RuntimeDiagnostics; usage?: UsageRecorder; nativeSessions?: PiNativeSessionStore;
  sessionSettings?: () => SettingsManager;
  model: Model<Api>; models: Models; thinkingLevel: ModelThinkingLevel; sessionStore: ReasoningSessionStore;
  tools: AgentTool[] | ((input: StartReasoningTurnInput) => AgentTool[]);
  compaction?: Partial<{ compactAtPercent: number; keepRecentMessages: number; maxMessages: number; maxSummaryCharacters: number }>;
}
interface SessionRuntime {
  events: PrimaryReasoningEvent[];
  nativeReference?: () => NonNullable<JoiReasoningSessionSnapshot["piNativeSession"]>;
  session: AgentSession;
  agent: AgentSession["agent"];
  current: StartReasoningTurnInput | undefined;
  metadata: JoiReasoningSessionSnapshot;
  delivered: { tool: boolean };
  validatedToolCalls: Set<string>;
  dispatchAcceptanceCalls: Set<string>;
  dispatchAcceptanceFailures: number;
  rollbackPoint: { leafId: string | null; turnId: string } | undefined;
  cancelled: boolean;
  idle: Promise<void>;
}
/** Historical settings arithmetic; active sessions use the SDK's native token settings. */
export function compactionHeadroom(contextWindow: number, compactAtPercent: number): number {
  return !Number.isFinite(contextWindow) || contextWindow <= 0 ? 4096 : Math.max(4096, Math.floor(contextWindow * (1 - compactAtPercent / 100)));
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
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #snapshots = new Map<string, JoiReasoningSessionSnapshot>();
  readonly #starting = new Set<string>();
  readonly #canceledStartup = new Set<string>();
  constructor(private readonly options: PiReasoningRuntimeOptions) {
    if (Array.isArray(options.tools)) validateToolNames(options.tools);
  }

  async startTurn(input: StartReasoningTurnInput): Promise<void> {
    if (this.isRunning(input.sessionId)) throw new Error("reasoning_session_busy");
    this.#starting.add(input.sessionId);
    let runtime: SessionRuntime | undefined;
    try {
      const previous = this.#sessions.get(input.sessionId);
      const isolated = input.executionScope === "turn";
      const stateId = isolated ? JSON.stringify([input.sessionId,input.turnId]) : input.sessionId;
      const cached = previous?.metadata ?? this.#snapshots.get(input.sessionId);
      const stored = cached?.sessionId === stateId ? cached : await this.options.sessionStore.load(stateId);
      const evidenceTurn = /^(?:joi_harness_review|joi_result_input):goal:/u.test(input.inputId);
      const legacy = isolated && stored === null && !evidenceTurn ? await this.options.sessionStore.load(input.sessionId) : null;
      if (this.#canceledStartup.has(input.sessionId)) return;
      if ([stored,legacy].some(snapshot => snapshot !== null && snapshot.workbenchId !== input.workbenchId)) throw new Error("reasoning_session_workbench_mismatch");
      previous?.session.dispose();
      const seed = legacySummarySeed(this.options.model,input,legacy?.compaction?.summary);
      const source = stored === null ? { engine: "pi-core" as const, messages: seed } : { engine: "pi-core" as const, messages: stored.messages,
        ...(stored.piSession === undefined ? {} : { piSession: stored.piSession }), ...(stored.piNativeSession === undefined ? {} : { piNativeSession: stored.piNativeSession }),
        ...(stored.compaction === undefined ? {} : { checkpoint: stored.compaction }) };
      const legacyIdentity = ["primary", input.workbenchId, input.sessionId];
      const native = await this.options.nativeSessions?.open({ identity: isolated ? [...legacyIdentity,input.turnId] : legacyIdentity,
        cwd: process.cwd(), state: source, ...(stored === null ? {} : { legacySource: stored }) });
      const listPriorTurns = () => this.options.sessionStore.listPriorTurnIds?.(input) ?? Promise.resolve([]);
      const readTurn = !isolated || this.options.sessionStore.listPriorTurnIds === undefined ? undefined : async (turnId: string) => {
        if (!(await listPriorTurns()).includes(turnId)) return null;
        const snapshot = await this.options.sessionStore.load(JSON.stringify([input.sessionId,turnId]));
        if (snapshot !== null && snapshot.workbenchId !== input.workbenchId) return null;
        const context = await this.options.nativeSessions?.readContext([...legacyIdentity,turnId],snapshot?.piNativeSession);
        if ((context === null || context === undefined) && snapshot === null) return null;
        const messages = context?.manager.getEntries().flatMap(entry => entry.type === "message" ? [entry.message] : []) ?? snapshot?.messages ?? [];
        return [...(snapshot?.archivedMessages ?? []),...messages];
      };
      const tools: AgentTool[] = [...(typeof this.options.tools === "function" ? this.options.tools(input) : this.options.tools),
        ...(this.options.memory === undefined ? [] : historicalMemoryTools(this.options.memory,input.workbenchId,true)),
        createContextHistoryTool(async () => {
          const current = session.sessionManager.getEntries().flatMap(entry => entry.type === "message" ? [entry.message] : []);
          if (!isolated) return [...(stored?.archivedMessages ?? []), ...current];
          const old = legacy ?? await this.options.sessionStore.load(input.sessionId);
          if (old?.workbenchId !== undefined && old.workbenchId !== input.workbenchId) throw new DomainError("reasoning_session_workbench_mismatch", "History belongs to another workbench.");
          const oldNative = await this.options.nativeSessions?.readContext(legacyIdentity, old?.piNativeSession);
          const oldMessages = oldNative === null || oldNative === undefined ? old?.messages ?? []
            : oldNative.manager.getEntries().flatMap(entry => entry.type === "message" ? [entry.message] : []);
          const priorTurns = (await listPriorTurns()).map(turnId => ({ kind: "prior_turn",turnId }));
          const oldSummary = old?.compaction?.summary.trim();
          return [...priorTurns, ...(oldSummary ? [{ kind: "legacy_summary",text: oldSummary }] : []),
            ...(old?.archivedMessages ?? []), ...oldMessages, ...current];
        },readTurn)].map(tool => tool.name === "user_ask" || tool.name === "turn_complete" ? { ...tool,executionMode: "sequential" as const } : tool);
      validateToolNames(tools);
      const memory = renderHistoricalContext("joi",this.options.memory?.entries("joi",JOI_MEMORY_OWNER) ?? []).text;
      const factories: ExtensionFactory[] = [pi => {
        pi.on("tool_call", event => { runtime?.validatedToolCalls.add(event.toolCallId); });
        pi.on("context", async event => {
          const required = await input.refreshRequiredContext?.() ?? input.requiredContext;
          const background = [required, input.backgroundContext].filter(Boolean).join("\n\n");
          if (background === "" && memory === "") return;
          return { messages: [...event.messages, {
            role: "system", content: "", sections: { workbench_context: background, ...(memory === "" ? {} : { joi_memory: memory }) }, timestamp: Date.now(),
          }] };
        });
      }];
      const usageContext: UsageContext = { engine: "pi", purpose: "orchestration", workbenchId: input.workbenchId, goalId: input.goalInputId ?? input.inputId, sourceId: input.sourceId, modelId: input.modelId };
      if (this.options.sourceName !== undefined) usageContext.sourceName = this.options.sourceName;
      const models = trackPiModels(this.options.models, undefined, () => usageContext, this.options.diagnostics);
      const session = await createJoiPiSession({ state: { model: this.options.model, thinkingLevel: this.options.thinkingLevel, tools,
        messages: stored?.piSession === undefined ? source.messages as AgentMessage[] : [],
        systemPrompt: input.systemPrompt,
      } }, models, process.cwd(), { extensionFactories: factories,
        ...(input.skillContext === undefined ? {} : { skillContext: input.skillContext }),
        ...(this.options.sessionSettings === undefined ? {} : { settingsManager: this.options.sessionSettings() }),
        ...(this.options.compactionThresholdPercent === undefined ? {} : { compactionThresholdPercent: this.options.compactionThresholdPercent }),
        ...(native === undefined ? stored?.piSession === undefined ? {} : { snapshot: stored.piSession } : { sessionManager: native.manager }) });
      if (this.#canceledStartup.has(input.sessionId)) { session.dispose(); return; }
      const completed = session.sessionManager.getBranch().findLast(entry => {
        if (entry.type !== "custom" || entry.customType !== "joi.primary_result") return false;
        const result = entry.data as { turnId?: unknown; repair?: unknown } | null;
        return result?.turnId === input.turnId && result.repair === input.repair;
      });
      if (completed?.type === "custom") {
        const data = completed.data as { events?: PrimaryReasoningEvent[] };
        if (!Array.isArray(data.events)) throw new DomainError("pi_result_invalid", "The persisted primary result is invalid.");
        for (const event of [{ type: "turn_started" as const, turnId: input.turnId }, ...data.events, { type: "turn_finished" as const, turnId: input.turnId }]) {
          try { input.onEvent?.(event); } catch { /* The immutable execution remains available for another projection retry. */ }
        }
        session.dispose();
        return;
      }
      const metadata: JoiReasoningSessionSnapshot = { workbenchId: input.workbenchId, modelRevisionId: input.modelRevisionId, sourceRevisionId: input.sourceRevisionId,
        sessionId: stateId, systemPrompt: input.systemPrompt, updatedAt: new Date().toISOString(), messages: [] };
      runtime = { events: [], session, agent: session.agent, current: input, metadata, ...(native === undefined ? {} : { nativeReference: native.reference }), delivered: { tool: false }, validatedToolCalls: new Set(), dispatchAcceptanceCalls: new Set(), dispatchAcceptanceFailures: 0, cancelled: false,
        rollbackPoint: previous?.rollbackPoint?.turnId === input.turnId ? previous.rollbackPoint : { leafId: session.sessionManager.getLeafId(), turnId: input.turnId }, idle: Promise.resolve() };
      this.#sessions.set(input.sessionId, runtime);
      this.#starting.delete(input.sessionId);
      const active = runtime;
      const runStart = session.sessionManager.getEntryCount();
      const collector = new PiSessionUsage(this.options.usage);
      const usageQueue = new PiObservationQueue(() => emitRuntimeDiagnostic(this.options.diagnostics, "joi.pi.projection_degraded", { workId: input.turnId }));
      let usagePending = false;
      const collect = () => { if (!usagePending) { usagePending = true; usageQueue.enqueue(() => { usagePending = false; collector.reconcile(session.sessionManager); return Promise.resolve(); }); } };
      collect();
      const save = () => {
        const current: JoiReasoningSessionSnapshot = { ...metadata, updatedAt: new Date().toISOString(), ...(native === undefined
          ? { messages: structuredClone(active.session.messages), piSession: snapshotJoiPiSession(active.session) }
          : { messages: [], piNativeSession: native.reference() }) };
        active.metadata = current;
        this.#snapshots.set(input.sessionId, current);
        try { void this.options.sessionStore.save(current).catch(() => emitRuntimeDiagnostic(this.options.diagnostics, "joi.pi.projection_degraded", { workId: input.turnId })); }
        catch { emitRuntimeDiagnostic(this.options.diagnostics, "joi.pi.projection_degraded", { workId: input.turnId }); }
      };
      let settled: { aborted: boolean } | undefined;
      const unsubscribe = session.subscribe(event => {
        this.#emit(active, event);
        if (event.type === "agent_settled") settled = { aborted: event.aborted };
        if (event.type === "entry_appended") collect();
      });
      session.sessionManager.appendCustomEntry("joi.usage_context", { ...usageContext, sourceRevisionId: input.sourceRevisionId, modelRevisionId: input.modelRevisionId, turnId: input.turnId });
      try { input.onEvent?.({ type: "turn_started", turnId: input.turnId }); } catch { /* Projection failures do not abort the SDK. */ }
      const execute = async () => {
        try {
          await active.session.prompt(input.prompt, { expandPromptTemplates: false,
            ...(input.images === undefined ? {} : { images: input.images.map(image => ({ ...image, type: "image" as const })) }) });
          await active.session.waitForIdle();
          if (settled === undefined) throw new DomainError("pi_session_unsettled", "Primary reasoning did not settle.");
          const runMessages = active.session.sessionManager.getEntries().slice(runStart).flatMap(entry => entry.type === "message" ? [entry.message] : []);
          const calls = runMessages.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : []);
          const results = new Set(runMessages.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []));
          const dangling = calls.filter(call => !results.has(call.id)).length;
          if (dangling > 0) emitRuntimeDiagnostic(this.options.diagnostics, "joi.turn.dangling_tool_call", { danglingCount: dangling, observedToolCount: calls.length, inputId: input.inputId, turnId: input.turnId, workbenchId: input.workbenchId });
          const last = [...active.session.messages].reverse().find(message => message.role === "assistant");
          if (last?.role === "assistant" && last.stopReason === "error") throw reasoningStreamFailure(last.errorMessage);
          if ((settled.aborted || last?.role === "assistant" && last.stopReason === "aborted") && !active.cancelled) throw reasoningStreamFailure("Primary reasoning was aborted.");
          active.session.sessionManager.appendCustomEntry("joi.primary_result", { turnId: input.turnId, repair: input.repair, events: active.events });
          active.session.sessionManager.appendCustomEntry("joi.usage_idle", {});
        } catch (error) {
          if (!active.delivered.tool) await this.#rollback(active, input.turnId);
          throw error;
        } finally {
          unsubscribe(); collect(); usageQueue.close(); save(); active.current = undefined;
          try { input.onEvent?.({ type: "turn_finished", turnId: input.turnId }); } catch { /* The native session retains the completed execution. */ }
        }
      };
      active.idle = execute();
      await active.idle;
    } finally { this.#starting.delete(input.sessionId); this.#canceledStartup.delete(input.sessionId); }
  }

  steer(sessionId: string, text: string): void { void this.#requireSession(sessionId).session.steer(text).catch(() => undefined); }
  followUp(sessionId: string, text: string): void { void this.#requireSession(sessionId).session.followUp(text).catch(() => undefined); }
  abort(sessionId: string): void {
    if (this.#starting.has(sessionId)) this.#canceledStartup.add(sessionId);
    const runtime = this.#sessions.get(sessionId);
    if (runtime !== undefined) { runtime.cancelled = true; void runtime.session.abort().catch(() => undefined); }
  }
  isRunning(sessionId: string): boolean { return this.#starting.has(sessionId) || this.#sessions.get(sessionId)?.current !== undefined; }
  async waitForIdle(sessionId: string): Promise<void> { await this.#sessions.get(sessionId)?.idle; }
  async restore(sessionId: string): Promise<boolean> {
    if (this.#sessions.has(sessionId) || this.#snapshots.has(sessionId)) return true;
    const snapshot = await this.options.sessionStore.load(sessionId);
    if (snapshot === null) return false;
    this.#snapshots.set(sessionId, snapshot); return true;
  }
  async rollbackTurn(sessionId: string, turnId: string): Promise<boolean> {
    const runtime = this.#sessions.get(sessionId);
    if (runtime === undefined || runtime.current !== undefined) return false;
    return this.#rollback(runtime, turnId);
  }
  async #rollback(runtime: SessionRuntime, turnId: string): Promise<boolean> {
    const point = runtime.rollbackPoint;
    if (point?.turnId !== turnId || runtime.agent.state.isStreaming) return false;
    if (point.leafId === null) runtime.session.sessionManager.resetLeaf();
    else await runtime.session.navigateTree(point.leafId, { summarize: false });
    runtime.session.sessionManager.appendCustomEntry("joi.rollback", { turnId });
    runtime.rollbackPoint = undefined;
    runtime.metadata = { ...runtime.metadata, ...(runtime.nativeReference === undefined
      ? { messages: structuredClone(runtime.session.sessionManager.buildSessionContext().messages), piSession: snapshotJoiPiSession(runtime.session) }
      : { messages: [], piNativeSession: runtime.nativeReference() }) };
    try { await this.options.sessionStore.save(runtime.metadata); } catch { /* The native branch and original entries remain available. */ }
    return true;
  }
  #emit(runtime: SessionRuntime, event: AgentSessionEvent): void {
    if (event.type === "tool_execution_end" && event.toolName === "work_dispatch" && event.isError && runtime.dispatchAcceptanceCalls.has(event.toolCallId)
      && !runtime.validatedToolCalls.has(event.toolCallId)) runtime.dispatchAcceptanceFailures++;
    // Track tool execution before the onEvent guard: a later provider failure must preserve
    // any committed tool transcript even when this Turn has no coordinator listener.
    if (event.type === "tool_execution_start") runtime.delivered.tool = true;
    if (event.type === "tool_execution_end" && ((event.result as { terminate?: unknown } | undefined)?.terminate === true
      || event.toolName === "user_ask" && !event.isError
      || event.toolName === "work_dispatch" && event.isError && (safeToolResultReasonCode(event.result) !== undefined
        || runtime.dispatchAcceptanceCalls.has(event.toolCallId) && runtime.dispatchAcceptanceFailures >= 2))) {
      runtime.cancelled = true;
      void runtime.session.abort().catch(() => undefined);
    }
    if (event.type === "tool_execution_start" && event.toolName === "work_dispatch") {
      const args = event.args as { work?: unknown } | null;
      if (args !== null && typeof args === "object" && Array.isArray(args.work) && args.work.some((item: unknown) => {
        if (item === null || typeof item !== "object") return false;
        const checks = (item as { acceptanceChecks?: unknown }).acceptanceChecks;
        return checks === undefined || (Array.isArray(checks) && checks.length === 0);
      })) runtime.dispatchAcceptanceCalls.add(event.toolCallId);
    }
    const active = runtime.current;
    if (active === undefined) return;
    let mapped: PrimaryReasoningEvent | undefined;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      mapped = { type: "text_delta", delta: event.assistantMessageEvent.delta, turnId: active.turnId };
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      mapped = { type: "thinking_delta", delta: event.assistantMessageEvent.delta, turnId: active.turnId };
    } else if (event.type === "tool_execution_start") {
      mapped = { type: "tool_started", toolCallId: event.toolCallId, toolName: event.toolName, turnId: active.turnId };
    } else if (event.type === "tool_execution_end") {
      const isError = event.isError || (event.result as { isError?: unknown } | undefined)?.isError === true;
      // A known tool without executable preparation cannot execute before the validation barrier.
      // Error text and model-provided content cannot establish this proof.
      const rejectedBeforeExecution = isError && !runtime.validatedToolCalls.has(event.toolCallId)
        && runtime.agent.state.tools.some(tool => tool.name === event.toolName && tool.prepareArguments === undefined);
      const reasonCode = event.toolName === "turn_complete"
        && (event.result as { details?: { correctionExhausted?: unknown } } | undefined)?.details?.correctionExhausted === true
        ? "goal_synthesis_correction_exhausted" : safeToolResultReasonCode(event.result)
        ?? (isError && runtime.dispatchAcceptanceCalls.has(event.toolCallId) ? "work_acceptance_checks_required" : undefined);
      runtime.dispatchAcceptanceCalls.delete(event.toolCallId);
      const outcome = safeTurnOutcome(event.toolName, event.result);
      const synthesisState = event.toolName === "turn_complete" && !isError
        ? parseGoalSynthesisDraft((event.result as { details?: { synthesisState?: unknown } } | undefined)?.details?.synthesisState) : undefined;
      mapped = {
        type: "tool_finished",
        isError,
        ...(outcome === undefined ? {} : { outcome }),
        ...(synthesisState === undefined ? {} : { synthesisState }),
        ...(reasonCode === undefined && isError ? { reasonCode: "tool_execution_error" } : reasonCode === undefined ? {} : { reasonCode }),
        ...(rejectedBeforeExecution || (event.toolName === "work_dispatch" || isError && event.toolName === "goal_resume"
          && (reasonCode === "goal_resume_not_allowed" || reasonCode === "goal_resume_conflict"))
          && (event.result as { details?: { replaySafeRejection?: unknown } } | undefined)?.details?.replaySafeRejection === true
          ? { replaySafeRejection: true as const } : {}),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        turnId: active.turnId,
      };
    }
    if (mapped !== undefined) {
      const last = runtime.events.at(-1);
      if ((mapped.type === "text_delta" || mapped.type === "thinking_delta") && last?.type === mapped.type) last.delta += mapped.delta;
      else runtime.events.push(structuredClone(mapped));
      try { active.onEvent?.(mapped); } catch { /* Main-flow projection can be reconstructed from the private session. */ }
    }
  }


  #requireSession(sessionId: string): SessionRuntime {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error("reasoning_session_not_found");
    return session;
  }
}

function legacySummarySeed(model: Model<Api>, input: StartReasoningTurnInput, storedSummary?: string) {
  const summary = storedSummary?.trim();
  if (!summary) return [];
  const seed = { role: "user" as const,content: `Retained goal summary (reference data):\n${summary}`,timestamp: 0 };
  try {
    assertPiRequestCapacity(model,{
      systemPrompt: [input.systemPrompt,input.requiredContext,input.backgroundContext].filter(Boolean).join("\n\n"),
      messages: [seed,{ role: "user",timestamp: 0,content: [{ type: "text",text: input.prompt },
        ...(input.images ?? []).map(image => ({ ...image,type: "image" as const }))] }],
    });
    return [seed];
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== PI_REQUEST_CAPACITY_ERROR) throw error;
    return [{ ...seed,content: "The retained goal summary is available through context_read_history." }];
  }
}
