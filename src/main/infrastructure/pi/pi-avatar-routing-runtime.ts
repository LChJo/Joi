import { Type } from "@earendil-works/pi-ai";

import type { AvatarRoutingRuntime } from "../../application/ports/joi-coordinator.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";

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
            : "Select exactly one Avatar for this user input.",
          `Input: ${input.input}`,
          `Avatar summaries: ${JSON.stringify(input.avatars)}`,
        ].join("\n"),
        role: "user",
        timestamp: Date.now(),
      }],
      systemPrompt: "You route inputs for the single global joi. Select an existing Avatar when it fits; otherwise create one. Never infer or reveal Avatar body content.",
      tools: [{
        constrainedSampling: { strict: "prefer", type: "json_schema" },
        description: "Select one existing Avatar by its exact ID.",
        name: "avatar.select",
        parameters: Type.Object({
          action: Type.Literal("select"),
          avatarId: Type.String(),
        }),
      }, {
        constrainedSampling: { strict: "prefer", type: "json_schema" },
        description: "Create a new isolated Avatar context only when no existing summary fits.",
        name: "avatar.create",
        parameters: Type.Object({
          action: Type.Literal("create"),
          name: Type.String(),
          personaSummary: Type.String(),
          projectLabel: Type.String(),
          scopeSummary: Type.String(),
        }),
      }],
    }, { maxTokens: 128 });
    const call = response.content.find((block) => block.type === "toolCall"
      && (block.name === "avatar.select" || block.name === "avatar.create"));
    return call?.type === "toolCall" ? call.arguments : null;
  }
}
