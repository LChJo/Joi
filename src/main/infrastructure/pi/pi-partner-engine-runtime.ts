/* Pi hooks require Promise-returning callbacks. */
/* eslint-disable @typescript-eslint/require-await */
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";

import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PartnerPromptStore, PartnerRunRequest, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerEngineRuntime, ResidentTurnInput, ResidentTurnResult } from "../../application/ports/partner-instances.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { PiCodingToolFactory } from "./pi-coding-tool-factory.js";

interface WarmAgent {
  agent: Agent;
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
    prompts: Pick<PartnerPromptStore, "read">;
    resolver: PiConfiguredModelResolver;
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

  async runEphemeral(request: PartnerRunRequest, revision: PartnerRevision, context: { knowledgeSection: string; skillSection: string }): Promise<{ externalRunId: string; status: PartnerRunStatus }> {
    if (revision.kind !== "local-pi") throw new Error("local_partner_kind_required");
    if (revision.workspaceRef === undefined) throw new Error("partner_workspace_required");
    const externalRunId = `local_pi:${request.actionId}`;
    const pin = await this.dependencies.sources.selectInitial(externalRunId);
    const resolved = await this.dependencies.resolver.resolve(pin);
    const configuredPrompt = await this.#configuredPrompt(revision);
    const tools = this.dependencies.tools.create(revision.workspaceRef, this.#effectiveToolNames(revision));
    const allowed = new Set(tools.map((tool) => tool.name));
    const agent = new Agent({
      beforeToolCall: ({ toolCall }) => Promise.resolve(allowed.has(toolCall.name)
        ? undefined
        : { block: true, reason: "partner_tool_not_allowed" }),
      initialState: {
        messages: [],
        model: resolved.model,
        systemPrompt: this.#systemPrompt(configuredPrompt, request, context.knowledgeSection, context.skillSection),
        tools,
      },
      sessionId: externalRunId,
      streamFn: resolved.models.streamSimple.bind(resolved.models),
      toolExecution: "sequential",
    });
    await agent.prompt(request.taskProjection);
    const failed = agent.state.messages.some((message) => message.role === "assistant" && message.stopReason === "error");
    return { externalRunId, status: failed ? "FAILED" : "COMPLETED" };
  }

  async runResidentTurn(input: ResidentTurnInput): Promise<ResidentTurnResult> {
    const { revision } = input;
    if (revision.kind !== "local-pi") throw new Error("local_partner_kind_required");
    if (revision.workspaceRef === undefined) throw new Error("partner_workspace_required");
    let warm = this.#warm.get(input.instanceId);
    if (warm === undefined) {
      const pin = await this.dependencies.sources.selectInitial(`local_pi_instance:${input.instanceId}`);
      const resolved = await this.dependencies.resolver.resolve(pin);
      const configuredPrompt = await this.#configuredPrompt(revision);
      const tools = this.dependencies.tools.create(revision.workspaceRef, this.#effectiveToolNames(revision));
      const allowed = new Set(tools.map((tool) => tool.name));
      const agent = new Agent({
        beforeToolCall: ({ toolCall }) => Promise.resolve(allowed.has(toolCall.name)
          ? undefined
          : { block: true, reason: "partner_tool_not_allowed" }),
        initialState: {
          messages: (input.restoredMessages ?? []) as AgentMessage[],
          model: resolved.model,
          systemPrompt: this.#systemPrompt(configuredPrompt, input.request, input.knowledgeSection, input.skillSection),
          tools,
        },
        sessionId: `local_pi_instance:${input.instanceId}`,
        streamFn: resolved.models.streamSimple.bind(resolved.models),
        toolExecution: "sequential",
      });
      warm = { agent };
      this.#trackWarm(input.instanceId, warm);
    }
    await warm.agent.prompt(input.request.taskProjection);
    const failed = warm.agent.state.messages.some((message) => message.role === "assistant" && message.stopReason === "error");
    return {
      externalRunId: `local_pi:${input.request.actionId}`,
      externalSessionRef: `partner_instance_messages:${input.instanceId}`,
      messages: [...warm.agent.state.messages],
      status: failed ? "FAILED" : "COMPLETED",
    };
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

  #systemPrompt(configuredPrompt: string, request: PartnerRunRequest, knowledgeSection: string, skillSection: string): string {
    return [
      configuredPrompt,
      "Never access paths outside the assigned workspace.",
      `Avatar scope: ${request.avatarId}`,
      `Work item: ${request.workId}`,
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
