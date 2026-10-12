import { createModels, type Credential, type CredentialStore } from "@earendil-works/pi-ai";

import type { ModelSourceRecord, ModelSourceValidator } from "../../application/ports/model-source-ports.js";
import type { Clock } from "../../application/ports/runtime-store.js";
import { createPiSourceProvider, defaultThinkingLevel, piSourceProviderInput } from "./source-provider-factory.js";
import { modelRequiresAlwaysOnThinking } from "./provider-presets.js";
import { classifyHttp403Detail } from "../../application/partners/partner-run-failure.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import { trackPiModels } from "./pi-usage.js";

type Probe = (record: ModelSourceRecord, signal: AbortSignal) => Promise<void>;

class ProbeResponseError extends Error {
  constructor(readonly reasonCode: "empty_response" | "response_truncated") {
    super(reasonCode === "empty_response" ? "validation response contained no text" : "validation response reached output limit");
  }
}

function failureReason(error: unknown): { error?: string; reasonCode: string; status: "DEGRADED" | "NEEDS_AUTH" } {
  if (error instanceof ProbeResponseError) return { error: error.message, reasonCode: error.reasonCode, status: "DEGRADED" };
  const raw = errorMessage(error);
  const message = raw.toLowerCase();
  const statusCode = numericStatus(error);
  let reasonCode: string;
  let status: "DEGRADED" | "NEEDS_AUTH" = "DEGRADED";
  if (statusCode === 403 || /(^|\D)403(\D|$)|\bforbidden\b/u.test(message)) {
    reasonCode = classifyHttp403Detail(raw);
    status = "NEEDS_AUTH";
  } else if (statusCode === 401 || /(^|\D)401(\D|$)|unauthori[sz]ed|invalid[_ -]?(api[_ -]?key|x-api-key)|\bcredential\b|no api key/u.test(message)) {
    reasonCode = "auth_failed";
    status = "NEEDS_AUTH";
  } else if (/(^|\D)429(\D|$)|rate[_ -]?limit|throttl|overloaded|too many requests/u.test(message)) {
    reasonCode = "rate_limited";
  } else if (/model.+(?:not found|missing|unknown|unavailable)|(?:not found|unknown).+model/u.test(message)) {
    reasonCode = "model_unavailable";
  } else if (/(^|\D)5\d\d(\D|$)|overloaded_error|internal server error|bad gateway|service unavailable|gateway timeout/u.test(message)) {
    reasonCode = "server_error";
  } else if (/(^|\D)404(\D|$)/u.test(message)) {
    reasonCode = "not_found";
  } else if (/(^|\D)400(\D|$)/u.test(message)) {
    reasonCode = "bad_request";
  } else if (/invalid[_ -]?parameter|invalid_request_error/u.test(message)) {
    reasonCode = "bad_request";
  } else if (/\bconnection\b|enotfound|econnrefused|econnreset|cert|self[- ]?signed|unable to verify|\bssl\b|\btls\b|socket hang up|fetch failed|\bnetwork\b/u.test(message)) {
    reasonCode = "connection_error";
  } else if (/timed? ?out|\baborted\b/u.test(message)) {
    reasonCode = "timeout";
  } else if (/(^|\D)\d{3}(\D|$)/u.test(message)) {
    reasonCode = "http_error";
  } else {
    reasonCode = "endpoint_unreachable";
  }
  return { ...(reasonCode === "auth_forbidden" || reasonCode === "model_access_forbidden" || reasonCode === "region_forbidden" || reasonCode === "request_policy_forbidden" || reasonCode === "http_403" ? {} : { error: raw.trim() }), reasonCode, status };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return String(error);
}

function numericStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; statusCode?: unknown; response?: unknown };
  const direct = typeof value.status === "number" ? value.status : value.statusCode;
  if (typeof direct === "number" && Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  if (value.response !== null && typeof value.response === "object") {
    const nested = (value.response as { status?: unknown; statusCode?: unknown });
    const responseStatus = typeof nested.status === "number" ? nested.status : nested.statusCode;
    if (typeof responseStatus === "number" && Number.isInteger(responseStatus) && responseStatus >= 100 && responseStatus <= 599) return responseStatus;
  }
  return undefined;
}

export class PiModelSourceValidator implements ModelSourceValidator {
  readonly #clock: Clock;
  readonly #probe: Probe;

  constructor(input: { clock: Clock; credentials?: CredentialStore; probe?: Probe; usage?: UsageRecorder }) {
    this.#clock = input.clock;
    this.#probe = input.probe ?? this.#createProbe(input.credentials, input.usage);
  }

