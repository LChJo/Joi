import { DomainError } from "../../domain/errors.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { PartnerRunRequest, PartnerRunResult } from "../ports/partner-execution.js";
import type {
  PartnerConversationProgress,
  PartnerEngineRuntime,
  PartnerInstanceMessageStore,
  PartnerInstanceRecord,
  PartnerInstanceRepository,
  SessionPolicy,
} from "../ports/partner-instances.js";
import type { PartnerRegistryRepository } from "../ports/partner-registry.js";
import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
  runtimeDiagnosticErrorDetail,
  type RuntimeDiagnostics,
} from "../ports/runtime-diagnostics.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { PartnerKnowledgeService } from "./partner-knowledge-service.js";
import type { PartnerRegistryService } from "./partner-registry-service.js";
import type { PartnerSkillCatalog } from "../ports/partner-skills.js";
import { wrapPartnerRunFailure, type PartnerRunFailure } from "./partner-run-failure.js";
import { NativeAgentEventProjector } from "./native-agent-event-projector.js";
import type { ModelSourceTurnPin } from "../../domain/model-sources/model-source.js";

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
    diagnostics?: RuntimeDiagnostics;
    engines: Map<string, PartnerEngineRuntime>;
    ids: IdGenerator;
    knowledge: Pick<PartnerKnowledgeService, "readForInjection">;
    limits?: Partial<{ ephemeralIdleMillis: number; maxResidentGlobal: number; maxResidentPerPartner: number; warmIdleMillis: number }>;
    messages: PartnerInstanceMessageStore;
    registry: Pick<PartnerRegistryService, "pinForDispatch">;
    repository: PartnerInstanceRepository;
    revisions: Pick<PartnerRegistryRepository, "getActive">;
    skills: Pick<PartnerSkillCatalog, "readInstructions" | "resolveForPi" | "validateRefs">;
  }) {
    this.#limits = { ...DEFAULT_LIMITS, ...(dependencies.limits ?? {}) };
  }

  /** Creates a fresh instance for the partner's active revision; resident creation enforces hard caps. */
  async ensure(input: { workbenchId: string; partnerId: string; sessionPolicy?: SessionPolicy }): Promise<PartnerInstanceRecord> {
    const policy: SessionPolicy = input.sessionPolicy ?? "RESIDENT";
    const pin = await this.dependencies.registry.pinForDispatch(input.partnerId);
    const revision = await this.dependencies.revisions.getActive(input.partnerId);
    if (revision === null) throw new DomainError("partner_not_found", "Partner was not found.");
    if (policy === "RESIDENT"
      && (await this.dependencies.repository.countActive(input.workbenchId, input.partnerId) >= this.#limits.maxResidentPerPartner
        || await this.dependencies.repository.countActiveGlobal() >= this.#limits.maxResidentGlobal)) {
      throw new DomainError("partner_instance_cap_exceeded", "Too many resident partner instances; reuse an IDLE instance or dispose one first.");
    }
    const createdAt = this.dependencies.clock.now().toISOString();
    return this.dependencies.repository.create({
      workbenchId: input.workbenchId,
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
   * (joi sees live instances through partner_list_instances and passes the id explicitly).
   */
  async dispatch(input: {
    dispatchAttemptId?: string;
    instanceId?: string;
    onConversation?: (progress: PartnerConversationProgress) => Promise<void>;
    onProgress?: () => void;
    request: PartnerRunRequest;
    revision: PartnerRevision;
    sessionPolicy?: SessionPolicy;
    /** Abort requested by the dispatch actor (watchdog, lease loss, cancellation). */
    signal?: AbortSignal;
  }): Promise<PartnerRunResult> {
    let createdEphemeral: PartnerInstanceRecord | undefined;
    const createEphemeral = async (): Promise<PartnerInstanceRecord> => {
      createdEphemeral = await this.dependencies.repository.create({
        workbenchId: input.request.workbenchId,
        createdAt: this.dependencies.clock.now().toISOString(),
        engine: input.revision.engine,
        instanceId: this.dependencies.ids.next("partner_instance"),
        partnerId: input.revision.partnerId,
        partnerRevisionId: input.revision.partnerRevisionId,
        sessionPolicy: "EPHEMERAL",
      });
      return createdEphemeral;
    };
    let record: PartnerInstanceRecord;
    let preflightPin: ModelSourceTurnPin | undefined;
    try {
      preflightPin = await this.#engine(input.revision.engine).preflight?.({ revision: input.revision, turnId: input.request.actionId });
      if (input.instanceId !== undefined) {
        const existing = await this.dependencies.repository.get(input.instanceId);
        if (existing === null) throw new DomainError("partner_instance_unavailable", "Partner instance is not available.");
        if (existing.workbenchId !== input.request.workbenchId) throw new DomainError("partner_instance_workbench_mismatch", "Partner instance belongs to another Workbench.");
        if (existing.partnerId !== input.revision.partnerId) throw new DomainError("partner_instance_partner_mismatch", "Partner instance belongs to another partner.");
        if (existing.status === "DISPOSED") {
          if (existing.sessionPolicy !== "EPHEMERAL") throw new DomainError("partner_instance_unavailable", "Partner instance is not available.");
          // Compatibility for delayed outbox rows persisted before plan-time validation existed.
          record = await createEphemeral();
        } else {
          if (existing.status !== "IDLE") throw new DomainError("partner_instance_busy", "Partner instance is busy with another turn.");
          record = existing;
        }
      } else if (input.sessionPolicy === "RESIDENT") {
        record = await this.ensure({ workbenchId: input.request.workbenchId, partnerId: input.revision.partnerId });
      } else {
        record = await createEphemeral();
      }
      if (input.dispatchAttemptId !== undefined) await this.dependencies.repository.linkDispatch(input.dispatchAttemptId, record.instanceId);
    } catch (error) {
      const failure = wrapPartnerRunFailure(error, { phase: "EXECUTION", sideEffectState: "NONE" });
      if (createdEphemeral !== undefined) {
        try { await this.#disposeRecord(createdEphemeral, "dispatch_preflight_failed"); } catch { /* retain the original safe failure */ }
      }
      this.#emitPreflightFailure(input, failure.partnerRunFailure);
      throw failure;
    }

    let skillSection = "";
    let skillEnvironmentKeys: readonly string[] = [];
    try {
      if (input.revision.kind === "local-pi") {
        this.dependencies.skills.validateRefs(input.revision.engine, input.revision.skills);
        if (input.revision.engine === "pi-core") {
          const toolPolicyMode = input.revision.toolPolicyMode ?? (input.revision.tools.length === 0 ? "ALL" : "CUSTOM");
          if (input.revision.skills.length > 0 && toolPolicyMode === "CUSTOM" && !input.revision.tools.includes("read")) {
            throw new DomainError("partner_skill_requires_read", "Pi Skills require the read tool when the tool list is narrowed.");
          }
          const dispatch = this.dependencies.skills.resolveForPi(input.revision.skills);
          skillEnvironmentKeys = dispatch.environmentKeys;
          skillSection = dispatch.promptSection;
        } else {
          skillSection = this.dependencies.skills.readInstructions(input.revision.skills);
        }
      }
    } catch (error) {
      const failure = wrapPartnerRunFailure(error, { phase: "CONFIGURATION", sideEffectState: "NONE" });
      if (record.sessionPolicy === "EPHEMERAL") await this.#disposeRecord(record, "skill_configuration_failed");
      if (input.revision.skills.length > 0) {
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.skills.failed", {
          actionId: input.request.actionId,
          errorCode: runtimeDiagnosticErrorCode(failure),
          ...((() => { const detail = runtimeDiagnosticErrorDetail(failure); return detail === undefined ? {} : { errorDetail: detail }; })()),
          instanceId: record.instanceId,
          partnerId: record.partnerId,
          skillCount: input.revision.skills.length,
          workbenchId: input.request.workbenchId,
          workId: input.request.workId,
        });
      }
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.instance.failed", {
        actionId: input.request.actionId,
        workbenchId: input.request.workbenchId,
        ...(input.dispatchAttemptId === undefined ? {} : { dispatchAttemptId: input.dispatchAttemptId }),
        durationMs: 0,
        errorCode: runtimeDiagnosticErrorCode(failure),
        ...((() => { const detail = runtimeDiagnosticErrorDetail(failure); return detail === undefined ? {} : { errorDetail: detail }; })()),
        instanceId: record.instanceId,
        workId: input.request.workId,
      });
      throw failure;
    }

    let engine: PartnerEngineRuntime;
    let knowledgeSection: string;
    const startedAtMillis = this.dependencies.clock.now().getTime();
    try {
      engine = this.#engine(record.engine);
      knowledgeSection = input.revision.kind === "local-pi"
        ? await this.dependencies.knowledge.readForInjection(record.partnerId)
        : "";
      await this.dependencies.repository.setStatusBusy(record.instanceId, this.dependencies.clock.now().toISOString());
    } catch (error) {
      const failure = wrapPartnerRunFailure(error, { phase: "EXECUTION", sideEffectState: "NONE" });
      try {
        if (record.sessionPolicy === "EPHEMERAL") await this.#disposeRecord(record, "dispatch_preflight_failed");
        else await this.dependencies.repository.markTurnComplete(record.instanceId, this.dependencies.clock.now().toISOString());
      } catch { /* retain the original safe failure */ }
      this.#emitPreflightFailure(input, failure.partnerRunFailure, record, Math.max(0, this.dependencies.clock.now().getTime() - startedAtMillis));
      throw failure;
    }
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.instance.started", {
      actionId: input.request.actionId,
      workbenchId: input.request.workbenchId,
      ...(input.dispatchAttemptId === undefined ? {} : { dispatchAttemptId: input.dispatchAttemptId }),
      engine: record.engine,
      instanceId: record.instanceId,
      partnerId: record.partnerId,
      sessionPolicy: record.sessionPolicy,
      workId: input.request.workId,
    });
    const liveProjector = input.onConversation === undefined ? undefined : new NativeAgentEventProjector();
    const onEvent = liveProjector === undefined ? undefined : async (event: Parameters<NativeAgentEventProjector["apply"]>[0]) => {
      liveProjector.apply(event);
      await input.onConversation?.({ conversation: liveProjector.snapshot(), instanceId: record.instanceId });
    };
    try {
      if (input.revision.skills.length > 0) {
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.skills.injected", {
          actionId: input.request.actionId,
          instanceId: record.instanceId,
          instructionChars: skillSection.length,
          partnerId: record.partnerId,
          skillCount: input.revision.skills.length,
          workbenchId: input.request.workbenchId,
          workId: input.request.workId,
        });
      }
      if (record.sessionPolicy === "EPHEMERAL") {
        const result = await engine.runEphemeral(input.request, input.revision, {
          knowledgeSection,
          ...(onEvent === undefined ? {} : { onEvent }),
          ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
          skillEnvironmentKeys,
          skillSection,
        }, input.signal === undefined ? undefined : { signal: input.signal });
        await this.#disposeRecord(record, "ephemeral_completed");
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.instance.completed", {
          actionId: input.request.actionId,
          workbenchId: input.request.workbenchId,
          ...(input.dispatchAttemptId === undefined ? {} : { dispatchAttemptId: input.dispatchAttemptId }),
          durationMs: Math.max(0, this.dependencies.clock.now().getTime() - startedAtMillis),
          instanceId: record.instanceId,
          status: result.status,
          workId: input.request.workId,
        });
        return {
          actionId: input.request.actionId,
          artifacts: result.output.artifacts,
          body: result.output.body,
          ...(result.conversation === undefined ? {} : { conversation: result.conversation }),
          externalRunId: result.externalRunId,
          instanceId: record.instanceId,
          ...(result.output.pendingQuestion === undefined ? {} : { pendingQuestion: result.output.pendingQuestion }),
          status: result.status,
          workId: input.request.workId,
        };
      }
      const restored = await this.dependencies.messages.load(record.instanceId);
      const turn = await engine.runResidentTurn({
        ...(record.externalSessionRef === undefined ? {} : { externalSessionRef: record.externalSessionRef }),
        instanceId: record.instanceId,
        knowledgeSection,
        ...(onEvent === undefined ? {} : { onEvent }),
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
        request: input.request,
        restoredMessages: restored,
        revision: input.revision,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        skillEnvironmentKeys,
        skillSection,
        ...(preflightPin === undefined ? {} : { sourcePin: preflightPin }),
      });
      if (turn.messages !== undefined) await this.dependencies.messages.save(record.instanceId, turn.messages);
      await this.dependencies.repository.markTurnComplete(
        record.instanceId,
        this.dependencies.clock.now().toISOString(),
        turn.externalSessionRef,
      );
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.instance.completed", {
        actionId: input.request.actionId,
        workbenchId: input.request.workbenchId,
        ...(input.dispatchAttemptId === undefined ? {} : { dispatchAttemptId: input.dispatchAttemptId }),
        durationMs: Math.max(0, this.dependencies.clock.now().getTime() - startedAtMillis),
        instanceId: record.instanceId,
        status: turn.status,
        workId: input.request.workId,
      });
      return {
        actionId: input.request.actionId,
        artifacts: turn.output.artifacts,
        body: turn.output.body,
        ...(turn.conversation === undefined ? {} : { conversation: turn.conversation }),
        externalRunId: turn.externalRunId,
        instanceId: record.instanceId,
        ...(turn.output.pendingQuestion === undefined ? {} : { pendingQuestion: turn.output.pendingQuestion }),
        status: turn.status,
        workId: input.request.workId,
      };
    } catch (error) {
      if (record.sessionPolicy === "EPHEMERAL") {
        await this.#disposeRecord(record, "ephemeral_failed");
      } else {
        // A failed resident turn stays resumable: the instance returns to IDLE with its saved messages.
        await this.dependencies.repository.markTurnComplete(record.instanceId, this.dependencies.clock.now().toISOString());
      }
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.instance.failed", {
        actionId: input.request.actionId,
        workbenchId: input.request.workbenchId,
        ...(input.dispatchAttemptId === undefined ? {} : { dispatchAttemptId: input.dispatchAttemptId }),
        durationMs: Math.max(0, this.dependencies.clock.now().getTime() - startedAtMillis),
        errorCode: runtimeDiagnosticErrorCode(error),
        ...((() => { const detail = runtimeDiagnosticErrorDetail(error); return detail === undefined ? {} : { errorDetail: detail }; })()),
        instanceId: record.instanceId,
        workId: input.request.workId,
      });
      throw error;
    }
  }

  async dispose(input: { workbenchId: string; instanceId: string; reason: string }): Promise<void> {
    const record = await this.dependencies.repository.get(input.instanceId);
    if (record === null) return;
    if (record.workbenchId !== input.workbenchId) throw new DomainError("partner_instance_workbench_mismatch", "Partner instance belongs to another Workbench.");
    if (record.status === "DISPOSED") return;
    if (record.status === "BUSY") throw new DomainError("partner_instance_busy", "Partner instance is busy and cannot be disposed.");
    await this.#disposeRecord(record, input.reason);
  }

  #emitPreflightFailure(
    input: { dispatchAttemptId?: string; instanceId?: string; request: PartnerRunRequest; revision: PartnerRevision },
    failure: PartnerRunFailure,
    record?: PartnerInstanceRecord,
    durationMs = 0,
  ): void {
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.dispatch.preflight_failed", {
      actionId: input.request.actionId,
      workbenchId: input.request.workbenchId,
      ...(input.dispatchAttemptId === undefined ? {} : { dispatchAttemptId: input.dispatchAttemptId }),
      durationMs,
      hasRequestedInstanceId: input.instanceId !== undefined,
      partnerId: record?.partnerId ?? input.revision.partnerId,
      phase: failure.phase,
      reasonCode: failure.reasonCode,
      retryable: failure.retryable,
      sideEffectState: failure.sideEffectState,
      workId: input.request.workId,
    });
  }

  async list(filter?: { workbenchId?: string; partnerId?: string }): Promise<PartnerInstanceRecord[]> {
    return this.dependencies.repository.listActive(filter);
  }

  async recoverOnBoot(): Promise<{ ephemeralDisposed: number; residentRecovered: number }> {
    return this.dependencies.repository.recoverCrashed(this.dependencies.clock.now().toISOString());
  }

  /** Evicts warm engine state that has idled too long and disposes stranded ephemerals for one Workbench. */
  async sweepIdleFor(workbenchId: string, now: Date): Promise<{ disposed: number; evicted: number }> {
    return this.#sweep(await this.dependencies.repository.listActive({ workbenchId }), now);
  }

  async #sweep(active: PartnerInstanceRecord[], now: Date): Promise<{ disposed: number; evicted: number }> {
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
