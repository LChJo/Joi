import type { ModelSourceCatalog } from "../../application/ports/model-source-ports.js";
import { DomainError } from "../../domain/errors.js";
import type { ModelSourceAccessMode, ModelSourceKind, ModelSourceProtocol } from "../../domain/model-sources/model-source.js";
import { defaultModelSourceProtocol, getDirectModelSourcePreset } from "./provider-presets.js";

function normalizeDirectModelId(kind: ModelSourceKind, accessMode: Exclude<ModelSourceAccessMode, "custom">, modelId: string | undefined): string | undefined {
  if (kind !== "kimi" || accessMode !== "coding-plan") return modelId;
  if (modelId === "kimi-k3") return "k3";
  if (modelId === "kimi-k3-256k") return "k3-256k";
  return modelId;
}

export class PiModelSourceCatalog implements ModelSourceCatalog {
  resolve(
    kind: ModelSourceKind,
    requestedModelId?: string,
    requestedAccessMode?: ModelSourceAccessMode,
    requestedProtocol?: ModelSourceProtocol,
  ) {
    const requested = requestedModelId?.trim();
    const accessMode = requestedAccessMode ?? (kind === "generic-openai" ? "custom" : "api");
    if (kind === "generic-openai") {
      if (accessMode !== "custom") throw new DomainError("model_source_access_mode_invalid", "Generic sources must use custom access.");
      if (requested === undefined || requested.length === 0) {
        throw new DomainError("model_source_model_required", "Generic model source model ID is required.");
      }
      const protocol = requestedProtocol ?? "openai";
      return {
        accessMode,
        capability: "custom-unverified-tools" as const,
        displayName: "通用平台",
        modelId: requested,
        protocol,
      };
    }

    if (accessMode === "custom") throw new DomainError("model_source_access_mode_invalid", "Direct sources cannot use custom access.");
    const protocol = requestedProtocol ?? defaultModelSourceProtocol(kind, accessMode);
    let preset;
    try {
      preset = getDirectModelSourcePreset(kind, accessMode, protocol);
    } catch {
      throw new DomainError("model_source_protocol_invalid", "The selected protocol is unavailable for this provider access mode.");
    }
    const normalized = normalizeDirectModelId(kind, accessMode, requested);
    const modelId = normalized === undefined || normalized.length === 0 ? preset.defaultModelId : normalized;
    return {
      accessMode,
      capability: preset.models.some((model) => model.id === modelId)
        ? "release-tested" as const
        : "custom-unverified-tools" as const,
      displayName: preset.label,
      modelId,
      presetVersion: preset.presetVersion,
      protocol,
    };
  }
}
