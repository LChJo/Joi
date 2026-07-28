import { createModels, type CredentialStore } from "@earendil-works/pi-ai";

import type { ModelSourceRecord, ModelSourceValidator } from "../../application/ports/model-source-ports.js";
import type { Clock } from "../../application/ports/runtime-store.js";
import { createPiSourceProvider } from "./source-provider-factory.js";

type Probe = (record: ModelSourceRecord) => Promise<void>;

function failureReason(error: unknown): { reasonCode: string; status: "DEGRADED" | "NEEDS_AUTH" } {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|api.?key|credential/u.test(message)) {
    return { reasonCode: "auth_failed", status: "NEEDS_AUTH" };
  }
  if (/model.+(?:not found|missing|unknown|unavailable)|(?:not found|unknown).+model/u.test(message)) {
    return { reasonCode: "model_unavailable", status: "DEGRADED" };
  }
  return { reasonCode: "endpoint_unreachable", status: "DEGRADED" };
}

export class PiModelSourceValidator implements ModelSourceValidator {
  readonly #clock: Clock;
  readonly #probe: Probe;

  constructor(input: { clock: Clock; credentials?: CredentialStore; probe?: Probe }) {
    this.#clock = input.clock;
    this.#probe = input.probe ?? this.#createProbe(input.credentials);
  }

  async validate(record: ModelSourceRecord) {
    const validatedAt = this.#clock.now().toISOString();
    try {
      await this.#probe(record);
      return { status: "READY" as const, validatedAt };
    } catch (error) {
      return { ...failureReason(error), validatedAt };
    }
  }

  #createProbe(credentials: CredentialStore | undefined): Probe {
    if (credentials === undefined) throw new Error("pi_credential_store_required");
    return async (record) => {
      const source = record.source;
      const provider = createPiSourceProvider(source.activeSourceRevision.kind === "generic-openai"
        ? {
          baseUrl: record.baseUrl ?? "",
          displayName: source.activeSourceRevision.displayName,
          kind: "generic-openai",
          modelId: source.activeModelRevision.modelId,
          sourceId: source.sourceId,
        }
        : {
          kind: source.activeSourceRevision.kind,
          modelId: source.activeModelRevision.modelId,
          sourceId: source.sourceId,
        });
      const models = createModels({
        authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
        credentials,
      });
      models.setProvider(provider);
      const auth = await models.getAuth(provider.id);
      if (auth === undefined) throw new Error("credential missing");
      const model = provider.getModels().find((candidate) => candidate.id === source.activeModelRevision.modelId);
      if (model === undefined) throw new Error("model not found");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      timer.unref();
      try {
        const response = await models.completeSimple(model, {
          messages: [{ content: "Reply with OK.", role: "user", timestamp: Date.now() }],
        }, { maxTokens: 8, signal: controller.signal });
        if (response.stopReason === "error" || !response.content.some((block) => block.type === "text" && block.text.length > 0)) {
          throw new Error("minimal text response failed");
        }
      } finally {
        clearTimeout(timer);
      }
    };
  }
}
