import { createModels, type Api, type CredentialStore, type Model, type Models } from "@earendil-works/pi-ai";

import type { ModelSourceRepository } from "../../application/ports/model-source-ports.js";
import { createPiSourceProvider } from "./source-provider-factory.js";

export interface ResolvedPiModel {
  model: Model<Api>;
  models: Models;
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
    const provider = createPiSourceProvider(source.activeSourceRevision.kind === "generic-openai"
      ? {
        baseUrl: record.baseUrl ?? "",
        displayName: source.activeSourceRevision.displayName,
        kind: "generic-openai",
        modelId: input.modelId,
        protocol: source.activeSourceRevision.protocol,
        sourceId: input.sourceId,
      }
      : {
        accessMode: source.activeSourceRevision.accessMode === "coding-plan" ? "coding-plan" as const : "api" as const,
        kind: source.activeSourceRevision.kind,
        modelId: input.modelId,
        protocol: source.activeSourceRevision.protocol,
        sourceId: input.sourceId,
      });
    const models = createModels({
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
      credentials: this.dependencies.credentials,
    });
    models.setProvider(provider);
    const model = provider.getModels().find((candidate) => candidate.id === input.modelId);
    if (model === undefined) throw new Error("model_not_found");
    return { model, models };
  }
}
