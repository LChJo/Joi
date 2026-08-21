/* Pi hooks require Promise-returning callbacks. */
/* eslint-disable @typescript-eslint/require-await */
import {
  Agent,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { DomainError } from "../../domain/errors.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PartnerPromptStore, PartnerRunOutput, PartnerRunRequest, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerEngineRuntime, PartnerExecutionContext, ResidentTurnInput, ResidentTurnResult } from "../../application/ports/partner-instances.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { WorkbenchExecutionContextReader } from "../../application/ports/workbench-context.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import { type PiCodingToolFactory } from "./pi-coding-tool-factory.js";
import { PI_WEB_ACCESS_TOOL_NAMES } from "./pi-web-access-tools.js";
import { modelRequiresAlwaysOnThinking } from "./provider-presets.js";
import { draftAgentConversation, type AgentConversationDraft } from "../../application/partners/agent-conversation-presentation.js";
import { wrapPartnerRunFailure, type PartnerRunSideEffectState } from "../../application/partners/partner-run-failure.js";
import { captureWorkspaceSnapshot, collectChangedWorkspaceArtifacts } from "../workspace/workspace-output-artifacts.js";

const DEFAULT_RUN_TIMEOUT_MILLIS = 10 * 60_000;

/** Per-run mutable facts: observed side effects and a pending question for the user. */
interface RunTracker {
  state: PartnerRunSideEffectState;
  question?: string;
}

interface WarmAgent {
  agent: Agent;
  partnerRevisionId: string;
  sideEffectTracker: { current: RunTracker };
  workspacePath?: string;
}

const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

/**
 * The partner's single channel to pause itself and ask the user. Always available
 * regardless of the revision's narrowed tool list; the run terminates right after
 * the call so the question reaches dispatch as WAITING_INPUT instead of more work.
 */
const askUserParameters = Type.Object({ question: Type.String({ maxLength: 1_000, minLength: 1 }) });

function createAskUserTool(tracker: { current: RunTracker }): AgentTool<typeof askUserParameters> {
  return {
    description: "Ask the user one concrete blocking question when you cannot proceed without their judgement or missing information (for example a missing API key, credential or a decision only they can make). The run pauses until they answer on the workbench. Call it at most once per run, then stop.",
    execute: async (_toolCallId, parameters) => {
      const question = parameters.question.trim();
      if (question.length === 0 || question.length > 1_000) {
        throw new DomainError("partner_question_invalid", "The question for the user is invalid.");
      }
      tracker.current.question = question;
      return {
        content: [{ text: "Question recorded. The run now pauses for the user's answer. Reply with a one-line summary and stop; do not call any more tools.", type: "text" }],
        details: {},
        terminate: true,
      };
    },
    label: "Ask the user",
    name: "ask_user",
    parameters: askUserParameters,
  };
}

const ENVIRONMENT_VARIABLE_NAME = /^[A-Z][A-Z0-9_]{1,63}$/u;

/**
 * Recognizes only a stable missing-environment-variable signal from a failed
 * shell tool. Raw command output is never retained in the question or result.
 */
function missingEnvironmentVariable(context: AfterToolCallContext): string | undefined {
  if (context.toolCall.name !== "bash" || !context.isError) return undefined;
  for (const block of context.result.content) {
    if (block.type !== "text") continue;
    const match = /\bMissing\s+([A-Z][A-Z0-9_]{1,63})\b[\s\S]{0,200}\bSet env var\b/u.exec(block.text);
    const name = match?.[1];
    if (name !== undefined && ENVIRONMENT_VARIABLE_NAME.test(name)) return name;
  }
  return undefined;
}

function pauseForMissingEnvironmentCredential(
  tracker: { current: RunTracker },
  context: AfterToolCallContext,
): AfterToolCallResult | undefined {
  const name = missingEnvironmentVariable(context);
  if (name === undefined) return undefined;
  tracker.current.question = [
    `The selected Skill needs ${name}, but the Partner runtime cannot access it.`,
    `Make sure ${name} exists in the Joi process environment and add ${name} to JOI_PARTNER_ENV_PASSTHROUGH.`,
    "Fully restart Joi, then reply here to retry.",
  ].join(" ");
  return {
    content: [{ text: "A required Skill credential is unavailable. The run has paused for user input.", type: "text" }],
    details: {},
    isError: false,
    terminate: true,
  };
}

/**
 * Pi core partner engine. Ephemeral runs are single-shot Agents (today's behavior);
 * resident instances keep a warm Agent per instanceId, rebuilt from persisted
 * messages after eviction or restart.
 */
export class PiPartnerEngineRuntime implements PartnerEngineRuntime {
  readonly #warm = new Map<string, WarmAgent>();

  constructor(private readonly dependencies: {
    maxWarmAgents?: number;
    contexts: WorkbenchExecutionContextReader;
    prompts: Pick<PartnerPromptStore, "read">;
    resolver: PiConfiguredModelResolver;
    /** Hard deadline per engine turn; a hung provider stream must fail the run, not stall it. */
    runTimeoutMillis?: number;
    sources: Pick<ReasoningSourceSelector, "selectInitial"> & Partial<Pick<ReasoningSourceSelector, "selectById">>;
    tools: PiCodingToolFactory;
  }) {}

  engineOf(): "pi-core" {
    return "pi-core";
  }

  toolOptions(): readonly string[] {
    return this.dependencies.tools.names;
  }

  async health(): Promise<{ available: boolean; reason?: string }> {
    return { available: true };
  }

  evictFromMemory(instanceId: string): void {
    this.#warm.delete(instanceId);
  }

  async runEphemeral(request: PartnerRunRequest, revision: PartnerRevision, context: PartnerExecutionContext): Promise<{ conversation: AgentConversationDraft[]; externalRunId: string; output: PartnerRunOutput; status: PartnerRunStatus }> {
    const tracker: RunTracker = { state: "NONE" };
    try {
      return await this.#runEphemeral(request, revision, context, tracker);
    } catch (error) {
      throw wrapPartnerRunFailure(error, { phase: "MODEL", sideEffectState: tracker.state });
    }
  }

  async #runEphemeral(request: PartnerRunRequest, revision: PartnerRevision, context: PartnerExecutionContext, tracker: RunTracker): Promise<{ conversation: AgentConversationDraft[]; externalRunId: string; output: PartnerRunOutput; status: PartnerRunStatus }> {
    if (revision.kind !== "local-pi") throw new Error("local_partner_kind_required");
    const execution = await this.dependencies.contexts.loadForExecution(request.contextSnapshotId);
    if (execution === null) throw new Error("workbench_context_snapshot_not_found");
    const externalRunId = `local_pi:${request.actionId}`;
    const pin = await this.#selectSource(revision, externalRunId);
    const resolved = await this.dependencies.resolver.resolve(pin);
    const configuredPrompt = await this.#configuredPrompt(revision);
    const trackerRef = { current: tracker };
    const tools = [
      ...this.#toolsForRun(execution.workspacePath, this.#effectiveToolNames(revision), context.skillEnvironmentKeys),
      createAskUserTool(trackerRef),
    ];
    const allowed = new Set(tools.map((tool) => tool.name));
    const agent = new Agent({
      afterToolCall: (context) => Promise.resolve(pauseForMissingEnvironmentCredential(trackerRef, context)),
      beforeToolCall: ({ toolCall }) => {
        if (allowed.has(toolCall.name) && MUTATING_TOOLS.has(toolCall.name)) tracker.state = "OBSERVED";
        return Promise.resolve(allowed.has(toolCall.name) ? undefined : { block: true, reason: "partner_tool_not_allowed" });
      },
      initialState: {
        messages: [],
        model: resolved.model,
        systemPrompt: this.#systemPrompt(configuredPrompt, request, execution.promptSection, context.knowledgeSection, context.skillSection),
        thinkingLevel: modelRequiresAlwaysOnThinking(resolved.model.baseUrl) ? "low" : "off",
        tools,
      },
      sessionId: externalRunId,
      streamFn: resolved.models.streamSimple.bind(resolved.models),
      toolExecution: "sequential",
    });
    const before = await captureWorkspaceSnapshot(execution.workspacePath);
    await this.#promptWithDeadline(agent, request.taskProjection);
    const failure = assistantFailureSignal(agent.state.messages);
    if (failure !== null) throw failure;
    const body = assistantText(agent.state.messages);
    const artifacts = await collectChangedWorkspaceArtifacts(execution.workspacePath, before);
    return {
      conversation: draftAgentConversation(request.taskProjection, body, agent.state.messages),
      externalRunId,
      output: { artifacts, body, ...(tracker.question === undefined ? {} : { pendingQuestion: tracker.question }) },
      status: tracker.question === undefined ? "COMPLETED" : "WAITING_INPUT",
    };
  }

  async runResidentTurn(input: ResidentTurnInput): Promise<ResidentTurnResult> {
    const tracker: RunTracker = { state: "NONE" };
    try {
      return await this.#runResidentTurn(input, tracker);
    } catch (error) {
      throw wrapPartnerRunFailure(error, { phase: "MODEL", sideEffectState: tracker.state });
    }
  }

  async #runResidentTurn(input: ResidentTurnInput, tracker: RunTracker): Promise<ResidentTurnResult> {
    const { revision } = input;
    if (revision.kind !== "local-pi") throw new Error("local_partner_kind_required");
    const execution = await this.dependencies.contexts.loadForExecution(input.request.contextSnapshotId);
    if (execution === null) throw new Error("workbench_context_snapshot_not_found");
    let warm = this.#warm.get(input.instanceId);
    if (warm !== undefined && (warm.partnerRevisionId !== revision.partnerRevisionId || warm.workspacePath !== execution.workspacePath)) {
      this.#warm.delete(input.instanceId);
      warm = undefined;
    }
    if (warm !== undefined) warm.sideEffectTracker.current = tracker;
    const systemPrompt = this.#systemPrompt(
      await this.#configuredPrompt(revision), input.request, execution.promptSection, input.knowledgeSection, input.skillSection,
    );
    if (warm === undefined) {
      const pin = await this.#selectSource(revision, `local_pi_instance:${input.instanceId}`);
      const resolved = await this.dependencies.resolver.resolve(pin);
      const sideEffectTracker = { current: tracker };
      const tools = [
        ...this.#toolsForRun(execution.workspacePath, this.#effectiveToolNames(revision), input.skillEnvironmentKeys),
        createAskUserTool(sideEffectTracker),
      ];
      const allowed = new Set(tools.map((tool) => tool.name));
      const agent = new Agent({
        afterToolCall: (context) => Promise.resolve(pauseForMissingEnvironmentCredential(sideEffectTracker, context)),
        beforeToolCall: ({ toolCall }) => {
          if (allowed.has(toolCall.name) && MUTATING_TOOLS.has(toolCall.name)) sideEffectTracker.current.state = "OBSERVED";
          return Promise.resolve(allowed.has(toolCall.name) ? undefined : { block: true, reason: "partner_tool_not_allowed" });
        },
        initialState: {
          messages: (input.restoredMessages ?? []) as AgentMessage[],
          model: resolved.model,
          systemPrompt,
          thinkingLevel: modelRequiresAlwaysOnThinking(resolved.model.baseUrl) ? "low" : "off",
          tools,
        },
        sessionId: `local_pi_instance:${input.instanceId}`,
        streamFn: resolved.models.streamSimple.bind(resolved.models),
        toolExecution: "sequential",
      });
      warm = {
        agent,
        partnerRevisionId: revision.partnerRevisionId,
        sideEffectTracker,
        ...(execution.workspacePath === undefined ? {} : { workspacePath: execution.workspacePath }),
      };
      this.#trackWarm(input.instanceId, warm);
    }
    warm.agent.state.systemPrompt = systemPrompt;
    const previousMessageCount = warm.agent.state.messages.length;
    const before = await captureWorkspaceSnapshot(execution.workspacePath);
    await this.#promptWithDeadline(warm.agent, input.request.taskProjection);
    const turnMessages = warm.agent.state.messages.slice(previousMessageCount);
    const failure = assistantFailureSignal(turnMessages);
    if (failure !== null) throw failure;
    const body = assistantText(turnMessages);
    const artifacts = await collectChangedWorkspaceArtifacts(execution.workspacePath, before);
    return {
      conversation: draftAgentConversation(input.request.taskProjection, body, turnMessages),
      externalRunId: `local_pi:${input.request.actionId}`,
      externalSessionRef: `partner_instance_messages:${input.instanceId}`,
      messages: [...warm.agent.state.messages],
      output: { artifacts, body, ...(tracker.question === undefined ? {} : { pendingQuestion: tracker.question }) },
      status: tracker.question === undefined ? "COMPLETED" : "WAITING_INPUT",
    };
  }

  /** Races the model stream against a deadline; a hung provider aborts the run instead of stalling it. */
  async #promptWithDeadline(agent: Agent, text: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.dependencies.runTimeoutMillis ?? DEFAULT_RUN_TIMEOUT_MILLIS);
    });
    try {
      const winner = await Promise.race([agent.prompt(text).then(() => "done" as const), deadline]);
      if (winner === "timeout") {
        agent.abort();
        throw new DomainError("partner_run_timed_out", "The partner run exceeded its time budget and was aborted.");
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #configuredPrompt(revision: PartnerRevision): Promise<string> {
    let configuredPrompt = "You are a local Pi coding partner. The assigned workspace is your home base; complete the requested work.";
    if (revision.promptRef !== undefined) {
      const stored = await this.dependencies.prompts.read(revision.promptRef);
      if (stored === null) throw new Error("partner_prompt_not_found");
      configuredPrompt = stored;
    }
    return configuredPrompt;
  }

  async #selectSource(revision: PartnerRevision, turnId: string) {
    const pin = revision.modelSourceId === undefined
      ? await this.dependencies.sources.selectInitial(turnId)
      : this.dependencies.sources.selectById === undefined
        ? (() => { throw new DomainError("partner_model_source_not_ready", "The partner model source cannot be selected."); })()
        : await this.dependencies.sources.selectById(revision.modelSourceId, turnId);
    if (revision.modelIdOverride !== undefined && revision.modelIdOverride !== pin.modelId) {
      throw new DomainError("partner_model_override_not_ready", "The pinned model is not active on the selected source.");
    }
    return pin;
  }

  #effectiveToolNames(revision: PartnerRevision): string[] {
    if (revision.tools.length === 0) return [...this.dependencies.tools.names];
    const known = new Set(this.dependencies.tools.names);
    return revision.tools.filter((name) => known.has(name));
  }

  #toolsForRun(workspacePath: string | undefined, names: string[], environmentKeys: readonly string[]): AgentTool[] {
    const selected = workspacePath === undefined
      ? names.filter((name) => (PI_WEB_ACCESS_TOOL_NAMES as readonly string[]).includes(name))
      : names;
    if (selected.length === 0) return [];
    return this.dependencies.tools.create(workspacePath ?? process.cwd(), selected, { environmentKeys });
  }

  #systemPrompt(configuredPrompt: string, request: PartnerRunRequest, workbenchSection: string, knowledgeSection: string, skillSection: string): string {
    return [
      configuredPrompt,
      "The assigned workspace is your home base: create work files there by default. When the task requires it, you may also read and write paths outside the workspace (for example user directories, installed skill folders, or configuration files). List every write outside the workspace (path and change) in your final reply. Placeholders like {baseDir} inside skill instructions refer to the skill's own directory.",
      "For public web research, use web_search first, then fetch_content for the relevant URL and get_search_content to page a long response. Web tools are read-only, bounded, and never receive cookies, authorization headers or credentials; cite the URL in your answer and label uncertainty.",
      "If you are blocked because only the user can supply missing information or make a decision, call ask_user once with one concrete question and stop; otherwise complete the work without asking.",
      `Workbench scope: ${request.workbenchId}`,
      `Work item: ${request.workId}`,
      workbenchSection,
      ...(skillSection === "" ? [] : [skillSection]),
      ...(knowledgeSection === "" ? [] : [knowledgeSection]),
    ].join("\n");
  }

  #trackWarm(instanceId: string, warm: WarmAgent): void {
    this.#warm.set(instanceId, warm);
    const max = this.dependencies.maxWarmAgents ?? 8;
    while (this.#warm.size > max) {
      const oldest = this.#warm.keys().next();
      if (oldest.done) break;
      this.#warm.delete(oldest.value);
    }
  }
}

