import { Type } from "typebox";
import { } from "@earendil-works/pi-ai";

import type { WorkbenchRoutingRuntime } from "../../application/ports/joi-coordinator.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import { trackPiModels } from "./pi-usage.js";

// Structured route decisions and editable drafts both need room for their complete tool arguments.
const ROUTE_MAX_TOKENS = 512;
const ABSTRACT_MAX_TOKENS = 384;

const SELECT_TOOL = {
  constrainedSampling: { strict: "prefer", type: "json_schema" },
  description: "Select the single Workbench that clearly covers the target project and primary work. A shared topic or reference source is insufficient.",
  name: "workbench_select",
  parameters: Type.Object({
    action: Type.Literal("select"),
    workbenchId: Type.String(),
    matchKind: Type.Union([Type.Literal("SAME_PROJECT"), Type.Literal("SAME_SCOPE")]),
  }),
} as const;

const CREATE_TOOL = {
  constrainedSampling: { strict: "prefer", type: "json_schema" },
  description: "Propose an editable Workbench draft for user confirmation. This does not create a Workbench.",
  name: "workbench_create",
  parameters: Type.Object({
    action: Type.Literal("create"),
    name: Type.String(),
    personaSummary: Type.String(),
    projectLabel: Type.String(),
    scopeSummary: Type.String(),
  }),
} as const;

const CLARIFY_TOOL = {
  constrainedSampling: { strict: "prefer", type: "json_schema" },
  description: "Ask the user to choose or create a Workbench when there is no clear unique scope match.",
  name: "workbench_clarify",
  parameters: Type.Object({ action: Type.Literal("clarify") }),
} as const;

/** What a cluster name is, in one clause the model can check its own answer against. */
const CLUSTER_NAMING_RULES = [
  "- Name a durable work cluster or environment, not this one request: a short noun phrase with a 工坊 suffix (for example 前端集成工坊, 行程规划工坊).",
  "- Preserve a real project name when useful, but never use a truncated or restated request as the name or scope.",
  "- name, projectLabel and scopeSummary must still make sense to someone who never saw this input.",
  "- Do not use a partner role or a 搭档 name as the Workbench name; 搭档 names belong to partner cards.",
].join("\n");

const ROUTE_SYSTEM_PROMPT = [
  "You route inputs for the single global joi.",
  "A Workbench is a durable work cluster and environment that holds many requests over time.",
  "Automatically select only a unique, explicit SAME_PROJECT or SAME_SCOPE match that covers both the target and the primary requested work.",
  "SAME_PROJECT requires the same named project and compatible work; SAME_SCOPE requires an explicit responsibility that covers the actual work and its target.",
  "Shared keywords, technology, websites, reference sources, or a broad related topic are not sufficient. Use workbench_clarify for weak, ambiguous, unknown, or missing matches.",
  "Reading a local joi repository and improving its README while consulting GitHub projects is engineering maintenance, not AI news or open-source trend research.",
  "An existing generic workbench is not an automatic fallback. New work contexts require user confirmation; workbench_create only proposes a draft.",
  "Never infer or reveal workbench body content.",
].join(" ");

const ABSTRACT_SYSTEM_PROMPT = [
  "You name Workbenches for the single global joi.",
  "Given an input that no existing Workbench covers, name the durable work cluster and environment it belongs to — the home the work will keep returning to, not the request itself.",
  "Never infer or reveal workbench body content.",
].join(" ");

export class PiWorkbenchRoutingRuntime implements WorkbenchRoutingRuntime {
  constructor(private readonly dependencies: {
    usage?: UsageRecorder;
    resolver: PiConfiguredModelResolver;
    sources: Pick<ReasoningSourceSelector, "selectInitial">;
  }) {}

  async decide(input: Parameters<WorkbenchRoutingRuntime["decide"]>[0]): Promise<unknown> {
    const abstract = input.mode === "abstract";
    const routeId = `routing_${crypto.randomUUID()}`;
    const pin = await this.dependencies.sources.selectInitial(routeId);
    const { model, models, thinkingLevel } = await this.dependencies.resolver.resolve(pin);
    const instruction = abstract
      ? input.repair
        ? "The previous name restated the user's request instead of naming a durable work cluster. Name the cluster instead."
        : "No existing Workbench covers this input. Name the durable work cluster it belongs to."
      : input.repair
        ? "The previous decision was invalid. Select only a clear unique project/scope match, otherwise ask the user to choose or propose a draft."
        : "Select only a clear unique project/scope match. If uncertain, ask the user to choose; you may propose an editable new context.";
    const response = await trackPiModels(models, this.dependencies.usage, () => ({ engine: "pi", purpose: "routing", sourceId: pin.sourceId, modelId: pin.modelId })).completeSimple(model, {
      messages: [{
        content: [
          instruction,
          `Rules when creating:\n${CLUSTER_NAMING_RULES}`,
          `Input: ${input.input}`,
          `Workbench summaries: ${JSON.stringify(input.workbenches)}`,
        ].join("\n"),
        role: "user",
        timestamp: Date.now(),
      }],
      systemPrompt: abstract ? ABSTRACT_SYSTEM_PROMPT : ROUTE_SYSTEM_PROMPT,
      tools: abstract ? [CREATE_TOOL] : [SELECT_TOOL, CLARIFY_TOOL, CREATE_TOOL],
    }, { maxTokens: abstract ? ABSTRACT_MAX_TOKENS : ROUTE_MAX_TOKENS, ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }) });
    const call = response.content.find((block) => block.type === "toolCall"
      && (block.name === "workbench_select" || block.name === "workbench_create" || block.name === "workbench_clarify"));
    return call?.type === "toolCall" ? call.arguments : null;
  }
}
