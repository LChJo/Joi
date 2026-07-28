/* Provider resolution implements an asynchronous infrastructure port. */
/* eslint-disable @typescript-eslint/require-await */
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider, type ApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";

import {
  getDirectModelSourcePreset,
  type DirectModelSourceKind,
} from "./provider-presets.js";

interface DirectSourceProviderInput {
  kind: DirectModelSourceKind;
  modelId: string;
  sourceId: string;
}

interface GenericSourceProviderInput {
  baseUrl: string;
  displayName: string;
  kind: "generic-openai";
  modelId: string;
  sourceId: string;
}

export type PiSourceProviderInput = DirectSourceProviderInput | GenericSourceProviderInput;

const noAmbientCredentialAuth = (allowKeyless: boolean): ApiKeyAuth => ({
  name: "joi model source credential",
  resolve: async ({ credential }) => {
    if (credential?.key !== undefined && credential.key.length > 0) {
      return { auth: { apiKey: credential.key }, source: "joi credential store" };
    }
    return allowKeyless ? { auth: {}, source: "keyless local source" } : undefined;
  },
});

function isExplicitLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function createPiSourceProvider(input: PiSourceProviderInput): Provider<"openai-completions"> {
  const providerId = `joi-source:${input.sourceId}`;
  const direct = input.kind === "generic-openai" ? undefined : getDirectModelSourcePreset(input.kind);
  const baseUrl = input.kind === "generic-openai" ? input.baseUrl : direct?.endpoint;
  if (baseUrl === undefined) throw new Error("model_source_endpoint_missing");
  const label = input.kind === "generic-openai" ? input.displayName : direct?.label ?? input.kind;
  const knownModel = direct?.models.find((candidate) => candidate.id === input.modelId);
  const model: Model<"openai-completions"> = {
    api: "openai-completions",
    baseUrl,
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: input.modelId,
    input: ["text"],
    maxTokens: 8_192,
    name: knownModel?.label ?? input.modelId,
    provider: providerId,
    reasoning: false,
  };

  return createProvider({
    api: openAICompletionsApi(),
    auth: { apiKey: noAmbientCredentialAuth(input.kind === "generic-openai" && isExplicitLocalUrl(baseUrl)) },
    baseUrl,
    id: providerId,
    models: [model],
    name: label,
  });
}
