import { DomainError } from "../../domain/errors.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { PartnerRunRequest, PartnerRunResult } from "../ports/partner-execution.js";
import type {
  PartnerEngineRuntime,
  PartnerInstanceMessageStore,
  PartnerInstanceRecord,
  PartnerInstanceRepository,
  SessionPolicy,
} from "../ports/partner-instances.js";
import type { PartnerRegistryRepository } from "../ports/partner-registry.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { PartnerKnowledgeService } from "./partner-knowledge-service.js";
import type { PartnerRegistryService } from "./partner-registry-service.js";
import type { PartnerSkillCatalog } from "../ports/partner-skills.js";

const DEFAULT_LIMITS = {
  ephemeralIdleMillis: 5 * 60_000,
  maxResidentGlobal: 12,
  maxResidentPerPartner: 4,
  warmIdleMillis: 30 * 60_000,
} as const;

export class PartnerInstanceManager {
  readonly #limits: { ephemeralIdleMillis: number; maxResidentGlobal: number; maxResidentPerPartner: number; warmIdleMillis: number };

  constructor(private readonly dependencies: {
    clock: Clock;
    engines: Map<string, PartnerEngineRuntime>;
    ids: IdGenerator;
    knowledge: Pick<PartnerKnowledgeService, "readForInjection">;
    limits?: Partial<{ ephemeralIdleMillis: number; maxResidentGlobal: number; maxResidentPerPartner: number; warmIdleMillis: number }>;
    messages: PartnerInstanceMessageStore;
    registry: Pick<PartnerRegistryService, "pinForDispatch">;
    repository: PartnerInstanceRepository;
    revisions: Pick<PartnerRegistryRepository, "getActive">;
    skills: Pick<PartnerSkillCatalog, "readInstructions">;
  }) {
    this.#limits = { ...DEFAULT_LIMITS, ...(dependencies.limits ?? {}) };
  }

