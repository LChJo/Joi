import type { EffectiveModelLimits, ModelLimitReader } from "../../application/ports/model-source-ports.js";
import type { ModelSourceAccessMode, ModelSourceKind, ModelSourceProtocol } from "../../domain/model-sources/model-source.js";
import { getDirectModelSourcePreset, type DirectModelSourcePreset } from "./provider-presets.js";
import { effectiveModelLimits } from "./source-provider-factory.js";

/**
 * Resolves a route's real size by reusing the same merge the provider factory applies, so the
 * settings page can show what a request will actually be sized to rather than only what the user
 * typed. This is infrastructure, not application, because half of that merge — what a provider
 * said when it refused an oversized request — lives in this layer's memory for the life of the
 * process (see pi-model-budget).
 */
export class PiModelLimitReader implements ModelLimitReader {
  effective(input: {
    accessMode: ModelSourceAccessMode;
    contextWindow?: number;
    kind: ModelSourceKind;
    maxOutputTokens?: number;
    modelId: string;
    protocol: ModelSourceProtocol;
    sourceId: string;
  }): EffectiveModelLimits {
    const overrides = {
      ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    };
    if (input.kind === "generic-openai") {
      // A gateway has no preset to fall back to, so the factory's conservative gateway defaults
      // are the whole answer — which is exactly what a real request on this route gets.
      return effectiveModelLimits({
        ...overrides,
        baseUrl: "",
        displayName: "",
        kind: "generic-openai",
        modelId: input.modelId,
        protocol: input.protocol,
        sourceId: input.sourceId,
      }, undefined);
    }
    const accessMode = input.accessMode === "custom" ? "api" : input.accessMode;
    let preset: DirectModelSourcePreset | undefined;
    try {
      preset = getDirectModelSourcePreset(input.kind, accessMode, input.protocol);
    } catch {
      // A kind/access-mode/protocol triple with no preset is not an error here. This is a read of
      // a source that may predate a preset change, and the list endpoint must still render it —
      // the factory rejects the route when it is actually used, which is where that belongs.
      preset = undefined;
    }
    const kimiK3 = input.kind === "kimi" && accessMode === "coding-plan"
      && (input.modelId === "k3" || input.modelId === "k3-256k");
    return effectiveModelLimits({
      ...overrides,
      accessMode,
      kind: input.kind,
      modelId: input.modelId,
      protocol: input.protocol,
      sourceId: input.sourceId,
    }, preset?.models.find((candidate) => candidate.id === input.modelId), kimiK3);
  }
}
