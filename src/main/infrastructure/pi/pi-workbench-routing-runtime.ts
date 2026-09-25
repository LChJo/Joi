import { Type } from "@earendil-works/pi-ai";

import type { WorkbenchRoutingRuntime } from "../../application/ports/joi-coordinator.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import { modelRequiresAlwaysOnThinking } from "./provider-presets.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import { trackPiModels } from "./pi-usage.js";

export class PiWorkbenchRoutingRuntime implements WorkbenchRoutingRuntime {
  constructor(private readonly dependencies: {
    usage?: UsageRecorder;
    resolver: PiConfiguredModelResolver;
    sources: Pick<ReasoningSourceSelector, "selectInitial">;
  }) {}

  async decide(input: Parameters<WorkbenchRoutingRuntime["decide"]>[0]): Promise<unknown> {
    const routeId = `routing_${crypto.randomUUID()}`;
    const pin = await this.dependencies.sources.selectInitial(routeId);
    const { model, models } = await this.dependencies.resolver.resolve(pin);
    const response = await trackPiModels(models, this.dependencies.usage, () => ({ engine: "pi", purpose: "routing", sourceId: pin.sourceId, modelId: pin.modelId })).completeSimple(model, {
      messages: [{
        content: [
          input.repair
            ? "The previous selection was invalid. Select exactly one listed Workbench."
            : "Select exactly one Workbench for this user input. Name a new Workbench after a durable work cluster and environment with a 工坊 suffix (for example 前端集成工坊), never after a partner role (搭档 names belong to partner cards); for frontend debugging and analysis use the frontend debugging environment label. Prefer creating a new Workbench for a distinct new goal; select an existing Workbench only for a clear continuation of its scope.",
          `Input: ${input.input}`,
          `Workbench summaries: ${JSON.stringify(input.workbenches)}`,
        ].join("\n"),
        role: "user",
        timestamp: Date.now(),
      }],
      systemPrompt: "You route inputs for the single global joi. Select an existing workbench only when the input clearly continues that workbench's ongoing project or scope; a workbench whose summary describes a generic workbench or fallback only fits miscellaneous inputs that belong nowhere else. For a distinct new goal or project, create a new workbench. Never infer or reveal workbench body content.",
      tools: [{
        constrainedSampling: { strict: "prefer", type: "json_schema" },
        description: "Select one existing Workbench by its exact ID.",
        name: "workbench_select",
        parameters: Type.Object({
          action: Type.Literal("select"),
          workbenchId: Type.String(),
        }),
      }, {
        constrainedSampling: { strict: "prefer", type: "json_schema" },
        description: "Create a new isolated Workbench context for a distinct new goal or project. Use a cluster-oriented name with a 工坊 suffix (for example 前端集成工坊, 迁移规划工坊) and scope for the working environment; do not use a partner role or a 搭档 name as the Workbench name. Do not route new goals into the generic workbench Workbench.",
        name: "workbench_create",
        parameters: Type.Object({
          action: Type.Literal("create"),
          name: Type.String(),
          personaSummary: Type.String(),
          projectLabel: Type.String(),
          scopeSummary: Type.String(),
        }),
      }],
    }, { maxTokens: 128, ...(modelRequiresAlwaysOnThinking(model.baseUrl) ? { reasoning: "low" as const } : {}) });
    const call = response.content.find((block) => block.type === "toolCall"
      && (block.name === "workbench_select" || block.name === "workbench_create"));
    return call?.type === "toolCall" ? call.arguments : null;
  }
}
