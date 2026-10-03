import { Type } from "@earendil-works/pi-ai";

import type { WorkbenchRoutingRuntime } from "../../application/ports/joi-coordinator.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import { trackPiModels } from "./pi-usage.js";

// Naming a cluster is a longer answer than picking one — four short fields plus whatever
// reasoning the route spends — so the abstract pass gets more room than the routing pass.
const ROUTE_MAX_TOKENS = 128;
const ABSTRACT_MAX_TOKENS = 384;

const SELECT_TOOL = {
  constrainedSampling: { strict: "prefer", type: "json_schema" },
  description: "Select one existing Workbench by its exact ID.",
  name: "workbench_select",
  parameters: Type.Object({
    action: Type.Literal("select"),
    workbenchId: Type.String(),
  }),
} as const;

const CREATE_TOOL = {
  constrainedSampling: { strict: "prefer", type: "json_schema" },
  description: "Create a new isolated Workbench context for a work cluster none of the listed Workbenches covers.",
  name: "workbench_create",
  parameters: Type.Object({
    action: Type.Literal("create"),
    name: Type.String(),
    personaSummary: Type.String(),
    projectLabel: Type.String(),
    scopeSummary: Type.String(),
  }),
} as const;

/** What a cluster name is, in one clause the model can check its own answer against. */
const CLUSTER_NAMING_RULES = [
  "- Name a durable work cluster or environment, not this one request: a short noun phrase with a 工坊 suffix (for example 前端集成工坊, 行程规划工坊).",
  "- Never copy the user's wording, or any run of it, into name, projectLabel or scopeSummary.",
  "- name, projectLabel and scopeSummary must still make sense to someone who never saw this input.",
  "- Do not use a partner role or a 搭档 name as the Workbench name; 搭档 names belong to partner cards.",
].join("\n");

const ROUTE_SYSTEM_PROMPT = [
  "You route inputs for the single global joi.",
  "A Workbench is a durable work cluster and environment that holds many requests over time.",
  "Prefer an existing Workbench whenever its scope can hold the input — work that continues a project belongs with that project, and a request that merely differs in wording is still the same project.",
  "Create a new Workbench only when no listed Workbench could hold this input.",
  "A workbench whose summary describes a generic or fallback workbench only fits miscellaneous inputs that belong nowhere else.",
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
        ? "The previous decision was invalid. Select exactly one listed Workbench, or name a durable work cluster that none of them covers."
        : "Route this user input to exactly one listed Workbench. Select an existing one whenever its scope can hold the input; create one only when none can.";
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
      tools: abstract ? [CREATE_TOOL] : [SELECT_TOOL, CREATE_TOOL],
    }, { maxTokens: abstract ? ABSTRACT_MAX_TOKENS : ROUTE_MAX_TOKENS, ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }) });
    const call = response.content.find((block) => block.type === "toolCall"
      && (block.name === "workbench_select" || block.name === "workbench_create"));
    return call?.type === "toolCall" ? call.arguments : null;
  }
}
