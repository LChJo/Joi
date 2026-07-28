import type { ModelSourceCatalog } from "../../application/ports/model-source-ports.js";
import { DomainError } from "../../domain/errors.js";
import type { ModelSourceKind } from "../../domain/model-sources/model-source.js";
import { getDirectModelSourcePreset } from "./provider-presets.js";

export class PiModelSourceCatalog implements ModelSourceCatalog {
  resolve(kind: ModelSourceKind, requestedModelId?: string) {
    const requested = requestedModelId?.trim();
    if (kind === "generic-openai") {
      if (requested === undefined || requested.length === 0) {
        throw new DomainError("model_source_model_required", "Generic model source model ID is required.");
      }
      return {
        capability: "custom-unverified-tools" as const,
        displayName: "通用平台",
        modelId: requested,
      };
    }

    const preset = getDirectModelSourcePreset(kind);
    const modelId = requested === undefined || requested.length === 0 ? preset.defaultModelId : requested;
    return {
      capability: preset.models.some((model) => model.id === modelId)
        ? "release-tested" as const
        : "custom-unverified-tools" as const,
      displayName: preset.label,
      modelId,
      presetVersion: preset.presetVersion,
    };
  }
}
