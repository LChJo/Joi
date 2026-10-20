import type { ModelSourceRecord, ModelSourceRecoveryQueue, ModelSourceRepository, ModelSourceValidator } from "../ports/model-source-ports.js";
import type { Clock, OutboxRecord } from "../ports/runtime-store.js";
import { isTransientModelSourceFailure } from "../../domain/model-sources/model-source-recovery-policy.js";

export const MODEL_SOURCE_RECOVERY_KIND = "model.source.recover";
const RETRY_INTERVAL_MILLIS = 60_000;
const SCAN_INTERVAL_MILLIS = 10_000;

/** Probes run only through the background outbox; scans never wait for a provider. */
export class ModelSourceRecovery {
  #lastScanAt = Number.NEGATIVE_INFINITY;
  readonly #controller = new AbortController();

  constructor(private readonly dependencies: {
    clock: Clock;
    queue: ModelSourceRecoveryQueue;
    repository: Pick<ModelSourceRepository, "get" | "list"> & Required<Pick<ModelSourceRepository, "saveHealthIfCurrent">>;
    validator: ModelSourceValidator;
  }) {}

  stop(): void { this.#controller.abort(); }

  #assertRunning(): void {
    if (this.#controller.signal.aborted) throw new Error("model_source_recovery_canceled");
  }

  async enqueueDue(): Promise<void> {
    const now = this.dependencies.clock.now();
    if (this.#controller.signal.aborted || now.getTime() - this.#lastScanAt < SCAN_INTERVAL_MILLIS) return;
    this.#lastScanAt = now.getTime();
    for (const record of await this.dependencies.repository.list()) {
      if (!recoverable(record) || now.getTime() - Date.parse(record.source.updatedAt) < RETRY_INTERVAL_MILLIS) continue;
      const source = record.source;
      const payload = { sourceId: source.sourceId, sourceRevisionId: source.activeSourceRevision.sourceRevisionId,
        modelRevisionId: source.activeModelRevision.modelRevisionId, credentialVersion: source.activeSourceRevision.credentialVersion,
        sourceUpdatedAt: source.updatedAt };
      await this.dependencies.queue.enqueueRecovery({ kind: MODEL_SOURCE_RECOVERY_KIND,
        outboxId: `${MODEL_SOURCE_RECOVERY_KIND}:${JSON.stringify(Object.values(payload))}`, payload, availableAt: now.toISOString() });
    }
  }

  async handle(delivery: OutboxRecord): Promise<void> {
    this.#assertRunning();
    const payload = delivery.payload;
    if (typeof payload.sourceId !== "string" || typeof payload.sourceRevisionId !== "string"
      || typeof payload.modelRevisionId !== "string" || typeof payload.sourceUpdatedAt !== "string"
      || !Number.isSafeInteger(payload.credentialVersion)) throw new Error("model_source_recovery_payload_invalid");
    const record = await this.dependencies.repository.get(payload.sourceId);
    if (record === null || !recoverable(record)) return;
    const source = record.source;
    if (source.activeSourceRevision.sourceRevisionId !== payload.sourceRevisionId
      || source.activeModelRevision.modelRevisionId !== payload.modelRevisionId
      || source.activeSourceRevision.credentialVersion !== payload.credentialVersion
      || source.updatedAt !== payload.sourceUpdatedAt) return;
    this.#assertRunning();
    const result = await this.dependencies.validator.validate(record, this.#controller.signal);
    this.#assertRunning();
    // The captured revision and health state fence edits, manual validation and disable decisions.
    const unchanged = { ...record };
    delete unchanged.lastError;
    delete unchanged.reasonCode;
    await this.dependencies.repository.saveHealthIfCurrent({ ...unchanged,
      ...(result.status === "READY" && result.anthropicAuthMode === "bearer" ? { anthropicAuthMode: result.anthropicAuthMode } : {}),
      ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
      ...(result.error === undefined ? {} : { lastError: result.error.slice(0, 1_000) }),
      lastValidatedAt: result.validatedAt,
      source: { ...source, status: result.status, updatedAt: this.dependencies.clock.now().toISOString() },
    }, { sourceStatus: source.status, sourceUpdatedAt: source.updatedAt,
      credentialVersion: source.activeSourceRevision.credentialVersion,
      sourceRevisionId: source.activeSourceRevision.sourceRevisionId, modelRevisionId: source.activeModelRevision.modelRevisionId });
  }
}

function recoverable(record: ModelSourceRecord): boolean {
  return record.source.status === "DEGRADED" && isTransientModelSourceFailure(record.reasonCode);
}
