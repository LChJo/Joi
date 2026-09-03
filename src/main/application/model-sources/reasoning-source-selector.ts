import { DomainError } from "../../domain/errors.js";
import { classifySourceFailure, pinModelSourceForTurn, type SourceFailureKind } from "../../domain/model-sources/model-source.js";
import type { ModelSourceRecord, ModelSourceRepository } from "../ports/model-source-ports.js";
import type { ModelSourceValidator } from "../ports/model-source-ports.js";
import type { Clock } from "../ports/runtime-store.js";
import { classifyHttp403Detail } from "../partners/partner-run-failure.js";

type SourcePin = ReturnType<typeof pinModelSourceForTurn>;

export class ReasoningSourceSelector {
  readonly #probes = new Map<string, Promise<ModelSourceRecord>>();

  constructor(
    private readonly repository: Pick<ModelSourceRepository, "get" | "list" | "save"> | Pick<ModelSourceRepository, "list">,
    private readonly options?: { clock: Pick<Clock, "now">; freshnessMillis?: number; validator: ModelSourceValidator },
  ) {}

  async selectInitial(turnId: string): Promise<SourcePin> {
    for (const candidate of await this.#readySources()) {
      const source = await this.#fresh(candidate);
      if (source?.source.status === "READY") return pinModelSourceForTurn(source.source, turnId);
    }
    throw new DomainError("model_source_not_ready", "No model source is ready.");
  }

  async selectById(sourceId: string, turnId: string): Promise<SourcePin> {
    const candidate = (await this.#readySources()).find((record) => record.source.sourceId === sourceId);
    const record = candidate === undefined ? undefined : await this.#fresh(candidate);
    if (record === undefined) {
      throw new DomainError("partner_model_source_not_ready", "The partner model source is not ready.");
    }
    if (record.source.status !== "READY") {
      const suffix = record.reasonCode === undefined ? "not_ready" : safeReasonSuffix(record.reasonCode);
      throw new DomainError(`partner_model_source_${suffix}`, "The pinned partner model source requires authorization or model configuration.");
    }
    return pinModelSourceForTurn(record.source, turnId);
  }

  /** Removes a failed auth route from dispatch immediately, then runs one coalesced no-tool diagnostic probe. */
  async reportRunFailure(sourceId: string, error: unknown): Promise<void> {
    if (this.options === undefined || !("get" in this.repository) || !("save" in this.repository)) return;
    const status = numericStatus(error);
    if (status !== 401 && status !== 403) return;
    const current = await this.repository.get(sourceId);
    if (current === null) return;
    const detail = error !== null && typeof error === "object" && typeof (error as { detail?: unknown }).detail === "string"
      ? (error as { detail: string }).detail
      : "";
    const reasonCode = status === 401 ? "auth_failed" : classifyHttp403Detail(detail);
    const now = this.options.clock.now().toISOString();
    await this.repository.save({
      ...withoutHealthText(current),
      lastValidatedAt: now,
      reasonCode,
      source: { ...current.source, status: "NEEDS_AUTH", updatedAt: now },
    });
    await this.#probe(current, true);
  }

  async selectFallback(input: {
    currentSourceId: string;
    failure: SourceFailureKind;
    formalOutputStarted: boolean;
    sideEffectStarted: boolean;
    turnId: string;
  }): Promise<SourcePin | null> {
    if (input.formalOutputStarted || input.sideEffectStarted || !classifySourceFailure(input.failure).fallbackAllowed) return null;
    const sources = await this.#readySources();
    const currentIndex = sources.findIndex((record) => record.source.sourceId === input.currentSourceId);
    const fallback = currentIndex < 0 ? undefined : sources[currentIndex + 1];
    return fallback === undefined ? null : pinModelSourceForTurn(fallback.source, input.turnId);
  }

  async #readySources(): Promise<ModelSourceRecord[]> {
    return (await this.repository.list())
      .filter((record) => record.source.status === "READY")
      .sort((left, right) => left.order - right.order);
  }

  async #fresh(record: ModelSourceRecord): Promise<ModelSourceRecord | undefined> {
    if (this.options === undefined) return record;
    const validatedAt = record.lastValidatedAt === undefined ? Number.NaN : Date.parse(record.lastValidatedAt);
    const age = this.options.clock.now().getTime() - validatedAt;
    if (Number.isFinite(age) && age >= 0 && age <= (this.options.freshnessMillis ?? 5 * 60_000)) return record;
    return this.#probe(record, false);
  }

  async #probe(record: ModelSourceRecord, force: boolean): Promise<ModelSourceRecord> {
    if (this.options === undefined || !("save" in this.repository)) return record;
    const options = this.options;
    const repository = this.repository;
    const source = record.source;
    const key = [source.sourceId, source.activeSourceRevision.sourceRevisionId, source.activeModelRevision.modelRevisionId, String(source.activeSourceRevision.credentialVersion)].join(":");
    const existing = this.#probes.get(key);
    if (existing !== undefined) return existing;
    const probe = (async () => {
      if (!force) {
        const validatedAt = record.lastValidatedAt === undefined ? Number.NaN : Date.parse(record.lastValidatedAt);
        const age = options.clock.now().getTime() - validatedAt;
        if (Number.isFinite(age) && age >= 0 && age <= (options.freshnessMillis ?? 5 * 60_000)) return record;
      }
      const result = await options.validator.validate(record);
      const updated: ModelSourceRecord = {
        ...withoutHealthText(record),
        lastValidatedAt: result.validatedAt,
        ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
        ...(result.error === undefined ? {} : { lastError: result.error.slice(0, 1_000) }),
        source: { ...record.source, status: result.status, updatedAt: result.validatedAt },
      };
      await repository.save(updated);
      return updated;
    })();
    this.#probes.set(key, probe);
    try { return await probe; }
    finally { if (this.#probes.get(key) === probe) this.#probes.delete(key); }
  }
}

function withoutHealthText(record: ModelSourceRecord): Omit<ModelSourceRecord, "lastError" | "reasonCode"> {
  return {
    ...(record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl }),
    ...(record.lastValidatedAt === undefined ? {} : { lastValidatedAt: record.lastValidatedAt }),
    local: record.local,
    order: record.order,
    ...(record.presetVersion === undefined ? {} : { presetVersion: record.presetVersion }),
    primary: record.primary,
    source: record.source,
  };
}

function safeReasonSuffix(reasonCode: string): string {
  return /^[a-z0-9_]{1,80}$/u.test(reasonCode) ? reasonCode : "not_ready";
}

function numericStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.code === "string") {
    const match = /^http_(401|403)$/u.exec(candidate.code);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}
