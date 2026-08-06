/* Pi hooks require Promise-returning callbacks. */
/* eslint-disable @typescript-eslint/require-await */
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";

import { DomainError } from "../../domain/errors.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PartnerPromptStore, PartnerRunOutput, PartnerRunRequest, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerEngineRuntime, ResidentTurnInput, ResidentTurnResult } from "../../application/ports/partner-instances.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { WorkbenchExecutionContextReader } from "../../application/ports/workbench-context.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { PiCodingToolFactory } from "./pi-coding-tool-factory.js";
import { modelRequiresAlwaysOnThinking } from "./provider-presets.js";
import { draftAgentConversation, type AgentConversationDraft } from "../../application/partners/agent-conversation-presentation.js";

const DEFAULT_RUN_TIMEOUT_MILLIS = 10 * 60_000;

interface WarmAgent {
  agent: Agent;
  partnerRevisionId: string;
  workspacePath?: string;
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
    sources: Pick<ReasoningSourceSelector, "selectInitial">;
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

  async runEphemeral(request: PartnerRunRequest, revision: PartnerRevision, context: { knowledgeSection: string; skillSection: string }): Promise<{ conversation: AgentConversationDraft[]; externalRunId: string; output: PartnerRunOutput; status: PartnerRunStatus }> {
    if (revision.kind !== "local-pi") throw new Error("local_partner_kind_required");
    const execution = await this.dependencies.contexts.loadForExecution(request.contextSnapshotId);
    if (execution === null) throw new Error("workbench_context_snapshot_not_found");
    const externalRunId = `local_pi:${request.actionId}`;
    const pin = await this.dependencies.sources.selectInitial(externalRunId);
    const resolved = await this.dependencies.resolver.resolve(pin);
    const configuredPrompt = await this.#configuredPrompt(revision);
    const tools = execution.workspacePath === undefined ? [] : this.dependencies.tools.create(execution.workspacePath, this.#effectiveToolNames(revision));
    const allowed = new Set(tools.map((tool) => tool.name));
    const agent = new Agent({
      beforeToolCall: ({ toolCall }) => Promise.resolve(allowed.has(toolCall.name)
        ? undefined
        : { block: true, reason: "partner_tool_not_allowed" }),
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
    await this.#promptWithDeadline(agent, request.taskProjection);
    const failed = agent.state.messages.some((message) => message.role === "assistant" && message.stopReason === "error");
    const body = assistantText(agent.state.messages);
    return {
      conversation: draftAgentConversation(request.taskProjection, body, agent.state.messages),
      externalRunId,
      output: { artifacts: [], body },
      status: failed ? "FAILED" : "COMPLETED",
    };
  }

  async runResidentTurn(input: ResidentTurnInput): Promise<ResidentTurnResult> {
    const { revision } = input;
    if (revision.kind !== "local-pi") throw new Error("local_partner_kind_required");
    const execution = await this.dependencies.contexts.loadForExecution(input.request.contextSnapshotId);
    if (execution === null) throw new Error("workbench_context_snapshot_not_found");
    let warm = this.#warm.get(input.instanceId);
    if (warm !== undefined && (warm.partnerRevisionId !== revision.partnerRevisionId || warm.workspacePath !== execution.workspacePath)) {
      this.#warm.delete(input.instanceId);
      warm = undefined;
    }
    const systemPrompt = this.#systemPrompt(
      await this.#configuredPrompt(revision), input.request, execution.promptSection, input.knowledgeSection, input.skillSection,
    );
    if (warm === undefined) {
      const pin = await this.dependencies.sources.selectInitial(`local_pi_instance:${input.instanceId}`);
      const resolved = await this.dependencies.resolver.resolve(pin);
      const tools = execution.workspacePath === undefined ? [] : this.dependencies.tools.create(execution.workspacePath, this.#effectiveToolNames(revision));
      const allowed = new Set(tools.map((tool) => tool.name));
      const agent = new Agent({
        beforeToolCall: ({ toolCall }) => Promise.resolve(allowed.has(toolCall.name)
          ? undefined
          : { block: true, reason: "partner_tool_not_allowed" }),
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
        ...(execution.workspacePath === undefined ? {} : { workspacePath: execution.workspacePath }),
      };
      this.#trackWarm(input.instanceId, warm);
    }
    warm.agent.state.systemPrompt = systemPrompt;
    const previousMessageCount = warm.agent.state.messages.length;
    await this.#promptWithDeadline(warm.agent, input.request.taskProjection);
    const failed = warm.agent.state.messages.some((message) => message.role === "assistant" && message.stopReason === "error");
    const turnMessages = warm.agent.state.messages.slice(previousMessageCount);
    const body = assistantText(turnMessages);
    return {
      conversation: draftAgentConversation(input.request.taskProjection, body, turnMessages),
      externalRunId: `local_pi:${input.request.actionId}`,
      externalSessionRef: `partner_instance_messages:${input.instanceId}`,
      messages: [...warm.agent.state.messages],
      output: { artifacts: [], body },
      status: failed ? "FAILED" : "COMPLETED",
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
    let configuredPrompt = "You are a local Pi coding partner. Work only inside the assigned workspace and complete the requested work.";
    if (revision.promptRef !== undefined) {
      const stored = await this.dependencies.prompts.read(revision.promptRef);
      if (stored === null) throw new Error("partner_prompt_not_found");
      configuredPrompt = stored;
    }
    return configuredPrompt;
  }

  #effectiveToolNames(revision: PartnerRevision): string[] {
    if (revision.tools.length === 0) return [...this.dependencies.tools.names];
    const known = new Set(this.dependencies.tools.names);
    return revision.tools.filter((name) => known.has(name));
  }

  #systemPrompt(configuredPrompt: string, request: PartnerRunRequest, workbenchSection: string, knowledgeSection: string, skillSection: string): string {
    return [
      configuredPrompt,
      "Never access paths outside the assigned workspace.",
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