  async validate(record: ModelSourceRecord): ReturnType<ModelSourceValidator["validate"]> {
    const validatedAt = this.#clock.now().toISOString();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const model = createPiSourceProvider(piSourceProviderInput(record)).getModels()[0];
      const thinks = defaultThinkingLevel(record.source.activeModelRevision.thinkingEffort, model?.baseUrl) !== "off"
        || modelRequiresAlwaysOnThinking(model?.baseUrl);
      timer = setTimeout(() => controller.abort(), thinks ? 30_000 : 15_000);
      timer.unref();
      await this.#probe(record, controller.signal);
      return { status: "READY" as const, validatedAt };
    } catch (error) {
      const revision = record.source.activeSourceRevision;
      // Both auth probes carry the same fixed no-tool message and share one deadline.
      const status = numericStatus(error);
      const unauthorized = status === 401 || (status === undefined && /^401\b/u.test(errorMessage(error).trim()));
      if (revision.kind === "generic-openai" && revision.protocol === "anthropic"
        && record.anthropicAuthMode !== "bearer" && unauthorized && !controller.signal.aborted) {
        try {
          await this.#probe({ ...record, anthropicAuthMode: "bearer" }, controller.signal);
          return { anthropicAuthMode: "bearer" as const, status: "READY" as const, validatedAt };
        } catch {
          // An unproven alternative leaves the original auth failure authoritative.
        }
      }
      return { ...failureReason(error), validatedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  #createProbe(credentials: CredentialStore | undefined, usage: UsageRecorder | undefined): Probe {
    if (credentials === undefined) throw new Error("pi_credential_store_required");
    const snapshots = new WeakMap<AbortSignal, Promise<Credential | undefined>>();
    return async (record, signal) => {
      const source = record.source;
      // Probe with the same limits and thinking effort the real turns will use. Sizing the probe
      // from the preset while the turns use the configured value would hide exactly the mistake —
      // a window or completion cap the route rejects, or a thinking tier the gateway refuses —
      // that validating is meant to surface.
      const provider = createPiSourceProvider(piSourceProviderInput(record));
      // Alternative auth must use the exact credential that received the original rejection.
      const snapshot = snapshots.get(signal) ?? credentials.read(provider.id);
      snapshots.set(signal, snapshot);
      const models = createModels({
        authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
        credentials: {
          read: (id) => id === provider.id ? snapshot : Promise.resolve(undefined),
          list: () => credentials.list(),
          modify: (id, fn) => credentials.modify(id, fn),
          delete: (id) => credentials.delete(id),
        },
      });
      models.setProvider(provider);
      const auth = await models.getAuth(provider.id);
      if (auth === undefined) throw new Error("credential missing");
      const model = provider.getModels().find((candidate) => candidate.id === source.activeModelRevision.modelId);
      if (model === undefined) throw new Error("model not found");
      const thinkingLevel = defaultThinkingLevel(source.activeModelRevision.thinkingEffort, model.baseUrl);
      const thinks = thinkingLevel !== "off" || modelRequiresAlwaysOnThinking(model.baseUrl);
      // DeepSeek defaults to thinking even when Pi's model metadata says false.
      // For this no-tool probe only, let Pi emit reasoning.effort=none; otherwise
      // thinking can exhaust the tiny output budget before any visible answer.
      const probeModel = model.api === "openai-responses" && new URL(model.baseUrl).hostname === "api.deepseek.com"
        ? { ...model, reasoning: true } : model;
      const timestamp = Date.now();
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await trackPiModels(models, usage, () => ({ engine: "pi", purpose: "probe", sourceId: source.sourceId, sourceName: source.activeSourceRevision.displayName, modelId: source.activeModelRevision.modelId })).completeSimple(probeModel, {
          messages: [{ content: "Reply with OK.", role: "user", timestamp }],
        }, {
          maxTokens: attempt === 0 ? (thinks ? 256 : 64) : 1024,
          signal,
          ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
        });
        if (signal.aborted || response.stopReason === "aborted") {
          throw new Error("validation probe timed out");
        }
        if (response.stopReason === "error") {
          throw new Error(response.errorMessage ?? "minimal text response failed");
        }
        // This is a connectivity probe, so partial visible text is sufficient.
        if (response.content.some((block) => block.type === "text" && block.text.trim().length > 0)) return;
        const truncated = response.stopReason === "length";
        const hasThinking = response.content.some((block) => block.type === "thinking" && block.thinking.trim().length > 0);
        if (attempt === 1 || (!truncated && !hasThinking)) {
          throw new ProbeResponseError(truncated ? "response_truncated" : "empty_response");
        }
        // Retry only this fixed, no-tool request, under the same deadline.
      }
    };
  }
}
