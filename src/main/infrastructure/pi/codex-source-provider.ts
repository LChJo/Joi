import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { createProvider, type OpenAICodexResponsesOptions } from "@earendil-works/pi-ai";
import { DomainError } from "../../domain/errors.js";
import { observedContextWindow, observedMaxOutputTokens } from "./pi-model-budget.js";

const codex = openaiCodexProvider();
const DEFAULT_CODEX_MODEL = "gpt-6.1-sol";

const fetchCodex: typeof fetch = async (request, options) => {
  const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
  if (url !== "https://chatgpt.com/backend-api/codex/responses") throw new Error("codex_endpoint_invalid");
  const response = await globalThis.fetch(request, { ...options, redirect: "error" });
  if (response.status !== 401) return response;
  // Pi's Codex stream turns provider responses into text errors. Keep the auth status
  // available to the existing source health classifiers without carrying the response body.
  await response.body?.cancel().catch(() => undefined);
  return new Response("401 Unauthorized", { status: 401 });
};

export interface CodexSourceProviderInput {
  kind: "codex";
  modelId: string;
  sourceId: string;
  credentialRef: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

function codexModel(modelId: string) {
  const model = findCodexModel(modelId);
  if (model === undefined) throw new DomainError("codex_model_unavailable", "Choose a model from the Codex catalog.");
  return model;
}

function findCodexModel(modelId: string) {
  return codex.getModels().find((entry) => entry.id === modelId);
}

export function resolveCodexModelId(modelId?: string): string {
  return codexModel(modelId === "" ? DEFAULT_CODEX_MODEL : modelId ?? DEFAULT_CODEX_MODEL).id;
}

function limitsForModel(model: NonNullable<ReturnType<typeof findCodexModel>>, input: Omit<CodexSourceProviderInput, "kind" | "credentialRef">) {
  return {
    contextWindow: Math.min(observedContextWindow(input.sourceId, model.id) ?? Infinity, input.contextWindow ?? model.contextWindow),
    maxOutputTokens: Math.min(observedMaxOutputTokens(input.sourceId, model.id) ?? Infinity, input.maxOutputTokens ?? model.maxTokens),
  };
}

export function codexModelLimits(input: Omit<CodexSourceProviderInput, "kind" | "credentialRef">) {
  const model = findCodexModel(input.modelId);
  return model === undefined ? undefined : limitsForModel(model, input);
}

export function createCodexSourceProvider(input: CodexSourceProviderInput) {
  const model = codexModel(input.modelId);
  const limits = limitsForModel(model, input);
  const provider = input.credentialRef;
  const api = openAICodexResponsesApi();
  const transport = { transport: "sse", fetch: fetchCodex } satisfies Partial<OpenAICodexResponsesOptions>;
  return createProvider({
    id: provider,
    name: codex.name,
    baseUrl: model.baseUrl,
    auth: codex.auth,
    models: [{
      ...model,
      provider,
      headers: { ...model.headers, originator: "joi" },
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxOutputTokens,
    }],
    api: {
      stream: (model, context, options) => api.stream(model, context, { ...options, ...transport }),
      streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options, ...transport }),
    },
  });
}
