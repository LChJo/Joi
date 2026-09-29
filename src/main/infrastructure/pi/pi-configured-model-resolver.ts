import { createModels, type Api, type CredentialStore, type Model, type ModelThinkingLevel, type Models } from "@earendil-works/pi-ai";

import type { ModelSourceRepository } from "../../application/ports/model-source-ports.js";
import { createPiSourceProvider, defaultThinkingLevel, piSourceProviderInput } from "./source-provider-factory.js";

export interface ResolvedPiModel {
  /** The session-compaction threshold configured on the model source; absent means the runtime
   *  falls back to its own default. Only the reasoning runtime has a session to compact. */
  compactionThresholdPercent?: number;
  model: Model<Api>;
  models: Models;
  /** The level every request on this route runs at: the user's configured thinking effort,
   *  else joi's endpoint allowlist. Runtimes must use this instead of re-deriving it. */
  thinkingLevel: ModelThinkingLevel;
}

export interface PiConfiguredModelResolver {
  resolve(input: {
    modelId: string;
    modelRevisionId: string;
    sourceId: string;
    sourceRevisionId: string;
  }): Promise<ResolvedPiModel>;
}

export class RepositoryPiConfiguredModelResolver implements PiConfiguredModelResolver {
  constructor(private readonly dependencies: {
    credentials: CredentialStore;
    repository: Pick<ModelSourceRepository, "get">;
  }) {}

  async resolve(input: {
    modelId: string;
    modelRevisionId: string;
    sourceId: string;
    sourceRevisionId: string;
  }): Promise<ResolvedPiModel> {
    const record = await this.dependencies.repository.get(input.sourceId);
    if (record?.source.status !== "READY") throw new Error("model_source_not_ready");
    if (record.source.activeSourceRevision.sourceRevisionId !== input.sourceRevisionId
      || record.source.activeModelRevision.modelRevisionId !== input.modelRevisionId
      || record.source.activeModelRevision.modelId !== input.modelId) {
      throw new Error("model_source_revision_mismatch");
    }
    const source = record.source;
    const activeModelRevision = source.activeModelRevision;
    // The configured limits are the user's declaration about this model; the factory folds them
    // in underneath whatever size the provider itself has stated.
    const provider = createPiSourceProvider(piSourceProviderInput(record));
    const models = createModels({
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
      credentials: this.dependencies.credentials,
    });
    models.setProvider(provider);
    const model = provider.getModels().find((candidate) => candidate.id === input.modelId);
    if (model === undefined) throw new Error("model_not_found");
    return {
      // Re-clamped as a backstop against a hand-edited database: an out-of-range value would
      // otherwise make the runtime constructor throw and take the whole session down.
      ...(activeModelRevision.compactionThresholdPercent === undefined ? {} : {
        compactionThresholdPercent: Math.min(95, Math.max(50, activeModelRevision.compactionThresholdPercent)),
      }),
      model,
      models,
      thinkingLevel: defaultThinkingLevel(activeModelRevision.thinkingEffort, model.baseUrl),
    };
  }
}
