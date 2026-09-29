import { DomainError } from "../../domain/errors.js";
import { classifySourceFailure, pinModelSourceForTurn, type SourceFailureKind } from "../../domain/model-sources/model-source.js";
import type { ModelSourceHealthRevision, ModelSourceRecord, ModelSourceRepository, ModelSourceValidator } from "../ports/model-source-ports.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import type { Clock } from "../ports/runtime-store.js";
import { classifyHttp403Detail, classifyPartnerRunFailure } from "../partners/partner-run-failure.js";

type SourcePin = ReturnType<typeof pinModelSourceForTurn>;
type SelectorRepository = Pick<ModelSourceRepository, "list"> & Partial<Pick<ModelSourceRepository, "get" | "recordToolProof" | "save" | "saveHealthIfCurrent">>;

/** A route that rejected a run for lacking completion budget stays skipped for this window. */
const CAPACITY_AVOIDANCE_MILLIS = 30 * 60_000;

export interface SelectInitialOptions {
  /**
   * Prefer sources whose active revision either ships as release-tested or has demonstrated
   * structured tool calling in a real turn. Callers whose contract demands well-formed tool calls
   * (the strategy evaluation, say) pass this; when no such source is ready the selection falls
   * back to the full pool and says so in diagnostics rather than failing outright.
   */
  requireToolProof?: boolean;
}

export class ReasoningSourceSelector {
  readonly #probes = new Map<string, Promise<ModelSourceRecord | undefined>>();
  readonly #avoidedUntil = new Map<string, number>();

  constructor(
    private readonly repository: SelectorRepository,
    private readonly options?: { clock?: Pick<Clock, "now">; freshnessMillis?: number; validator?: ModelSourceValidator; diagnostics?: RuntimeDiagnostics },
  ) {}

  async selectInitial(turnId: string, options?: SelectInitialOptions): Promise<SourcePin> {
    const ready = await this.#readySources();
    // A capacity-mismatched route stays reachable but unusable for large contexts, so prefer
    // routes without a recent budget failure; only fall back to avoided routes when no other
    // READY source exists, keeping the original not-ready error for a fully unusable pool.
    // Freshness probes are memoized per selection so the second pass never re-probes.
    const freshened = new Map<string, Promise<ModelSourceRecord | undefined>>();
    const freshOf = (record: ModelSourceRecord): Promise<ModelSourceRecord | undefined> => {
      const existing = freshened.get(record.source.sourceId);
      if (existing !== undefined) return existing;
      const pending = this.#fresh(record);
      freshened.set(record.source.sourceId, pending);
      return pending;
    };
    if (options?.requireToolProof === true) {
      const proven = ready.filter((record) => record.source.activeModelRevision.capability === "release-tested" || record.source.toolProofAt !== undefined);
      const provenPin = proven.length > 0 ? await this.#firstReady(proven, turnId, freshOf) : null;
      if (provenPin !== null) return provenPin;
      // Falling back to an unproven source is exactly how a caller with a strict tool-call contract
      // ends up rejecting responses; make that visible at the moment it happens.
      emitRuntimeDiagnostic(this.options?.diagnostics, "joi.model_source.tool_proof_fallback",
        { context: turnId, provenCount: proven.length, totalCount: ready.length });
    }
    const pin = await this.#firstReady(ready, turnId, freshOf);
    if (pin !== null) return pin;
    throw new DomainError("model_source_not_ready", "No model source is ready.");
  }

  /** The original two-pass capacity-avoiding scan, over whichever pool the caller narrowed to. */
  async #firstReady(pool: ModelSourceRecord[], turnId: string, freshOf: (record: ModelSourceRecord) => Promise<ModelSourceRecord | undefined>): Promise<SourcePin | null> {
    for (const includeAvoided of [false, true]) {
      for (const candidate of pool) {
        if (!includeAvoided && this.#isCapacityAvoided(candidate.source.sourceId)) continue;
        const source = await freshOf(candidate);
        if (source?.source.status === "READY") return pinModelSourceForTurn(source.source, turnId);
      }
    }
    return null;
  }

