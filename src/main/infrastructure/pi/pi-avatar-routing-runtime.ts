import { Type } from "@earendil-works/pi-ai";

import type { AvatarRoutingRuntime } from "../../application/ports/joi-coordinator.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import { modelRequiresAlwaysOnThinking } from "./provider-presets.js";

export class PiAvatarRoutingRuntime implements AvatarRoutingRuntime {
  constructor(private readonly dependencies: {
    resolver: PiConfiguredModelResolver;
    sources: Pick<ReasoningSourceSelector, "selectInitial">;
  }) {}

  async decide(input: Parameters<AvatarRoutingRuntime["decide"]>[0]): Promise<unknown> {
    const routeId = `routing_${crypto.randomUUID()}`;
    const pin = await this.dependencies.sources.selectInitial(routeId);
    const { model, models } = await this.dependencies.resolver.resolve(pin);
    const response = await models.completeSimple(model, {
      messages: [{
        content: [
          input.repair
            ? "The previous selection was invalid. Select exactly one listed Avatar."
            : "Select exactly one Avatar for this user input. Prefer creating a new Avatar for a distinct new goal; select an existing Avatar only for a clear continuation of its scope.",
          `Input: ${input.input}`,
          `Avatar summaries: ${JSON.stringify(input.avatars)}`,
        ].join("\n"),
        role: "user",
        timestamp: Date.now(),
      }],
      systemPrompt: "You route inputs for the single global joi. Select an existing Avatar only when the input clearly continues that Avatar's ongoing project or scope; an Avatar whose summary describes a generic workbench or fallback only fits miscellaneous inputs that belong nowhere else. For a distinct new goal or project, create a new Avatar. Never infer or reveal Avatar body content.",
      tools: [{
        constrainedSampling: { strict: "prefer", type: "json_schema" },
        description: "Select one existing Avatar by its exact ID.",
        name: "avatar_select",
        parameters: Type.Object({
          action: Type.Literal("select"),
          avatarId: Type.String(),
        }),
      }, {
        constrainedSampling: { strict: "prefer", type: "json_schema" },
        description: "Create a new isolated Avatar context for a distinct new goal or project. Do not route new goals into the generic workbench Avatar.",
        name: "avatar_create",
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
      && (block.name === "avatar_select" || block.name === "avatar_create"));
    return call?.type === "toolCall" ? call.arguments : null;
  }
}
