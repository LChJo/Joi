import type { ModelSourceDto, PartnerModelTestDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import type { Clock } from "../ports/runtime-store.js";
import type { ModelSourceService } from "../model-sources/model-source-service.js";
import type { PartnerRegistryService } from "./partner-registry-service.js";
import type { PartnerEngineCatalog } from "./partner-engine-catalog.js";

export class PartnerModelProbeService {
  constructor(private readonly dependencies: {
    clock: Clock;
    engines?: Pick<PartnerEngineCatalog, "test">;
    partners: Pick<PartnerRegistryService, "inspect">;
    sources: Pick<ModelSourceService, "list" | "validate">;
  }) {}

  async test(partnerId: string): Promise<PartnerModelTestDto> {
    const partner = await this.dependencies.partners.inspect(partnerId);
    if (partner.kind !== "local-pi") {
      throw new DomainError("partner_model_test_unsupported", "Only local Pi partners use a managed model source.");
    }
    if (partner.engine === "codex" || partner.engine === "claude-code") {
      const testedAt = this.dependencies.clock.now().toISOString();
      const modelId = partner.engineModelId;
      if (this.dependencies.engines === undefined) {
        return { ...(modelId === undefined ? {} : { modelId }), partnerId, reasonCode: "partner_engine_probe_unavailable", status: "FAILED", testedAt };
      }
      const result = await this.dependencies.engines.test(partner.engine, modelId);
      return {
        ...(modelId === undefined ? {} : { modelId }),
        partnerId,
        ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
        status: result.available ? "READY" : "FAILED",
        testedAt: this.dependencies.clock.now().toISOString(),
      };
    }
    const sources = await this.dependencies.sources.list();
    const source = partner.modelSourceId === undefined
      ? effectiveGlobalSource(sources)
      : sources.find((candidate) => candidate.sourceId === partner.modelSourceId);
    const testedAt = this.dependencies.clock.now().toISOString();
    if (source === undefined || source.status === "DISABLED") {
      return {
        ...(partner.modelIdOverride === undefined ? {} : { modelId: partner.modelIdOverride }),
        partnerId,
        reasonCode: "partner_model_source_not_ready",
        status: "FAILED",
        testedAt,
      };
    }
    const modelId = partner.modelIdOverride ?? source.activeModel.id;
    const identity = { modelId, partnerId, sourceDisplayName: source.displayName, sourceId: source.sourceId };
    if (modelId !== source.activeModel.id) {
      return { ...identity, reasonCode: "partner_model_override_not_ready", status: "FAILED", testedAt };
    }
    try {
      const validated = await this.dependencies.sources.validate(source.sourceId);
      const completedAt = validated.lastValidatedAt ?? this.dependencies.clock.now().toISOString();
      if (validated.status === "READY") return { ...identity, status: "READY", testedAt: completedAt };
      return {
        ...identity,
        reasonCode: validated.reasonCode ?? "partner_model_test_failed",
        status: "FAILED",
        testedAt: completedAt,
      };
    } catch {
      return { ...identity, reasonCode: "partner_model_test_failed", status: "FAILED", testedAt: this.dependencies.clock.now().toISOString() };
    }
  }
}

function effectiveGlobalSource(sources: ModelSourceDto[]): ModelSourceDto | undefined {
  const candidates = sources.filter((source) => source.status !== "DISABLED").sort((left, right) => left.order - right.order);
  return candidates.find((source) => source.status === "READY") ?? candidates[0];
}