  async selectById(sourceId: string, turnId: string): Promise<SourcePin> {
    const candidate = (await this.#readySources()).find((record) => record.source.sourceId === sourceId);
    const record = candidate === undefined ? undefined : await this.#fresh(candidate);
    if (record === undefined) {
      // A pin outlives the readiness it was chosen under: editing a source puts it back to DRAFT,
      // and nothing revisits the partners still pointing at it until one of them runs. Name that
      // source and its state, or the only report left is "the partner model source is not ready",
      // which tells the user nothing about what to repair.
      const pinned = (await this.repository.list()).find((entry) => entry.source.sourceId === sourceId);
      throw new DomainError("partner_model_source_not_ready", pinned === undefined
        ? "The partner is pinned to a model source that no longer exists."
        : `The partner is pinned to "${pinned.source.activeSourceRevision.displayName.slice(0, 80)}", which is ${pinned.source.status} rather than READY.`);
    }
    if (record.source.status !== "READY") {
      const suffix = record.reasonCode === undefined ? "not_ready" : safeReasonSuffix(record.reasonCode);
      throw new DomainError(`partner_model_source_${suffix}`, "The pinned partner model source requires authorization or model configuration.");
    }
    return pinModelSourceForTurn(record.source, turnId);
  }

  /** Removes a failed auth route from dispatch immediately, then runs one coalesced no-tool diagnostic probe. */
  async reportRunFailure(sourceId: string, error: unknown): Promise<void> {
    // Readiness probes only prove a route is reachable, not that it can hold a large partner
    // context, so a capacity rejection is remembered in-memory and skipped by selection for a
    // bounded window instead of being rediscovered by every large dispatch. An input that exceeded
    // the window outright is the same capacity mismatch as one that left no completion budget;
    // both stay reachable through selectInitial's second pass, so avoiding every route cannot
    // strand a dispatch.
    const capacityReason = classifyPartnerRunFailure(error, { phase: "MODEL", sideEffectState: "NONE" }).reasonCode;
    if (capacityReason === "model_context_budget_exhausted" || capacityReason === "context_too_large") {
      this.avoidSource(sourceId, CAPACITY_AVOIDANCE_MILLIS);
    }
    if (this.options?.clock === undefined || this.repository.get === undefined
      || (this.repository.save === undefined && this.repository.saveHealthIfCurrent === undefined)) return;
    const status = numericStatus(error);
    if (status !== 401 && status !== 403) return;
    const current = await this.repository.get(sourceId);
    if (current === null) return;
    const detail = error !== null && typeof error === "object" && typeof (error as { detail?: unknown }).detail === "string"
      ? (error as { detail: string }).detail
      : "";
    const reasonCode = status === 401 ? "auth_failed" : classifyHttp403Detail(detail);
    const now = this.options.clock.now().toISOString();
    const marked = await this.#saveHealth({
      ...withoutHealthText(current),
      lastValidatedAt: now,
      reasonCode,
      source: { ...current.source, status: "NEEDS_AUTH", updatedAt: now },
    }, current);
    if (!marked) return;
    const latest = await this.repository.get(sourceId);
    if (latest !== null) await this.#probe(latest, true);
  }

  async selectFallback(input: {
    currentSourceId: string;
    failure: SourceFailureKind;
    formalOutputStarted: boolean;
    sideEffectStarted: boolean;
    turnId: string;
  }): Promise<SourcePin | null> {
    // A protocol failure (e.g. tool-call markup leaked as plain text) only ever produced
    // garbage text, so redoing the Turn after formal output is safe; any real side effect
    // still bars a fallback outright.
    if (input.sideEffectStarted || !classifySourceFailure(input.failure).fallbackAllowed) return null;
    if (input.formalOutputStarted && input.failure !== "protocol") return null;
    const sources = (await this.repository.list()).sort((left, right) => left.order - right.order);
    const currentIndex = sources.findIndex((record) => record.source.sourceId === input.currentSourceId);
    if (currentIndex < 0) return null;
    for (const candidate of sources.slice(currentIndex + 1)) {
      if (candidate.source.status !== "READY" || this.#isCapacityAvoided(candidate.source.sourceId)) continue;
      const fresh = await this.#fresh(candidate);
      if (fresh?.source.status === "READY") return pinModelSourceForTurn(fresh.source, input.turnId);
    }
    return null;
  }

  /**
   * Skips a route for the given window after a deterministic failure (capacity mismatch,
   * protocol garbage): selection prefers other READY sources first and only returns to the
   * avoided one when nothing else can serve, so avoidance never strands a dispatch.
   */
  avoidSource(sourceId: string, millis: number): void {
    this.#avoidedUntil.set(sourceId, this.#nowMillis() + millis);
  }

  /** Persists that the pinned revision pair demonstrated structured tool calling, so later Turns skip the first-Turn gate. */
  async recordToolProof(input: { modelRevisionId: string; provenAt: string; sourceRevisionId: string }): Promise<void> {
    await this.repository.recordToolProof?.(input);
  }

  async #readySources(): Promise<ModelSourceRecord[]> {
    return (await this.repository.list())
      .filter((record) => record.source.status === "READY")
      .sort((left, right) => left.order - right.order);
  }

  #nowMillis(): number {
    return this.options?.clock?.now().getTime() ?? Date.now();
  }

  #isCapacityAvoided(sourceId: string): boolean {
    const until = this.#avoidedUntil.get(sourceId);
    if (until === undefined) return false;
    if (until > this.#nowMillis()) return true;
    this.#avoidedUntil.delete(sourceId);
    return false;
  }

  async #fresh(record: ModelSourceRecord): Promise<ModelSourceRecord | undefined> {
    // Probing needs a validator and a clock; a selector constructed for read-only selection
    // (diagnostics only) must never reach for one even though its options object exists.
    const options = this.options;
    if (options?.validator === undefined || options.clock === undefined) return record;
    const validatedAt = record.lastValidatedAt === undefined ? Number.NaN : Date.parse(record.lastValidatedAt);
    const age = options.clock.now().getTime() - validatedAt;
    if (Number.isFinite(age) && age >= 0 && age <= (options.freshnessMillis ?? 5 * 60_000)) return record;
    return this.#probe(record, false);
  }

  async #probe(record: ModelSourceRecord, force: boolean): Promise<ModelSourceRecord | undefined> {
    const validator = this.options?.validator;
    const clock = this.options?.clock;
    if (validator === undefined || clock === undefined || (this.repository.save === undefined && this.repository.saveHealthIfCurrent === undefined)) return record;
    const repository = this.repository;
    const source = record.source;
    const key = [source.sourceId, source.activeSourceRevision.sourceRevisionId, source.activeModelRevision.modelRevisionId, String(source.activeSourceRevision.credentialVersion)].join(":");
    const existing = this.#probes.get(key);
    if (existing !== undefined) return existing;
    const probe = (async () => {
      if (!force) {
        const validatedAt = record.lastValidatedAt === undefined ? Number.NaN : Date.parse(record.lastValidatedAt);
        const age = clock.now().getTime() - validatedAt;
        if (Number.isFinite(age) && age >= 0 && age <= (this.options?.freshnessMillis ?? 5 * 60_000)) return record;
      }
      const result = await validator.validate(record);
      const updated: ModelSourceRecord = {
        ...withoutHealthText(record),
        lastValidatedAt: result.validatedAt,
        ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
        ...(result.error === undefined ? {} : { lastError: result.error.slice(0, 1_000) }),
        source: { ...record.source, status: result.status, updatedAt: result.validatedAt },
      };
      if (await this.#saveHealth(updated, record)) return updated;
      return repository.get === undefined ? undefined : await repository.get(source.sourceId) ?? undefined;
    })();
    this.#probes.set(key, probe);
    try { return await probe; }
    finally { if (this.#probes.get(key) === probe) this.#probes.delete(key); }
  }

  async #saveHealth(record: ModelSourceRecord, expected: ModelSourceRecord): Promise<boolean> {
    const revision: ModelSourceHealthRevision = {
      credentialVersion: expected.source.activeSourceRevision.credentialVersion,
      modelRevisionId: expected.source.activeModelRevision.modelRevisionId,
      sourceRevisionId: expected.source.activeSourceRevision.sourceRevisionId,
      sourceUpdatedAt: expected.source.updatedAt,
    };
    if (this.repository.saveHealthIfCurrent !== undefined) return this.repository.saveHealthIfCurrent(record, revision);
    if (this.repository.save === undefined) return false;
    if (this.repository.get !== undefined) {
      const current = await this.repository.get(expected.source.sourceId);
      if (current === null || !sameRevision(current, expected)) return false;
    }
    await this.repository.save(record);
    return true;
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
    // The proof lives inside source, so it survives health rebuilds automatically.
    source: record.source,
  };
}

function safeReasonSuffix(reasonCode: string): string {
  return /^[a-z0-9_]{1,80}$/u.test(reasonCode) ? reasonCode : "not_ready";
}

function sameRevision(left: ModelSourceRecord, right: ModelSourceRecord): boolean {
  return left.source.sourceId === right.source.sourceId
    && left.source.activeSourceRevision.sourceRevisionId === right.source.activeSourceRevision.sourceRevisionId
    && left.source.activeModelRevision.modelRevisionId === right.source.activeModelRevision.modelRevisionId
    && left.source.activeSourceRevision.credentialVersion === right.source.activeSourceRevision.credentialVersion
    && left.source.updatedAt === right.source.updatedAt;
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
