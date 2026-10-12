/* Provider resolution implements an asynchronous infrastructure port. */
/* eslint-disable @typescript-eslint/require-await */
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider, type ApiKeyAuth, type Model, type ModelThinkingLevel, type Provider } from "@earendil-works/pi-ai";

import type { ModelSourceRecord } from "../../application/ports/model-source-ports.js";
import {
  getDirectModelSourcePreset,
  modelRequiresAlwaysOnThinking,
  type DirectModelSourceKind,
  type ModelPresetEntry,
} from "./provider-presets.js";
import type { ModelSourceAccessMode, ModelSourceProtocol } from "../../domain/model-sources/model-source.js";
import type { ThinkingEffort } from "../../../shared/joi.js";
import { observedContextWindow, observedMaxOutputTokens } from "./pi-model-budget.js";

/** A model's own documented geometry, as configured on the settings page. */
export interface ModelLimitOverrides {
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Picks the configured limits off a model revision, ready to spread into a provider input. */
export function modelLimitOverrides(revision: { contextWindow?: number; maxOutputTokens?: number }): ModelLimitOverrides {
  return {
    ...(revision.contextWindow === undefined ? {} : { contextWindow: revision.contextWindow }),
    ...(revision.maxOutputTokens === undefined ? {} : { maxOutputTokens: revision.maxOutputTokens }),
  };
}

/** The thinking level a route will run at: the user's explicit choice, else joi's endpoint
 *  allowlist (a few hosts only accept requests that carry thinking, so they get "low"). */
export function defaultThinkingLevel(effort: ThinkingEffort | undefined, baseUrl: string | undefined): ModelThinkingLevel {
  return effort ?? (modelRequiresAlwaysOnThinking(baseUrl) ? "low" : "off");
}

/** Assembles the provider input a real turn would use, limits and thinking effort included.
 *  The validation probe shares this path so that what "验证" tests is what turns run. */
export function piSourceProviderInput(record: ModelSourceRecord): PiSourceProviderInput {
  const source = record.source;
  const overrides = {
    ...(record.anthropicAuthMode === undefined ? {} : { anthropicAuthMode: record.anthropicAuthMode }),
    ...modelLimitOverrides(source.activeModelRevision),
    ...(source.activeModelRevision.thinkingEffort === undefined ? {} : { thinkingEffort: source.activeModelRevision.thinkingEffort }),
  };
  return source.activeSourceRevision.kind === "generic-openai"
    ? {
      ...overrides,
      baseUrl: record.baseUrl ?? "",
      displayName: source.activeSourceRevision.displayName,
      kind: "generic-openai",
      modelId: source.activeModelRevision.modelId,
      protocol: source.activeSourceRevision.protocol,
      sourceId: source.sourceId,
    }
    : {
      ...overrides,
      accessMode: source.activeSourceRevision.accessMode === "token-plan" ? "token-plan" as const
        : source.activeSourceRevision.accessMode === "coding-plan" ? "coding-plan" as const : "api" as const,
      kind: source.activeSourceRevision.kind,
      modelId: source.activeModelRevision.modelId,
      protocol: source.activeSourceRevision.protocol,
      sourceId: source.sourceId,
    };
}

interface DirectSourceProviderInput extends ModelLimitOverrides {
  accessMode: Exclude<ModelSourceAccessMode, "custom">;
  kind: DirectModelSourceKind;
  modelId: string;
  protocol: ModelSourceProtocol;
  sourceId: string;
  thinkingEffort?: ThinkingEffort;
}

interface GenericSourceProviderInput extends ModelLimitOverrides {
  baseUrl: string;
  displayName: string;
  kind: "generic-openai";
  modelId: string;
  protocol: ModelSourceProtocol;
  sourceId: string;
  thinkingEffort?: ThinkingEffort;
}

export type PiSourceProviderInput = (DirectSourceProviderInput | GenericSourceProviderInput) & { anthropicAuthMode?: "bearer" };

/** The tiers Kimi's coding-plan K3 endpoint is known to offer. `null` marks one joi believes it
 *  refuses, which for "off" also keeps pi-ai from sending a `thinking: disabled` block the
 *  endpoint would reject. A user-picked tier is layered on top of this, never replaced by it. */
const KIMI_K3_THINKING_LEVELS = {
  off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
} as const;

const noAmbientCredentialAuth = (allowKeyless: boolean, bearer = false): ApiKeyAuth => ({
  name: "joi model source credential",
  resolve: async ({ credential }) => {
    if (credential?.key !== undefined && credential.key.length > 0) {
      return {
        auth: bearer ? { headers: { Authorization: `Bearer ${credential.key}` } } : { apiKey: credential.key },
        source: "joi credential store",
      };
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
/**
 * An output cap is a property of the model, not of its window: a route with a 128k window may still
 * allow only 8k of completion, and exceeding the cap is a hard provider rejection that fails the
 * whole Work rather than merely shortening an answer. `clampMaxTokensToContext` cannot protect this
 * — it only enforces window minus input. So the ceiling is set per how well the route is known.
 *
 * A direct vendor is known: joi already drives these same models at 32,768 over their anthropic
 * endpoints with no rejections, so the OpenAI-compatible route to the same vendor matches it. A
 * generic gateway forwards to a model joi cannot know, so it keeps a conservative ceiling.
 */
const DIRECT_MAX_OUTPUT_TOKENS = 32_768;
const GATEWAY_MAX_OUTPUT_TOKENS = 16_384;

/** The window the vendor documents for this exact model, else the kind's default. */
function presetWindowFor(input: PiSourceProviderInput, preset: ModelPresetEntry | undefined): number {
  if (preset?.contextWindow !== undefined) return preset.contextWindow;
  if (input.protocol !== "anthropic") return DEFAULT_CONTEXT_WINDOW;
  if (input.modelId === "k3") return 1_048_576;
  return input.kind === "kimi" ? 262_144 : DEFAULT_CONTEXT_WINDOW;
}

/** The completion cap the vendor documents, else the kind's fallback. */
function presetOutputFor(input: PiSourceProviderInput, preset: ModelPresetEntry | undefined, kimiK3: boolean): number {
  if (kimiK3) return 131_072;
  if (preset?.maxOutputTokens !== undefined) return preset.maxOutputTokens;
  return input.kind === "generic-openai" ? GATEWAY_MAX_OUTPUT_TOKENS : DIRECT_MAX_OUTPUT_TOKENS;
}

/**
 * Sizes a route against one ceiling assembled from three sources, weakest first: what the preset
 * claims (an unverified hand-written guess), what the user configured (intent), and what the
 * provider itself said when it refused an oversized request (fact). The smallest wins.
 *
 * The provider's own figure has to stay on top. If a configured value could exceed it, a route
 * that once rejected an oversized request would keep sending that same request verbatim — the
 * learned limit would never take effect — and `allowLearnedCapacityRetry` would be retrying a
 * request already known to fail.
 */
export function effectiveModelLimits(
  input: PiSourceProviderInput,
  preset: ModelPresetEntry | undefined,
  kimiK3 = false,
): { contextWindow: number; maxOutputTokens: number } {
  const observedWindow = observedContextWindow(input.sourceId, input.modelId);
  const observedOutput = observedMaxOutputTokens(input.sourceId, input.modelId);
  return {
    contextWindow: Math.min(
      observedWindow ?? Number.POSITIVE_INFINITY,
      input.contextWindow ?? presetWindowFor(input, preset),
    ),
    maxOutputTokens: Math.min(
      observedOutput ?? Number.POSITIVE_INFINITY,
      input.maxOutputTokens ?? presetOutputFor(input, preset, kimiK3),
    ),
  };
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
  // The tier the user actually asked for, or undefined when they left it to joi's allowlist
  // ("默认") or explicitly chose "关闭" — both mean "send no effort of our own". Both wires need
  // this same value: on anthropic it decides whether to opt into the adaptive path, on responses
  // whether to switch `reasoning` on, and either way the tier has to be declared to pi-ai.
  const effort = input.thinkingEffort !== undefined && input.thinkingEffort !== "off" ? input.thinkingEffort : undefined;
  if (input.protocol === "anthropic") {
    const kimiCode = input.kind === "kimi" && input.accessMode === "coding-plan";
    const kimiK3 = kimiCode && (input.modelId === "k3" || input.modelId === "k3-256k");
    const limits = effectiveModelLimits(input, knownModel, kimiK3);
    // pi-ai only sends an effort string on the adaptive-thinking path (`output_config.effort`);
    // without it a chosen level degrades to budget_tokens, which always-thinking gateways
    // reject. Kimi's coding-plan endpoint and any user-configured effort opt into it.
    const userEffort = effort !== undefined;
    const model: Model<"anthropic-messages"> = {
      api: "anthropic-messages",
      baseUrl,
      ...(kimiCode || userEffort ? { compat: {
        ...(kimiCode && (input.modelId === "k3" || input.modelId === "kimi-for-coding") ? { allowEmptySignature: true } : {}),
        forceAdaptiveThinking: true,
      } } : {}),
      contextWindow: limits.contextWindow,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      ...(headers === undefined ? {} : { headers }),
      id: input.modelId,
      input: supportsImageInput(input) ? ["text", "image"] : ["text"],
      maxTokens: limits.maxOutputTokens,
      name: knownModel?.label ?? input.modelId,
      provider: providerId,
      reasoning: true,
      // The map passes the chosen tier through verbatim; without an entry pi-ai folds
      // "xhigh"/"max" down to "high". K3 layers the chosen tier *on top of* its own table rather
      // than losing to it: pi-ai sends a map entry only when it is a string and otherwise falls
      // back to a switch that folds everything past "high" down to "high", so letting K3's table
      // win outright would silently send the user's "极高" as "high" — the responses wire's bug,
      // reached through the map instead of the clamp. The table's own nulls still stand for the
      // tiers the user did not pick, so nothing accidental goes out.
      ...(kimiK3
        ? { thinkingLevelMap: effort === undefined ? KIMI_K3_THINKING_LEVELS : { ...KIMI_K3_THINKING_LEVELS, [effort]: effort } }
        : userEffort ? { thinkingLevelMap: { [effort]: effort } } : {}),
    };
    return createProvider({
      api: anthropicMessagesApi(),
      auth: { apiKey: noAmbientCredentialAuth(allowKeyless, input.anthropicAuthMode === "bearer") },
      baseUrl,
      ...(headers === undefined ? {} : { headers }),
      id: providerId,
      models: [model],
      name: label,
    });
  }
  const alwaysOn = modelRequiresAlwaysOnThinking(baseUrl);
  const limits = effectiveModelLimits(input, knownModel);
  // The effort string does pass through as reasoning.effort, but the tier still has to be
  // *declared* first: pi-ai counts "xhigh" and "max" as unavailable unless thinkingLevelMap
  // names them, and openai-responses clamps the request with clampThinkingLevel before the body
  // is built — so an undeclared "max" goes out as "high" with nothing to show for the choice.
  // One entry is all it takes: it is the tier every request on this route runs at.
  const model: Model<"openai-responses"> = {
    api: "openai-responses",
    baseUrl,
    // Conservative gateway defaults: keep the `system` role (developer can be
    // rejected by non-OpenAI gateways) and never emit the OpenAI-only 24h cache retention.
    compat: { supportsDeveloperRole: false, supportsLongCacheRetention: false },
    contextWindow: limits.contextWindow,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: input.modelId,
    input: supportsImageInput(input) ? ["text", "image"] : ["text"],
    maxTokens: limits.maxOutputTokens,
    name: knownModel?.label ?? input.modelId,
    provider: providerId,
    reasoning: alwaysOn || effort !== undefined,
    ...(effort === undefined ? {} : { thinkingLevelMap: { [effort]: effort } }),
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