  /** Creates a fresh instance for the partner's active revision; resident creation enforces hard caps. */
  async ensure(input: { partnerId: string; sessionPolicy?: SessionPolicy }): Promise<PartnerInstanceRecord> {
    const policy: SessionPolicy = input.sessionPolicy ?? "RESIDENT";
    const pin = await this.dependencies.registry.pinForDispatch(input.partnerId);
    const revision = await this.dependencies.revisions.getActive(input.partnerId);
    if (revision === null) throw new DomainError("partner_not_found", "Partner was not found.");
    if (policy === "RESIDENT"
      && (await this.dependencies.repository.countActive(input.partnerId) >= this.#limits.maxResidentPerPartner
        || await this.dependencies.repository.countActiveGlobal() >= this.#limits.maxResidentGlobal)) {
      throw new DomainError("partner_instance_cap_exceeded", "Too many resident partner instances; reuse an IDLE instance or dispose one first.");
    }
    const createdAt = this.dependencies.clock.now().toISOString();
    return this.dependencies.repository.create({
      createdAt,
      engine: revision.engine,
      instanceId: this.dependencies.ids.next("partner_instance"),
      partnerId: input.partnerId,
      partnerRevisionId: pin.partnerRevisionId,
      sessionPolicy: policy,
    });
  }

  /**
   * Runs one turn. A given instanceId must be IDLE and belong to the revision's partner.
   * Without an instanceId, ephemeral is the default policy; resident requires ensure() first
   * (joi sees live instances through partner.list_instances and passes the id explicitly).
   */
  async dispatch(input: {
    dispatchAttemptId?: string;
    instanceId?: string;
    request: PartnerRunRequest;
    revision: PartnerRevision;
    sessionPolicy?: SessionPolicy;
  }): Promise<PartnerRunResult> {
    let record: PartnerInstanceRecord;
    if (input.instanceId !== undefined) {
      const existing = await this.dependencies.repository.get(input.instanceId);
      if (existing === null || existing.status === "DISPOSED") throw new DomainError("partner_instance_unavailable", "Partner instance is not available.");
      if (existing.partnerId !== input.revision.partnerId) throw new DomainError("partner_instance_partner_mismatch", "Partner instance belongs to another partner.");
      if (existing.status !== "IDLE") throw new DomainError("partner_instance_busy", "Partner instance is busy with another turn.");
      record = existing;
    } else if (input.sessionPolicy === "RESIDENT") {
      record = await this.ensure({ partnerId: input.revision.partnerId });
    } else {
      record = await this.dependencies.repository.create({
        createdAt: this.dependencies.clock.now().toISOString(),
        engine: input.revision.engine,
        instanceId: this.dependencies.ids.next("partner_instance"),
        partnerId: input.revision.partnerId,
        partnerRevisionId: input.revision.partnerRevisionId,
        sessionPolicy: "EPHEMERAL",
      });
    }
    if (input.dispatchAttemptId !== undefined) await this.dependencies.repository.linkDispatch(input.dispatchAttemptId, record.instanceId);

    const engine = this.#engine(record.engine);
    const knowledgeSection = input.revision.kind === "local-pi"
      ? await this.dependencies.knowledge.readForInjection(record.partnerId)
      : "";
    const skillSection = input.revision.kind === "local-pi"
      ? this.dependencies.skills.readInstructions(input.revision.skills)
      : "";
    const startedAt = this.dependencies.clock.now().toISOString();
    await this.dependencies.repository.setStatusBusy(record.instanceId, startedAt);
    try {
      if (record.sessionPolicy === "EPHEMERAL") {
        const result = await engine.runEphemeral(input.request, input.revision, { knowledgeSection, skillSection });
        await this.#disposeRecord(record, "ephemeral_completed");
        return { actionId: input.request.actionId, externalRunId: result.externalRunId, status: result.status, workId: input.request.workId };
      }
      const restored = await this.dependencies.messages.load(record.instanceId);
      const turn = await engine.runResidentTurn({
        ...(record.externalSessionRef === undefined ? {} : { externalSessionRef: record.externalSessionRef }),
        instanceId: record.instanceId,
        knowledgeSection,
        request: input.request,
        restoredMessages: restored,
        revision: input.revision,
        skillSection,
      });
      await this.dependencies.messages.save(record.instanceId, turn.messages);
      await this.dependencies.repository.markTurnComplete(
        record.instanceId,
        this.dependencies.clock.now().toISOString(),
        turn.externalSessionRef,
      );
      return { actionId: input.request.actionId, externalRunId: turn.externalRunId, status: turn.status, workId: input.request.workId };
    } catch (error) {
      if (record.sessionPolicy === "EPHEMERAL") {
        await this.#disposeRecord(record, "ephemeral_failed");
      } else {
        // A failed resident turn stays resumable: the instance returns to IDLE with its saved messages.
        await this.dependencies.repository.markTurnComplete(record.instanceId, this.dependencies.clock.now().toISOString());
      }
      throw error;
    }
  }

  async dispose(instanceId: string, reason: string): Promise<void> {
    const record = await this.dependencies.repository.get(instanceId);
    if (record === null || record.status === "DISPOSED") return;
    if (record.status === "BUSY") throw new DomainError("partner_instance_busy", "Partner instance is busy and cannot be disposed.");
    await this.#disposeRecord(record, reason);
  }

  async list(partnerId?: string): Promise<PartnerInstanceRecord[]> {
    return this.dependencies.repository.listActive(partnerId);
  }

  async recoverOnBoot(): Promise<{ ephemeralDisposed: number; residentRecovered: number }> {
    return this.dependencies.repository.recoverCrashed(this.dependencies.clock.now().toISOString());
  }

  /** Evicts warm engine state that has idled too long and disposes stranded ephemerals. */
  async sweepIdle(now: Date): Promise<{ disposed: number; evicted: number }> {
    const active = await this.dependencies.repository.listActive();
    let disposed = 0;
    let evicted = 0;
    for (const record of active) {
      const idleMillis = now.getTime() - Date.parse(record.lastUsedAt);
      if (record.sessionPolicy === "EPHEMERAL" && record.status === "IDLE" && idleMillis > this.#limits.ephemeralIdleMillis) {
        await this.#disposeRecord(record, "ephemeral_idle");
        disposed += 1;
      } else if (record.status === "IDLE" && idleMillis > this.#limits.warmIdleMillis) {
        this.#engine(record.engine).evictFromMemory(record.instanceId);
        evicted += 1;
      }
    }
    return { disposed, evicted };
  }

  async #disposeRecord(record: PartnerInstanceRecord, reason: string): Promise<void> {
    await this.dependencies.repository.markDisposed(record.instanceId, reason, this.dependencies.clock.now().toISOString());
    this.#engine(record.engine).evictFromMemory(record.instanceId);
    if (record.sessionPolicy === "EPHEMERAL") await this.dependencies.messages.clear(record.instanceId);
  }

  #engine(engine: PartnerRevision["engine"]): PartnerEngineRuntime {
    const runtime = this.dependencies.engines.get(engine);
    if (runtime === undefined) throw new DomainError("partner_engine_unavailable", "Partner engine is unavailable.");
    return runtime;
  }
}
