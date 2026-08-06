/* Provider resolution implements an asynchronous infrastructure port. */
/* eslint-disable @typescript-eslint/require-await */
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider, type ApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";

import {
  getDirectModelSourcePreset,
  modelRequiresAlwaysOnThinking,
  type DirectModelSourceKind,
} from "./provider-presets.js";
import type { ModelSourceAccessMode, ModelSourceProtocol } from "../../domain/model-sources/model-source.js";

interface DirectSourceProviderInput {
  accessMode: Exclude<ModelSourceAccessMode, "custom">;
  kind: DirectModelSourceKind;
  modelId: string;
  protocol: ModelSourceProtocol;
  sourceId: string;
}

interface GenericSourceProviderInput {
  baseUrl: string;
  displayName: string;
  kind: "generic-openai";
  modelId: string;
  protocol: ModelSourceProtocol;
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

export function createPiSourceProvider(input: PiSourceProviderInput): Provider {
  const providerId = `joi-source:${input.sourceId}`;
  const direct = input.kind === "generic-openai" ? undefined : getDirectModelSourcePreset(input.kind, input.accessMode, input.protocol);
  const baseUrl = input.kind === "generic-openai" ? input.baseUrl : direct?.endpoint;
  if (baseUrl === undefined) throw new Error("model_source_endpoint_missing");
  const label = input.kind === "generic-openai" ? input.displayName : direct?.label ?? input.kind;
  const knownModel = direct?.models.find((candidate) => candidate.id === input.modelId);
  const headers = input.kind === "kimi" && input.accessMode === "coding-plan" ? { "User-Agent": "KimiCLI/1.5" } : undefined;
  const allowKeyless = input.kind === "generic-openai" && isExplicitLocalUrl(baseUrl);
  if (input.protocol === "anthropic") {
    const kimiCode = input.kind === "kimi" && input.accessMode === "coding-plan";
    const kimiK3 = kimiCode && (input.modelId === "k3" || input.modelId === "k3-256k");
    const model: Model<"anthropic-messages"> = {
      api: "anthropic-messages",
      baseUrl,
      ...(kimiCode ? { compat: {
        ...((input.modelId === "k3" || input.modelId === "kimi-for-coding") ? { allowEmptySignature: true } : {}),
        forceAdaptiveThinking: true,
      } } : {}),
      contextWindow: input.modelId === "k3" ? 1_048_576 : input.kind === "kimi" ? 262_144 : 128_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      ...(headers === undefined ? {} : { headers }),
      id: input.modelId,
      input: kimiCode ? ["text", "image"] : ["text"],
      maxTokens: kimiK3 ? 131_072 : 32_768,
      name: knownModel?.label ?? input.modelId,
      provider: providerId,
      reasoning: true,
      ...(kimiK3 ? { thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } } : {}),
    };
    return createProvider({
      api: anthropicMessagesApi(),
      auth: { apiKey: noAmbientCredentialAuth(allowKeyless) },
      baseUrl,
      ...(headers === undefined ? {} : { headers }),
      id: providerId,
      models: [model],
      name: label,
    });
  }
  const alwaysOn = modelRequiresAlwaysOnThinking(baseUrl);
  const model: Model<"openai-responses"> = {
    api: "openai-responses",
    baseUrl,
    // Conservative gateway defaults: keep the `system` role (developer can be
    // rejected by non-OpenAI gateways) and never emit the OpenAI-only 24h cache retention.
    compat: { supportsDeveloperRole: false, supportsLongCacheRetention: false },
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: input.modelId,
    input: ["text"],
    maxTokens: 8_192,
    name: knownModel?.label ?? input.modelId,
    provider: providerId,
    reasoning: alwaysOn,
    ...(headers === undefined ? {} : { headers }),
  };

  return createProvider({
    api: openAIResponsesApi(),
    auth: { apiKey: noAmbientCredentialAuth(allowKeyless) },
    baseUrl,
    ...(headers === undefined ? {} : { headers }),
    id: providerId,
    models: [model],
    name: label,
  });
}