function assistantText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const candidate of messages) {
    if (candidate === null || typeof candidate !== "object" || (candidate as { role?: unknown }).role !== "assistant") continue;
    const content = (candidate as { content?: unknown }).content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) for (const block of content) {
      if (block !== null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

const ERROR_DETAIL_CHARS = 240;

/**
 * Derives a stable classifier signal from a failed assistant message. Raw provider
 * text never reaches the work result; only a truncated detail travels with local
 * diagnostics so failures like this stay debuggable without leaking full payloads.
 */
function assistantFailureSignal(messages: readonly unknown[]): Error | null {
  for (const candidate of messages) {
    if (candidate === null || typeof candidate !== "object") continue;
    const message = candidate as { errorMessage?: unknown; role?: unknown; stopReason?: unknown };
    if (message.role !== "assistant" || message.stopReason !== "error") continue;
    const raw = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    if (raw === undefined) return codedProviderError("assistant_error");
    const detail = raw.slice(0, ERROR_DETAIL_CHARS);
    const knownCode = /\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/iu.exec(raw)?.[0];
    if (knownCode !== undefined) return codedProviderError(knownCode.toUpperCase(), detail);
    if (/\b(?:prompt is too long|context length|maximum context|too many tokens)\b/iu.test(raw)) return codedProviderError("context_too_large", detail);
    if (/\brefused to complete\b/iu.test(raw)) return codedProviderError("model_refused", detail);
    if (/\boverloaded/iu.test(raw)) return codedProviderError("server_error", detail);
    if (/\brate[ -]?limit(?:ed|ing)?\b/iu.test(raw)) return codedProviderError("rate_limited", detail);
    if (/\b(?:timed?\s*out|timeout)\b/iu.test(raw)) return codedProviderError("timeout", detail);
    if (/\b(?:invalid[ _-]?api[ _-]?key|authentication|unauthorized)\b/iu.test(raw)) return codedProviderError("invalid_api_key", detail);
    const statusText = /\b(?:HTTP|status)\s*[:=]?\s*([1-5]\d{2})\b/iu.exec(raw)?.[1] ?? /^\s*([1-5]\d{2})\b/u.exec(raw)?.[1];
    if (statusText !== undefined) return Object.assign(new Error("partner_provider_failed"), { detail, status: Number(statusText) });
    return codedProviderError("assistant_error", detail);
  }
  return null;
}

function codedProviderError(code: string, detail?: string): Error & { code: string; detail?: string } {
  return Object.assign(new Error("partner_provider_failed"), { code, ...(detail === undefined ? {} : { detail }) });
}
