import { createModels, type CredentialStore } from "@earendil-works/pi-ai";

import type { ModelSourceRecord, ModelSourceValidator } from "../../application/ports/model-source-ports.js";
import type { Clock } from "../../application/ports/runtime-store.js";
import { createPiSourceProvider } from "./source-provider-factory.js";
import { modelRequiresAlwaysOnThinking } from "./provider-presets.js";
import { classifyHttp403Detail } from "../../application/partners/partner-run-failure.js";

type Probe = (record: ModelSourceRecord) => Promise<void>;

function failureReason(error: unknown): { error?: string; reasonCode: string; status: "DEGRADED" | "NEEDS_AUTH" } {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.toLowerCase();
  let reasonCode: string;
  let status: "DEGRADED" | "NEEDS_AUTH" = "DEGRADED";
  if (/(^|\D)403(\D|$)|\bforbidden\b/u.test(message)) {
    reasonCode = classifyHttp403Detail(raw);
    status = "NEEDS_AUTH";
  } else if (/(^|\D)401(\D|$)|unauthori[sz]ed|invalid[_ -]?(api[_ -]?key|x-api-key)|\bcredential\b|no api key/u.test(message)) {
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
          protocol: source.activeSourceRevision.protocol,
          sourceId: source.sourceId,
        }
        : {
          accessMode: source.activeSourceRevision.accessMode === "token-plan" ? "token-plan" as const
            : source.activeSourceRevision.accessMode === "coding-plan" ? "coding-plan" as const : "api" as const,
          kind: source.activeSourceRevision.kind,
          modelId: source.activeModelRevision.modelId,
          protocol: source.activeSourceRevision.protocol,
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
      const alwaysOn = modelRequiresAlwaysOnThinking(model.baseUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), alwaysOn ? 30_000 : 15_000);
      timer.unref();
      try {
        const response = await models.completeSimple(model, {
          messages: [{ content: "Reply with OK.", role: "user", timestamp: Date.now() }],
        }, { maxTokens: alwaysOn ? 256 : 8, signal: controller.signal, ...(alwaysOn ? { reasoning: "low" as const } : {}) });
        if (response.stopReason === "error") {
          throw new Error(response.errorMessage ?? "minimal text response failed");
        }
        if (controller.signal.aborted || response.stopReason === "aborted") {
          throw new Error("validation probe timed out");
        }
        if (!response.content.some((block) => block.type === "text" && block.text.length > 0)) {
          throw new Error("minimal text response failed");
        }
      } finally {
        clearTimeout(timer);
      }
    };
  }
}
