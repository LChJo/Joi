import { randomUUID } from "node:crypto";
import { createProvider, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { DEFAULT_ANTIGRAVITY_MODEL } from "../../../shared/antigravity-models.js";
import { observedContextWindow, observedMaxOutputTokens } from "./pi-model-budget.js";
import { antigravityOAuth } from "./pi-antigravity-authorization.js";
import { ANTIGRAVITY_ENDPOINT, antigravityHeaders, requestAntigravity, safeAntigravityHttpError } from "./antigravity-http.js";

// Known limits and legacy routing follow the provider documentation and pi-antigravity 0.15.0.
// The list is metadata, not an availability gate.
const KNOWN_LIMITS: readonly { id: string; contextWindow?: number; maxTokens?: number }[] = [
  // The provider documents Neon's 512K window but no output cap; 65_536 is the same ceiling the
  // documented Gemini family carries, and a server rejection still tightens it through observation.
  { id: DEFAULT_ANTIGRAVITY_MODEL, contextWindow: 524_288, maxTokens: 65_536 },
  { id: "gemini-3.8-flash", contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.7-flash", contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.6-flash", contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.5-flash", contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.1-pro", contextWindow: 1_048_576, maxTokens: 65_535 },
  { id: "claude-sonnet-4-6", contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-opus-4-6", contextWindow: 250_000, maxTokens: 64_000 },
  { id: "gpt-oss-120b", contextWindow: 131_072, maxTokens: 32_768 },
];

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

export interface AntigravitySourceProviderInput {
  kind: "antigravity";
  modelId: string;
  sourceId: string;
  credentialRef: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  thinkingEffort?: ModelThinkingLevel;
}

export function resolveAntigravityModelId(modelId?: string): string {
  const id = modelId?.trim();
  return id === undefined || id === "" ? DEFAULT_ANTIGRAVITY_MODEL : id;
}

/** The flagship default thinks at the provider-managed dynamic budget; other models stay conservative. */
export function antigravityDefaultThinkingEffort(modelId: string): ModelThinkingLevel {
  return modelId === DEFAULT_ANTIGRAVITY_MODEL ? "high" : "low";
}

/** Neon's reserve must cover its 64K output cap so compaction starts before the window can starve a reply. */
export function antigravityDefaultCompactionPercent(modelId: string): number | undefined {
  return modelId === DEFAULT_ANTIGRAVITY_MODEL ? 85 : undefined;
}

export function antigravityModelLimits(input: Pick<AntigravitySourceProviderInput, "modelId" | "sourceId" | "contextWindow" | "maxOutputTokens">) {
  const id = resolveAntigravityModelId(input.modelId);
  const model = KNOWN_LIMITS.find((model) => model.id === id);
  return {
    contextWindow: Math.min(input.contextWindow ?? model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      model?.contextWindow ?? Infinity, observedContextWindow(input.sourceId, id) ?? Infinity),
    maxOutputTokens: Math.min(input.maxOutputTokens ?? model?.maxTokens ?? DEFAULT_MAX_TOKENS,
      model?.maxTokens ?? Infinity, observedMaxOutputTokens(input.sourceId, id) ?? Infinity),
  };
}

function routing(id: string, effort: ModelThinkingLevel) {
  const high = effort === "high" || effort === "xhigh" || effort === "max";
  const off = effort === "off";
  if (id === "claude-opus-4-6" || id === "claude-sonnet-4-6") return { model: id === "claude-opus-4-6" ? `${id}-thinking` : id, budget: off ? 0 : 1024 };
  if (id === "gpt-oss-120b") return { model: `${id}-medium`, budget: off ? 0 : 8192 };
  if (id === "gemini-3.1-pro") return { model: high ? "gemini-pro-agent" : `${id}-low`, budget: off ? 0 : high ? 10_001 : 1_001 };
  if (id === "gemini-3.5-flash") return {
    model: high ? "gemini-3-flash-agent" : effort === "medium" ? `${id}-low` : `${id}-extra-low`,
    budget: off ? 0 : high ? 10_000 : effort === "medium" ? 4_000 : 1_000,
  };
  const budget = off ? 0 : high ? -1 : effort === "medium" ? 4_000 : 1_000;
  const level = high ? "high" : effort === "medium" ? "medium" : "low";
  // The provider documents Neon and Hydrogen with an extra (xhigh) tier; Carbon and Argon carry
  // low/medium/high only. Argon stays routable for compatibility but is not a recommended model.
  if (id === "gemini-4-neon" || id === "gemini-4-hydrogen") {
    return { model: `${id}-${effort === "xhigh" || effort === "max" ? "xhigh" : level}`, budget };
  }
  if (["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"].includes(id)) {
    return { model: `${id}-${level}`, budget };
  }
  return { model: id, budget };
}

type Wire = Record<string, unknown>;
function legacySchema(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const schema = value as Wire;
  const result: Wire = {};
  for (const key of ["type", "description", "required", "enum", "items", "properties"]) {
    const item = schema[key];
    if (item === undefined) continue;
    if (key === "properties" && item !== null && typeof item === "object") {
      result[key] = Object.fromEntries(Object.entries(item).map(([name, child]) => [name, legacySchema(child)]));
    } else if (key === "items") result[key] = legacySchema(item);
    else if (key === "type" && Array.isArray(item)) result[key] = item.find((entry) => entry !== "null");
    else if (key !== "enum" || !Array.isArray(item) || item.every((entry) => typeof entry === "string")) result[key] = item;
  }
  return result;
}

function antigravityFetch(id: string, effort: ModelThinkingLevel, sessionId: string, maxOutputTokens: number): typeof fetch {
  return async (input, init) => {
    const outgoing = input instanceof Request ? input : new Request(input, init);
    const url = new URL(outgoing.url);
    if (url.origin !== ANTIGRAVITY_ENDPOINT || !url.pathname.endsWith(":streamGenerateContent")) throw new Error("antigravity_endpoint_invalid");
    const key = new Headers(init?.headers ?? outgoing.headers).get("x-goog-api-key");
    if (key === null) throw new Error("401 OAuth credential missing");
    const credential = JSON.parse(key) as { token: string; projectId: string };
    const request = JSON.parse(typeof init?.body === "string" ? init.body : await outgoing.text()) as Wire;
    const route = routing(id, effort);
    const generationConfig = request.generationConfig as Wire | undefined;
    const requestedOutput = generationConfig?.maxOutputTokens;
    request.generationConfig = { ...generationConfig,
      maxOutputTokens: Math.min(maxOutputTokens, typeof requestedOutput === "number" ? requestedOutput : maxOutputTokens),
      thinkingConfig: { includeThoughts: effort !== "off", thinkingBudget: route.budget } };
    // Consumer endpoints impose a short systemInstruction limit. Keep complete instructions in contents.
    const system = request.systemInstruction as { parts?: { text?: string }[] } | undefined;
    if (system !== undefined) {
      const contents = request.contents as { role: string; parts: unknown[] }[];
      const parts = system.parts ?? [];
      if (contents[0]?.role === "user") contents[0].parts.unshift(...parts);
      else contents.unshift({ role: "user", parts });
      delete request.systemInstruction;
    }
    // Schema conversion is a transport-family concern: every claude-/gpt-oss- route needs the
    // legacy shape, including custom IDs whose routing suffix is left untouched.
    if (id.startsWith("claude-") || id.startsWith("gpt-oss-")) {
      const tools = request.tools as { functionDeclarations?: Wire[] }[] | undefined;
      for (const tool of tools ?? []) for (const declaration of tool.functionDeclarations ?? []) {
        declaration.parameters = legacySchema(declaration.parametersJsonSchema ?? declaration.parameters);
        delete declaration.parametersJsonSchema;
      }
    }
    request.sessionId = sessionId;
    const trajectory = randomUUID();
    const response = await requestAntigravity("/v1internal:streamGenerateContent?alt=sse", {
      method: "POST", redirect: "error", signal: init?.signal ?? outgoing.signal,
      headers: { ...antigravityHeaders(), authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({ project: credential.projectId, model: route.model, request,
        requestType: "agent", userAgent: "antigravity", requestId: `agent/${sessionId}/${String(Date.now())}/${trajectory}/1` }),
    });
    if (!response.ok) {
      const message = await safeAntigravityHttpError(response);
      return Response.json({ error: { code: response.status, message } }, { status: response.status });
    }
    if (response.body === null) throw new Error("Antigravity stream missing");
    let pending = "";
    const unwrap = (line: string) => {
      if (!line.startsWith("data:")) return line + "\n";
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") return "";
      let parsed: unknown;
      try { parsed = JSON.parse(data) as unknown; } catch { throw new Error("Antigravity stream protocol error"); }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Antigravity stream protocol error");
      const chunk = parsed as Wire;
      if (chunk.error) throw new Error("Antigravity stream protocol error");
      return `data: ${JSON.stringify(chunk.response ?? chunk)}\n`;
    };
    return new Response(response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
      transform(chunk, controller) {
        pending += chunk;
        if (pending.length > 5_000_000) throw new Error("Antigravity stream frame too large");
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) {
          controller.enqueue(unwrap(pending.slice(0, end).replace(/\r$/u, "")));
          pending = pending.slice(end + 1);
        }
      },
      flush(controller) { if (pending.trim()) controller.enqueue(unwrap(pending) + "\n"); },
    })).pipeThrough(new TextEncoderStream()), { headers: { "content-type": "text/event-stream" } });
  };
}

