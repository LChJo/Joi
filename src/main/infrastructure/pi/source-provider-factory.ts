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
import { observedContextWindow } from "./pi-model-budget.js";

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

// pi-ai 只在 model.input 含 "image" 时保留多模态图片块；否则 transform-messages
// 的 downgradeUnsupportedImages 会把图片替换成 "(image omitted: model does not
// support images)" 占位符，模型随即告知用户无法看图。按源类型声明视觉输入能力：
// - generic-openai 网关把请求转发到所选模型（含视觉模型），按支持图片处理；
// - kimi coding-plan 的 anthropic 端点已实测接受图片；
// 其余直连源（glm/qwen/doubao/minimax/deepseek 的 api/token-plan 等）暂无视觉
// 实测证据，保持纯文本声明。加条目即放开。
const IMAGE_INPUT_SOURCES: ReadonlySet<string> = new Set([
  "generic-openai",
  "kimi:coding-plan",
]);

function supportsImageInput(input: PiSourceProviderInput): boolean {
  return IMAGE_INPUT_SOURCES.has(input.kind === "generic-openai" ? "generic-openai" : `${input.kind}:${input.accessMode}`);
}

/**
 * Fallbacks for a route whose provider has not yet stated its real limit. They are deliberately
 * conservative: an over-estimated window is what lets a request exceed the route and come back as a
 * clamped max_tokens, while an under-estimated one only trims a little earlier. `observedContextWindow`
 * takes precedence the moment a provider tells us the truth.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
/**
 * OpenAI-compatible gateways cap completions well below the direct APIs; the old 8,192 ceiling was
 * reached long before the window was, so a route with room to spare still answered short.
 */
const GATEWAY_MAX_OUTPUT_TOKENS = 16_384;

function contextWindowFor(input: PiSourceProviderInput, presetWindow: number): number {
  return observedContextWindow(input.sourceId, input.modelId) ?? presetWindow;
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
      contextWindow: contextWindowFor(input, input.modelId === "k3" ? 1_048_576 : input.kind === "kimi" ? 262_144 : DEFAULT_CONTEXT_WINDOW),
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      ...(headers === undefined ? {} : { headers }),
      id: input.modelId,
      input: supportsImageInput(input) ? ["text", "image"] : ["text"],
      maxTokens: kimiK3 ? 131_072 : DEFAULT_MAX_OUTPUT_TOKENS,
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
    contextWindow: contextWindowFor(input, DEFAULT_CONTEXT_WINDOW),
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: input.modelId,
    input: supportsImageInput(input) ? ["text", "image"] : ["text"],
    maxTokens: GATEWAY_MAX_OUTPUT_TOKENS,
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