export function createAntigravitySourceProvider(input: AntigravitySourceProviderInput) {
  const id = resolveAntigravityModelId(input.modelId);
  const limits = antigravityModelLimits(input);
  const model: Model<"google-generative-ai"> = {
    id, api: "google-generative-ai", provider: input.credentialRef, name: id, baseUrl: ANTIGRAVITY_ENDPOINT,
    contextWindow: limits.contextWindow, maxTokens: limits.maxOutputTokens,
    reasoning: true, input: id.startsWith("gpt-oss-") ? ["text"] : ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const api = googleGenerativeAIApi();
  const sessionId = randomUUID();
  return createProvider({ id: input.credentialRef, name: "Antigravity", baseUrl: ANTIGRAVITY_ENDPOINT,
    models: [model], auth: { oauth: antigravityOAuth }, api: {
      stream: (model, context, options) => api.stream(model, context, { ...options,
        fetch: antigravityFetch(id, input.thinkingEffort ?? antigravityDefaultThinkingEffort(id), options?.sessionId ?? sessionId, limits.maxOutputTokens) }),
      streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options,
        fetch: antigravityFetch(id, options?.reasoning ?? input.thinkingEffort ?? antigravityDefaultThinkingEffort(id), options?.sessionId ?? sessionId, limits.maxOutputTokens) }),
    },
  });
}
