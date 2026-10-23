import { DomainError } from "../../domain/errors.js";
import { baselineStrategy, composeStrategyInstructions, parseStrategy, promotionDecision, type EvaluationComparison } from "../../domain/evolution/strategy.js";
import { deriveEvolutionExperience, selectEvolutionExperiences, type EvolutionExperience } from "../../domain/evolution/experience.js";
import { EVOLUTION_EVALUATOR_VERSION, evolutionScenarios, scenarioPrompt, simulateAction } from "../../domain/evolution/scenarios.js";
import { EVOLUTION_EVIDENCE_THRESHOLD, EVOLUTION_FAILURE_THRESHOLD, EVOLUTION_HANDLE_TIME_BUDGET_MS, EVOLUTION_MAX_STEPS_PER_HANDLE, EVOLUTION_MONITOR_REVERT_THRESHOLD, EVOLUTION_RESPONSE_INVALID_BREAKER_LIMIT, EVOLUTION_RESPONSE_INVALID_RETRY_LIMIT, EVOLUTION_RUN_NOW_TTL_MILLIS, type EvolutionBatchRecordDto, type EvolutionOverviewDto, type EvolutionReason, type EvolutionScope, type EvolutionStatusDto } from "../../../shared/evolution.js";
import { EvolutionModelCallError, type EvolutionBatch, type EvolutionEvidence, type EvolutionModel, type EvolutionRevision, type EvolutionRollout, type EvolutionSourcePin, type EvolutionState, type EvolutionStore } from "../ports/evolution.js";
import { emitRuntimeDiagnostic, runtimeDiagnosticErrorCode, runtimeDiagnosticErrorDetail, type RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import { buildJoiSystemPrompt } from "../joi/joi-system-prompt.js";

const MAX_CALLS_PER_ROLLOUT = 6;
const MAX_CONSECUTIVE_CALL_FAILURES = 3;
const MAX_STRATEGY_ATTEMPTS = 2;
type GateReason = "not_idle" | "no_candidate" | "evidence_below_threshold" | "aborted";
/** Verdicts that freeze a strategy for the pinned source. Infrastructure failures only allow a bounded retry. */
const FROZEN_REJECTION_REASONS: ReadonlySet<EvolutionReason> = new Set(["hard_violation", "cost_regression", "rolled_back"]);
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new DomainError("evolution_state_invalid", "Evolution state is incomplete.");
  return value;
}
const evaluable = (e: EvolutionEvidence) => e.outcome === "VERIFIED" || e.outcome === "VERIFICATION_FAILED";
const dayOf = (now: string) => now.slice(0, 10); // Persisted UTC accounting day, shown explicitly in settings.
function batchRecord(batch: EvolutionBatch, reason: EvolutionReason, finishedAt: string | null): EvolutionBatchRecordDto {
  return { batchId: batch.id, workbenchId: batch.workbenchId ?? "", scope: batch.scope ?? "WORKBENCH", phase: batch.phase,
    startedAt: batch.startedAt ?? finishedAt ?? "", finishedAt, reason, calls: batch.calls ?? 0,
    tokens: batch.tokensComplete === true ? batch.tokens ?? 0 : null, revisionId: batch.revisionId ?? null,
    ...(batch.failure === undefined ? {} : { failure: batch.failure }) };
}
function projectBatchRecord(record: EvolutionBatchRecordDto): EvolutionBatchRecordDto {
  // A failed legacy batch without failure facts cannot establish zero provider consumption.
  return record.failure === undefined && record.calls > 0 && record.tokens === 0
    && (record.reason === "model_response_invalid" || record.reason === "call_failed") ? { ...record, tokens: null } : record;
}
function chargeCallTokens(state: EvolutionState, batchId: string, tokens: number | null): void {
  if (state.batch?.id === batchId) {
    if (tokens === null) state.batch.tokensComplete = false;
    else state.batch.tokens = (state.batch.tokens ?? 0) + tokens;
    return;
  }
  // A user can finish a batch while its provider request is still returning. Its ledger must
  // retain that consumption without changing the user's verdict or starting another batch.
  const record = state.batchHistory?.find((entry) => entry.batchId === batchId);
  if (record !== undefined) record.tokens = record.tokens === null || tokens === null ? null : record.tokens + tokens;
}
function finishBatch(state: EvolutionState, reason: EvolutionReason, now: string): void {
  const batch = state.batch;
  const revision = state.revisions.find((r) => r.revisionId === batch?.revisionId);
  if (revision !== undefined) { revision.status = "REJECTED"; revision.reason = reason; }
  // Keep the outcome counts of the finished batch visible: a rejection that consumed its trigger
  // window should also show how far from promotion it landed.
  if (revision !== undefined) state.lastVerdict = { reason, at: now, baselineSuccesses: revision.baselineSuccesses, candidateSuccesses: revision.candidateSuccesses, evaluatedRuns: revision.evaluatedRuns };
  if (batch !== null) state.batchHistory = [batchRecord(batch, reason, now), ...(state.batchHistory ?? [])].slice(0, 50);
  state.reason = reason;
  state.batch = null;
  // A verdict consumes the evidence trigger, so resolved historical failures never re-run daily.
  // Infrastructure aborts (call_failed/model_changed) leave the trigger intact for a later retry.
  // model_response_invalid is deliberately NOT in that exception: a model that cannot answer the
  // evaluation contract would otherwise restart a paying batch every day. Recovery is via run-now.
  if (reason !== "call_failed" && reason !== "model_changed") state.lastBatchFinishedAt = now;
}
function modelResult(result: unknown): { value: unknown; tokens: number | null } {
  if (result !== null && typeof result === "object" && !Array.isArray(result) && "value" in result && "tokens" in result) {
    return { value: result.value, tokens: typeof result.tokens === "number" && Number.isSafeInteger(result.tokens) && result.tokens >= 0 ? result.tokens : null };
  }
  return { value: result, tokens: null };
}
const compatible = (revision: EvolutionRevision, pin?: EvolutionSourcePin) => revision.evaluatorVersion === EVOLUTION_EVALUATOR_VERSION
  && (pin === undefined || Object.entries(revision.pin).every(([key, value]) => pin[key as keyof EvolutionSourcePin] === value));
const canaryBucket = (goalId: string) => Array.from(goalId).reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 0) % 5 === 0;
const baselineCacheKeyFor = (evaluatorVersion: string, pin: EvolutionSourcePin, strategy: EvolutionBatch["parentStrategy"]) => `${evaluatorVersion}|${JSON.stringify(pin)}|${JSON.stringify(strategy)}`;
const baselineCacheKey = (batch: EvolutionBatch) => baselineCacheKeyFor(batch.evaluatorVersion, batch.pin, batch.parentStrategy);
function discardInterruptedRollout(batch: EvolutionBatch | null, unknownConsumption = false): void {
  const run = batch?.rollouts.at(-1);
  if (batch === null || batch.phase === "PROPOSE" || run === undefined || run.success !== undefined) return;
  batch.rollouts.pop();
  batch.interruptedCosts = [...(batch.interruptedCosts ?? []), { scenarioId: run.scenarioId, variant: run.variant,
    modelCalls: run.modelCalls ?? run.calls, tokens: run.tokens ?? 0, tokensComplete: !unknownConsumption && run.tokensComplete === true }];
}
function newRollout(batch: EvolutionBatch, scenarioId: string, variant: EvolutionRollout["variant"], attempt: number): EvolutionRollout {
  const costs = (batch.interruptedCosts ?? []).filter(row => row.scenarioId === scenarioId && row.variant === variant);
  batch.interruptedCosts = (batch.interruptedCosts ?? []).filter(row => row.scenarioId !== scenarioId || row.variant !== variant);
  return { scenarioId, variant, attempt, calls: 0, modelCalls: costs.reduce((sum, row) => sum + (row.modelCalls ?? 0), 0),
    tokens: costs.reduce((sum, row) => sum + (row.tokens ?? 0), 0), tokensComplete: costs.every(row => row.tokensComplete === true), observations: [], actions: [] };
}
function rolloutComparisons(batch: EvolutionBatch, split: "development" | "sealed"): EvaluationComparison[] {
  return evolutionScenarios(split).map(scenario => {
    const base = batch.rollouts.filter(row => row.scenarioId === scenario.id && row.variant === "baseline");
    const candidate = batch.rollouts.filter(row => row.scenarioId === scenario.id && row.variant === "candidate");
    const baselineTokens = base.every(row => row.tokensComplete === true) ? base.reduce((total, row) => total + (row.tokens ?? 0), 0) : undefined;
    const candidateTokens = candidate.every(row => row.tokensComplete === true) ? candidate.reduce((total, row) => total + (row.tokens ?? 0), 0) : undefined;
    return { scenarioId: scenario.id, baseline: base.map(row => row.success === true), candidate: candidate.map(row => row.success === true),
      baselineCalls: base.reduce((total, row) => total + (row.modelCalls ?? row.calls), 0), candidateCalls: candidate.reduce((total, row) => total + (row.modelCalls ?? row.calls), 0),
      ...(baselineTokens === undefined ? {} : { baselineTokens }), ...(candidateTokens === undefined ? {} : { candidateTokens }), violations: candidate.filter(row => row.violation === true).length };
  });
}
function revert(state: EvolutionState, now: string): void {
  const current = state.revisions.find((r) => r.revisionId === state.activeRevisionId);
  if (current !== undefined) { current.status = "ROLLED_BACK"; current.reason = "rolled_back"; }
  const parent = state.revisions.find((r) => r.revisionId === current?.parentRevisionId && r.status === "SUPERSEDED");
  state.activeRevisionId = parent?.revisionId ?? null;
  if (parent !== undefined) parent.status = "ACTIVE";
  finishBatch(state, "rolled_back", now);
  state.paused = true;
}

export class EvolutionService {
  #running = new Set<string>();
  #recovered = new Set<string>();
  #gateSignature: string | null = null;
  /** Consecutive invalid responses across all workbenches; any other outcome resets it. In-memory on purpose: the breaker's durable effect is the paused state it writes. */
  #responseInvalidStreak = 0;
  #stepsPerHandle: number;
  constructor(private readonly dependencies: { store: EvolutionStore; model: EvolutionModel; now: () => string; id: () => string; diagnostics?: RuntimeDiagnostics; stepsPerHandle?: number }) {
    this.#stepsPerHandle = Math.max(1, dependencies.stepsPerHandle ?? EVOLUTION_MAX_STEPS_PER_HANDLE);
  }

  /**
   * Records why a batch was declined. pending() runs on every idle tick, so this emits only when
   * the signature changes: the log stays a readable trace of the gate moving instead of a flood.
   */
  #skipGate(reason: GateReason, totals?: { evaluable: number; verificationFailed: number }, workbenchCount?: number): void {
    const pool = totals ?? this.dependencies.store.evidenceTotals(this.#globalEvidenceSince());
    const workbenches = workbenchCount ?? this.dependencies.store.listWorkbenchIds().length;
    const signature = `${reason}|${String(pool.evaluable)}|${String(pool.verificationFailed)}|${String(workbenches)}`;
    if (signature === this.#gateSignature) return;
    this.#gateSignature = signature;
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.gate_skipped", {
      reason, evaluable: pool.evaluable, verificationFailed: pool.verificationFailed,
      thresholdEvaluable: EVOLUTION_EVIDENCE_THRESHOLD, thresholdFailed: EVOLUTION_FAILURE_THRESHOLD, workbenchCount: workbenches,
    });
  }

  #allRevisions(): { workbenchId: string; revision: EvolutionRevision }[] {
    return this.dependencies.store.listWorkbenchIds().flatMap((workbenchId) => this.dependencies.store.read(workbenchId).revisions.map((revision) => ({ workbenchId, revision })));
  }
  #globalRevision(status: EvolutionRevision["status"]): { workbenchId: string; revision: EvolutionRevision } | undefined {
    return this.#allRevisions().filter((entry) => entry.revision.scope === "GLOBAL" && entry.revision.status === status)
      .sort((a, b) => b.revision.createdAt.localeCompare(a.revision.createdAt))[0];
  }
  #globalEvidenceSince(): string | null {
    return this.dependencies.store.listWorkbenchIds().flatMap((id) => {
      const state = this.dependencies.store.read(id);
      const history = state.batchHistory ?? [];
      const finished = history.filter((batch) => batch.scope === "GLOBAL" && batch.finishedAt !== null && batch.reason !== "call_failed" && batch.reason !== "model_changed")
        .map((batch) => batch.finishedAt).filter((finishedAt): finishedAt is string => finishedAt !== null);
      return history.length === 0 && state.lastBatchFinishedAt !== null && state.lastBatchFinishedAt !== undefined ? [...finished, state.lastBatchFinishedAt] : finished;
    })
      .sort((a, b) => b.localeCompare(a))[0] ?? null;
  }
  #findRevision(revisionId: string | null): { workbenchId: string; revision: EvolutionRevision } | undefined {
    if (revisionId === null) return undefined;
    return this.#allRevisions().find((entry) => entry.revision.revisionId === revisionId);
  }
  #effectiveActive(workbenchId: string): { workbenchId: string; revision: EvolutionRevision } | undefined {
    const state = this.dependencies.store.read(workbenchId);
    const local = state.revisions.find((revision) => revision.revisionId === state.activeRevisionId && (revision.scope ?? "WORKBENCH") === "WORKBENCH");
    return local === undefined ? this.#globalRevision("ACTIVE") : { workbenchId, revision: local };
  }
  #applicableCanary(workbenchId: string): { workbenchId: string; revision: EvolutionRevision } | undefined {
    const local = this.dependencies.store.read(workbenchId).revisions.find((revision) => revision.status === "CANARY" && (revision.scope ?? "WORKBENCH") === "WORKBENCH");
    return local === undefined ? this.#globalRevision("CANARY") : { workbenchId, revision: local };
  }

  overview(): EvolutionOverviewDto {
    const ids = this.dependencies.store.listWorkbenchIds();
    const states = ids.map((id) => this.dependencies.store.read(id));
    const revisions = states.flatMap((state) => state.revisions);
    const pool = this.dependencies.store.evidenceTotals(this.#globalEvidenceSince());
    const current = states.flatMap((state) => state.batch === null ? [] : [batchRecord(state.batch, state.reason, null)]);
    const history = states.flatMap((state) => (state.batchHistory ?? []).map(projectBatchRecord));
    return { workbenches: ids.length, enabled: states.filter((state) => !state.paused && state.dailyCallLimit > 0).length,
      evaluating: current.length, canary: revisions.filter((revision) => revision.status === "CANARY").length,
      active: revisions.filter((revision) => revision.status === "ACTIVE").length,
      revalidationRequired: states.filter((state) => state.revalidationRequired === true).length,
      poolEvaluable: pool.evaluable, poolVerificationFailed: pool.verificationFailed,
      batches: [...current, ...history].sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt)).slice(0, 100) };
  }

  status(workbenchId: string): EvolutionStatusDto {
    let state = this.dependencies.store.read(workbenchId);
    const now = this.dependencies.now();
    if (state.runRequestedAt !== null && state.runRequestedAt !== undefined && !EvolutionService.#runNowActive(state, now)) {
      this.dependencies.store.update(workbenchId, (current) => { current.runRequestedAt = null; });
      state = this.dependencies.store.read(workbenchId);
    }
    const evidence = this.dependencies.store.evidence(workbenchId);
    const used = state.usage[dayOf(now)] ?? 0;
    // The same window #eligible uses, so the panel explains the actual gate instead of a proxy.
    const pool = this.dependencies.store.evidenceTotals(this.#globalEvidenceSince());
    const global = this.#globalRevision("ACTIVE");
    const canary = this.#applicableCanary(workbenchId);
    const effective = this.#effectiveActive(workbenchId);
    const capReached = state.batch === null && state.revisions.length >= 30;
    return { workbenchId, paused: state.paused, ...(state.failure === undefined ? {} : { failure: state.failure }), dailyCallLimit: state.dailyCallLimit, callsUsedToday: used, evidenceCount: evidence.length,
      evaluableCount: evidence.filter(evaluable).length, activeRevisionId: state.activeRevisionId,
      globalRevisionId: global?.revision.revisionId ?? null, canaryRevisionId: canary?.revision.revisionId ?? null,
      activeEffective: effective !== undefined && state.revalidationRequired !== true, revalidationRequired: state.revalidationRequired === true,
      poolEvaluable: pool.evaluable, poolVerificationFailed: pool.verificationFailed,
      reason: state.revalidationRequired === true ? "revalidation_required" : capReached ? "revision_limit_reached" : state.paused ? state.reason : state.dailyCallLimit === 0 ? "disabled" : used >= state.dailyCallLimit ? "budget_exhausted" : state.reason,
      runRequestedAt: state.runRequestedAt ?? null,
      lastVerdict: state.lastVerdict ?? null,
      currentBatch: state.batch === null ? null : batchRecord(state.batch, state.reason, null),
      batchHistory: (state.batchHistory ?? []).slice(0, 50).map(projectBatchRecord),
      versions: state.revisions.slice(-30).reverse().map(({ revisionId, parentRevisionId, module, status, scope, createdAt, reason, baselineSuccesses, candidateSuccesses, evaluatedRuns }) =>
        ({ revisionId, parentRevisionId, module, status, ...(scope === undefined ? {} : { scope }), createdAt, reason, baselineSuccesses, candidateSuccesses, evaluatedRuns })),
    };
  }
  configure(workbenchId: string, dailyCallLimit: number): EvolutionStatusDto {
    if (!Number.isInteger(dailyCallLimit) || dailyCallLimit < 0 || dailyCallLimit > 10_000) throw new DomainError("evolution_budget_invalid", "Daily call limit must be an integer between 0 and 10000.");
    this.dependencies.store.update(workbenchId, (state) => { state.dailyCallLimit = dailyCallLimit; state.paused = false; delete state.failure; if (state.reason === "disabled" || state.reason === "rolled_back" || state.reason === "model_response_invalid") state.reason = "collecting"; });
    return this.status(workbenchId);
  }
  configureGlobal(_patch: { enabled?: boolean; dailyCallLimit?: number }): EvolutionOverviewDto {
    throw new DomainError("evolution_unavailable", "Global learning settings require the current learning engine.");
  }
  configureParticipation(workbenchId: string, enabled: boolean): EvolutionStatusDto {
    return this.configure(workbenchId, enabled ? this.dependencies.store.read(workbenchId).dailyCallLimit || 150 : 0);
  }
  resumeGlobal(): EvolutionOverviewDto {
    throw new DomainError("evolution_unavailable", "Global recovery requires the current learning engine.");
  }
  resumeWorkbench(workbenchId: string): EvolutionStatusDto {
    return this.configure(workbenchId, this.dependencies.store.read(workbenchId).dailyCallLimit);
  }
  /**
   * Queue an out-of-band batch start. It bypasses the evidence gate and the once-per-day candidate
   * lock — that is the point: after a rejection consumed the trigger window, waiting weeks for new
   * failures is not the only way back. Budget, the idle slot and the revision cap still apply, and
   * the request expires so a workbench stuck non-idle cannot accumulate a permanent bypass.
   */
  requestRun(workbenchId: string): EvolutionStatusDto {
    const now = this.dependencies.now();
    // Both guards run inside the write transaction so the check and the write cannot be split. A
    // batch in flight refuses the request rather than queueing it: the batch-creation branch in
    // #step is the only place that clears a request, so one set now would survive that batch's
    // verdict and start a second batch on the same day.
    this.dependencies.store.update(workbenchId, (state) => {
      if (state.paused || state.dailyCallLimit === 0) throw new DomainError("evolution_run_now_invalid", "Evolution is paused or disabled; re-enable it before requesting a run.");
      if (state.batch !== null) throw new DomainError("evolution_run_now_invalid", "A batch is already in flight; wait for its verdict before requesting another run.");
      if (state.revisions.length >= 30) { state.reason = "revision_limit_reached"; throw new DomainError("evolution_revision_limit", "The evolution revision limit has been reached."); }
      state.runRequestedAt = now;
    });
    return this.status(workbenchId);
  }
  rollback(workbenchId: string, revisionId: string): EvolutionStatusDto {
    const now = this.dependencies.now();
    const owner = this.#findRevision(revisionId);
    if (owner?.revision.status === "ROLLED_BACK") return this.status(workbenchId);
    if (owner?.revision.scope === "GLOBAL") {
      if (owner.revision.status !== "ACTIVE") throw new DomainError("evolution_revision_stale", "The active strategy has changed.");
      const parent = this.#findRevision(owner.revision.parentRevisionId);
      this.dependencies.store.update(owner.workbenchId, (state) => {
        const current = required(state.revisions.find((revision) => revision.revisionId === revisionId));
        current.status = "ROLLED_BACK"; current.reason = "rolled_back";
        if (parent?.workbenchId === owner.workbenchId && parent.revision.status === "SUPERSEDED") {
          const previous = state.revisions.find((revision) => revision.revisionId === parent.revision.revisionId);
          if (previous !== undefined) previous.status = "ACTIVE";
        }
        finishBatch(state, "rolled_back", now);
        state.paused = true; state.revalidationRequired = false;
      });
      if (parent !== undefined && parent.workbenchId !== owner.workbenchId && parent.revision.status === "SUPERSEDED") {
        this.dependencies.store.update(parent.workbenchId, (state) => {
          const previous = state.revisions.find((revision) => revision.revisionId === parent.revision.revisionId);
          if (previous !== undefined) previous.status = "ACTIVE";
        });
      }
      if (workbenchId !== owner.workbenchId) this.dependencies.store.update(workbenchId, (state) => { state.paused = true; state.reason = "rolled_back"; });
      return this.status(workbenchId);
    }
    this.dependencies.store.update(workbenchId, (state) => {
      if (state.revisions.some((r) => r.revisionId === revisionId && r.status === "ROLLED_BACK")) return;
      if (state.activeRevisionId !== revisionId) throw new DomainError("evolution_revision_stale", "The active strategy has changed.");
      revert(state, now);
    });
    return this.status(workbenchId);
  }
  negativeFeedback(workbenchId: string, goalId: string): EvolutionStatusDto {
    const revision = this.dependencies.store.goalRevision(workbenchId, goalId);
    if (revision === undefined) throw new DomainError("evolution_goal_invalid", "Goal does not belong to this workbench.");
    const owner = this.#findRevision(revision);
    if (owner?.revision.status === "CANARY") {
      const now = this.dependencies.now();
      this.dependencies.store.update(owner.workbenchId, (state) => {
        const candidate = required(state.revisions.find((entry) => entry.revisionId === revision));
        candidate.status = "REJECTED"; candidate.reason = "rolled_back"; state.reason = "rolled_back";
        state.lastVerdict = { reason: "rolled_back", at: now, baselineSuccesses: candidate.baselineSuccesses, candidateSuccesses: candidate.candidateSuccesses, evaluatedRuns: candidate.evaluatedRuns };
      });
      return this.status(workbenchId);
    }
    if (owner?.revision.status === "ACTIVE") {
      if (owner.revision.scope === "GLOBAL") {
        return this.rollback(workbenchId, owner.revision.revisionId);
      }
      return this.rollback(owner.workbenchId, revision ?? "");
    }
    return this.status(workbenchId);
  }
  emergencyStop(): void {
    for (const id of this.dependencies.store.listWorkbenchIds()) this.dependencies.store.update(id, (state) => { state.dailyCallLimit = 0; state.paused = true; state.reason = "disabled"; });
  }
  park(inputId: string): void {
    const id = inputId.slice("evolution:".length);
    const now = this.dependencies.now();
    if (this.dependencies.store.listWorkbenchIds().includes(id)) this.dependencies.store.update(id, (state) => { state.paused = true; finishBatch(state, "call_failed", now); });
  }
  canceled(inputId: string): boolean {
    const id = inputId.slice("evolution:".length);
    if (!this.dependencies.store.listWorkbenchIds().includes(id)) return true;
    const state = this.dependencies.store.read(id);
    return state.paused || state.dailyCallLimit === 0;
  }
  strategyForGoal(workbenchId: string, goalId: string, pin?: EvolutionSourcePin, _context?: { requirementsReady: boolean; requirementCount: number }): { strategyRevisionId: string | null; instructions: string } {
    const active = this.#effectiveActive(workbenchId);
    const canary = this.#applicableCanary(workbenchId);
    const selected = canary !== undefined && canaryBucket(goalId) ? canary : active;
    if (selected !== undefined && !compatible(selected.revision, pin)) {
      this.dependencies.store.update(selected.workbenchId, (state) => { state.revalidationRequired = true; state.reason = "revalidation_required"; });
      if (selected.workbenchId !== workbenchId) this.dependencies.store.update(workbenchId, (state) => { state.revalidationRequired = true; state.reason = "revalidation_required"; });
    }
    const chosen = selected !== undefined && compatible(selected.revision, pin) ? selected.revision.revisionId : null;
    const revisionId = this.dependencies.store.bindGoal(workbenchId, goalId, chosen, pin);
    const strategy = this.#findRevision(revisionId)?.revision.strategy ?? baselineStrategy;
    return { strategyRevisionId: revisionId, instructions: composeStrategyInstructions(strategy) };
  }
  scan(): void {
    const seeds = this.dependencies.store.evidenceSeeds();
    // One lookup per affected workbench, so the diagnostic can tell a first classification from an
    // upgrade of an earlier, weaker one. Skipped entirely when there is nothing to classify.
    const previous = new Map<string, Map<string, string>>();
    for (const workbenchId of new Set(seeds.map((seed) => seed.workbenchId))) {
      previous.set(workbenchId, new Map(this.dependencies.store.evidence(workbenchId).map((entry) => [entry.goalId, entry.outcome])));
    }
    for (const seed of seeds) {
      // An objective verification failure outranks a revocation. A goal the user abandoned after its
      // acceptance checks kept failing is the strongest orchestration signal we have, and ranking the
      // revocation first would make the classification depend on whether the goal was sampled before
      // or after it was revoked. Revoked goals are exactly where those failures concentrate.
      const outcome: EvolutionEvidence["outcome"] = seed.failed > 0 ? "VERIFICATION_FAILED"
        : seed.canceled ? "CANCELED"
          : seed.disposition === "ACCEPTED_WITH_GAPS" ? "ACCEPTED_WITH_GAPS"
            : seed.workFailed > 0 ? "ENVIRONMENT_FAILED"
              : seed.verified > 0 && seed.unverified === 0 && seed.disposition === "COMPLETED" ? "VERIFIED" : "UNEVALUABLE";
      const cause: EvolutionEvidence["cause"] = outcome === "VERIFICATION_FAILED"
        ? seed.disposition === "COMPLETED" || seed.disposition === "ACCEPTED_WITH_GAPS" ? "completion" : "execution"
        : outcome === "ENVIRONMENT_FAILED" ? "environment" : "none";
      const persisted = this.dependencies.store.recordEvidence({ goalId: seed.goalId, workbenchId: seed.workbenchId, observedAt: seed.observedAt, outcome, cause,
        revisionId: this.dependencies.store.goalRevision(seed.workbenchId, seed.goalId) ?? null });
      const before = previous.get(seed.workbenchId)?.get(seed.goalId);
      // Report the classification that was actually stored, and only when it is news: a re-scan that
      // merely refreshes the idempotence guard, or one whose upgrade was refused, logs nothing.
      if (persisted === null || persisted === before) continue;
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.evidence_recorded",
        { goalInputId: seed.goalId, workbenchId: seed.workbenchId, outcome: persisted, ...(before === undefined ? {} : { previousOutcome: before }) });
    }
    for (const id of this.dependencies.store.listWorkbenchIds()) {
      const state = this.dependencies.store.read(id);
      if (!this.#recovered.has(id)) {
        this.#recovered.add(id);
        if (state.call !== null && state.call.state !== "DONE" && !this.#running.has(id)) this.dependencies.store.update(id, (s) => {
          // Unknown provider consumption remains charged. A restart never reuses a claimed call.
          required(s.call).state = "DONE";
          if (s.batch !== null) s.batch.tokensComplete = false;
          // Restart just the interrupted simulation attempt; completed trials remain reusable.
          // The abandoned request remains charged in the daily ledger and the outbox.
          discardInterruptedRollout(s.batch, true);
          s.reason = "call_failed";
        });
      }
      if (state.activeRevisionId === null) continue;
      const active = state.revisions.find((r) => r.revisionId === state.activeRevisionId);
      if (active === undefined || active.monitoredGoals.length >= 10) continue;
      const first = this.dependencies.store.evidence(id).filter((e) => e.revisionId === state.activeRevisionId && evaluable(e) && !active.monitoredGoals.includes(e.goalId))
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.goalId.localeCompare(b.goalId)).slice(0, 10 - active.monitoredGoals.length);
      if (first.length === 0) continue;
      // A single unlucky failure must not kill a fresh strategy; the elimination line is cumulative
      // across the whole monitored window. Counted outside the transaction from the persisted
      // classifications, so the read does not nest inside the store's write transaction.
      const monitored = [...active.monitoredGoals, ...first.map((e) => e.goalId)];
      const failing = this.dependencies.store.evidence(id).filter((e) => monitored.includes(e.goalId) && e.outcome === "VERIFICATION_FAILED").length;
      this.dependencies.store.update(id, (s) => {
        required(s.revisions.find((r) => r.revisionId === s.activeRevisionId)).monitoredGoals.push(...first.map((e) => e.goalId));
        if (failing >= EVOLUTION_MONITOR_REVERT_THRESHOLD) revert(s, this.dependencies.now());
      });
      if (failing > 0 && failing < EVOLUTION_MONITOR_REVERT_THRESHOLD) {
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.monitor_warning",
          { workbenchId: id, failedCount: failing, threshold: EVOLUTION_MONITOR_REVERT_THRESHOLD });
      }
    }
    for (const { workbenchId, revision } of this.#allRevisions().filter(({ revision }) => revision.scope === "GLOBAL" && revision.status === "ACTIVE")) {
      const recent = this.dependencies.store.listWorkbenchIds().flatMap((id) => this.dependencies.store.evidence(id))
        .filter((e) => e.revisionId === revision.revisionId && evaluable(e) && e.observedAt > revision.createdAt)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.goalId.localeCompare(b.goalId)).slice(0, 10);
      const failures = recent.filter((e) => e.outcome === "VERIFICATION_FAILED").length;
      this.dependencies.store.update(workbenchId, (state) => {
        required(state.revisions.find((entry) => entry.revisionId === revision.revisionId)).monitoredGoals = recent.map((e) => e.goalId);
      });
      if (failures >= EVOLUTION_MONITOR_REVERT_THRESHOLD) this.rollback(workbenchId, revision.revisionId);
    }
    this.#advanceCanaries();
  }

  #advanceCanaries(): void {
    const ids = this.dependencies.store.listWorkbenchIds();
    const actions: { owner: string; revisionId: string; promote: boolean }[] = [];
    for (const owner of ids) {
      const state = this.dependencies.store.read(owner);
      for (const revision of state.revisions.filter((entry) => entry.status === "CANARY")) {
        const sourceIds = revision.scope === "GLOBAL" ? ids : [owner];
        const evidence = sourceIds.flatMap((id) => this.dependencies.store.evidence(id))
          .filter((entry) => evaluable(entry) && entry.observedAt > revision.createdAt);
        const candidates = evidence.filter((entry) => entry.revisionId === revision.revisionId).slice(0, 5);
        const controls = evidence.filter((entry) => entry.revisionId !== revision.revisionId).slice(0, 5);
        this.dependencies.store.update(owner, (current) => {
          const live = required(current.revisions.find((entry) => entry.revisionId === revision.revisionId));
          live.monitoredGoals = candidates.map((entry) => entry.goalId);
          live.controlGoals = controls.map((entry) => entry.goalId);
        });
        const candidateFailures = candidates.filter((entry) => entry.outcome === "VERIFICATION_FAILED").length;
        const controlFailures = controls.filter((entry) => entry.outcome === "VERIFICATION_FAILED").length;
        if (candidateFailures >= EVOLUTION_MONITOR_REVERT_THRESHOLD) actions.push({ owner, revisionId: revision.revisionId, promote: false });
        else if (candidates.length >= 5 && controls.length >= 5) actions.push({ owner, revisionId: revision.revisionId, promote: candidateFailures <= controlFailures });
      }
    }
    for (const action of actions) {
      if (action.promote) this.#promoteCanary(action.owner, action.revisionId);
      else this.#rejectCanary(action.owner, action.revisionId);
    }
  }

  #rejectCanary(owner: string, revisionId: string): void {
    const now = this.dependencies.now();
    this.dependencies.store.update(owner, (state) => {
      const revision = state.revisions.find((entry) => entry.revisionId === revisionId);
      if (revision?.status !== "CANARY") return;
      revision.status = "REJECTED"; revision.reason = "quality_regression"; state.reason = "quality_regression";
      state.lastVerdict = { reason: "quality_regression", at: now, baselineSuccesses: revision.baselineSuccesses, candidateSuccesses: revision.candidateSuccesses, evaluatedRuns: revision.evaluatedRuns };
    });
  }

  #promoteCanary(owner: string, revisionId: string): void {
    const now = this.dependencies.now();
    const target = this.dependencies.store.read(owner).revisions.find((entry) => entry.revisionId === revisionId);
    if (target?.status !== "CANARY") return;
    if (target.scope === "GLOBAL") {
      for (const id of this.dependencies.store.listWorkbenchIds()) this.dependencies.store.update(id, (state) => {
        for (const revision of state.revisions) if (revision.scope === "GLOBAL" && revision.status === "ACTIVE") revision.status = "SUPERSEDED";
        state.revalidationRequired = false;
      });
    }
    this.dependencies.store.update(owner, (state) => {
      const revision = required(state.revisions.find((entry) => entry.revisionId === revisionId));
      if ((revision.scope ?? "WORKBENCH") === "WORKBENCH") {
        const parent = state.revisions.find((entry) => entry.revisionId === state.activeRevisionId);
        if (parent !== undefined) parent.status = "SUPERSEDED";
        state.activeRevisionId = revisionId;
      }
      revision.status = "ACTIVE"; revision.reason = "promoted"; state.reason = "promoted"; state.revalidationRequired = false;
      state.lastVerdict = { reason: "promoted", at: now, baselineSuccesses: revision.baselineSuccesses, candidateSuccesses: revision.candidateSuccesses, evaluatedRuns: revision.evaluatedRuns };
    });
  }
  pending(): { inputId: string; createdAt: string }[] {
    const workbenchIds = this.dependencies.store.listWorkbenchIds();
    if (!this.dependencies.store.idle()) { this.#skipGate("not_idle", undefined, workbenchIds.length); return []; }
    const now = this.dependencies.now();
    for (const id of workbenchIds) {
      const state = this.dependencies.store.read(id);
      if (state.runRequestedAt !== null && state.runRequestedAt !== undefined && !EvolutionService.#runNowActive(state, now)) {
        this.dependencies.store.update(id, (current) => { current.runRequestedAt = null; });
      }
    }
    // One query per tick, passed down: reading it inside #eligible would re-parse every state's JSON
    // on every check.
    const globalCandidateDay = this.dependencies.store.lastCandidateDay();
    const candidates = workbenchIds.filter((id) => this.#eligible(id, globalCandidateDay));
    if (candidates.length === 0) {
      // The pool is shared, so a single query explains why every workbench declined. Distinguish
      // "not enough evidence yet" from "enough evidence, but every workbench is out of budget,
      // parked, or already proposed today" — they need completely different responses.
      const totals = this.dependencies.store.evidenceTotals(this.#globalEvidenceSince());
      this.#skipGate(totals.verificationFailed >= EVOLUTION_FAILURE_THRESHOLD && totals.evaluable >= EVOLUTION_EVIDENCE_THRESHOLD
        ? "no_candidate" : "evidence_below_threshold", totals, workbenchIds.length);
      return [];
    }
    this.#gateSignature = null;
    // An explicit run-now request outranks the evidence-weighted pick: the user asked for this
    // workbench, and the weighted choice could otherwise starve it behind a stronger signal.
    const requested = candidates.filter((id) => EvolutionService.#runNowActive(this.dependencies.store.read(id), now));
    const pool = requested.length > 0 ? requested : candidates;
    // The trigger pool is global but the revision lands on one workbench, so prefer the workbench
    // whose own goals contributed most to the signal. Tie-break on the id to keep the pick
    // deterministic across restarts.
    // `pool` is non-empty here, so reduce without a seed is total and needs no assertion.
    const strongest = pool
      .map((id) => ({ id, weight: this.dependencies.store.evidence(id).filter(evaluable).length }))
      .reduce((best, entry) => (entry.weight > best.weight
        || (entry.weight === best.weight && entry.id.localeCompare(best.id) < 0) ? entry : best));
    return [{ inputId: `evolution:${strongest.id}`, createdAt: now }];
  }
  /** A run-now request counts only while it is younger than its TTL; older ones are dead letters. */
  static #runNowActive(state: EvolutionState, now: string): boolean {
    const requestedAt = state.runRequestedAt;
    if (requestedAt === null || requestedAt === undefined) return false;
    return Date.parse(now) - Date.parse(requestedAt) <= EVOLUTION_RUN_NOW_TTL_MILLIS;
  }
  #eligible(id: string, globalCandidateDay: string | null): boolean {
    const state = this.dependencies.store.read(id);
    const now = this.dependencies.now();
    const day = dayOf(now);
    if (state.paused || state.dailyCallLimit === 0 || (state.usage[day] ?? 0) >= state.dailyCallLimit || this.#running.has(id)) return false;
    if (state.parkedDay === day) return false;
    if (state.batch !== null) return true;
    if (state.revisions.length >= 30) return false;
    const requested = EvolutionService.#runNowActive(state, now);
    // The ADR allows one candidate per day in total, not one per workbench: the first workbench to
    // open a batch today takes the whole day's slot, so a failing candidate no longer burns a call
    // on every remaining workbench. An explicit run-now bypasses both this lock and the evidence
    // gate; the revision cap and the budget checks above still apply.
    if (!requested && globalCandidateDay === day) return false;
    if (requested) return true;
    // A verdict consumes its trigger: only evidence observed after the last verdict starts a new
    // batch, so historical failures the pipeline already addressed never re-run evaluation daily.
    // The pool spans every workbench (see evidenceTotals); this workbench's own verdict is the
    // window, because that is the point before which its strategy was already judged.
    const local = this.#globalRevision("ACTIVE") === undefined ? null : this.dependencies.store.evidenceTotals(state.lastBatchFinishedAt ?? null, id);
    if (local !== null && local.evaluable >= EVOLUTION_EVIDENCE_THRESHOLD && local.verificationFailed >= EVOLUTION_FAILURE_THRESHOLD) return true;
    const totals = this.dependencies.store.evidenceTotals(this.#globalEvidenceSince());
    return totals.evaluable >= EVOLUTION_EVIDENCE_THRESHOLD && totals.verificationFailed >= EVOLUTION_FAILURE_THRESHOLD;
  }
  /**
   * Advances the batch by up to stepsPerHandle bounded calls instead of exactly one: a batch needs
   * hundreds of calls, and at the scheduler's 2s cadence a strict one-call-per-handle budget only
   * ever completes on workbenches that stay idle for weeks. Every step re-checks idleness, so a
   * user task arriving mid-handle takes the slot back at the next step boundary.
   */
  async handle(inputId: string, signal?: AbortSignal): Promise<void> {
    if (!inputId.startsWith("evolution:")) return;
    const id = inputId.slice("evolution:".length);
    // Re-checked after pending() rather than trusted from it: a user task can arrive on the same
    // tick, and user input always wins the single slot.
    if (signal?.aborted === true) { this.#skipGate("aborted"); return; }
    if (!this.dependencies.store.idle()) { this.#skipGate("not_idle"); return; }
    const globalCandidateDay = this.dependencies.store.lastCandidateDay();
    if (!this.#eligible(id, globalCandidateDay)) { this.#skipGate("no_candidate"); return; }
    this.#running.add(id);
    this.#recovered.add(id);
    const startedAt = Date.now();
    try {
      for (let step = 0; step < this.#stepsPerHandle; step += 1) {
        // The first step runs unconditionally: the entry checks above already passed #eligible, and
        // the batch it may create does not exist yet, so a continuation check would block it.
        if (step > 0 && !this.#mayContinue(id, signal, startedAt)) break;
        // A step that could not claim a call (verdict reached, budget gone, day rolled over) ends
        // the handle; there is nothing left to advance inside it.
        if (!await this.#step(id, signal)) break;
      }
    } catch (error) {
      this.dependencies.store.update(id, (state) => { this.#failStep(state, dayOf(this.dependencies.now())); });
      this.#emitCallFailure(id, null, error);
    } finally { this.#running.delete(id); }
  }
  /**
   * The handle's own continuation gate. Deliberately not #eligible: that method checks #running,
   * which this handle is holding. Steps stop at the batch's end, the day's budget, an incoming user
   * task (idle() covers pending inputs and running turns), the wall-clock budget kept well under the
   * scheduler's 15-minute stalled-turn watchdog, or an abort.
   */
  #mayContinue(id: string, signal: AbortSignal | undefined, startedAt: number): boolean {
    if (signal?.aborted === true) return false;
    if (Date.now() - startedAt > EVOLUTION_HANDLE_TIME_BUDGET_MS) return false;
    if (!this.dependencies.store.idle()) return false;
    const now = this.dependencies.now();
    const day = dayOf(now);
    const state = this.dependencies.store.read(id);
    if (state.paused || state.dailyCallLimit === 0 || (state.usage[day] ?? 0) >= state.dailyCallLimit) return false;
    if (state.parkedDay === day) return false;
    return state.batch !== null;
  }
  /** Read back after the transaction commits, so the log reflects persisted state. */
  #emitCallFailure(id: string, callId: string | null, error: unknown, pin?: EvolutionSourcePin): void {
    const state = this.dependencies.store.read(id);
    const detail = runtimeDiagnosticErrorDetail(error);
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.call_failed", {
      workbenchId: id, callId: callId ?? "unknown", consecutiveFailures: state.callFailures ?? 0,
      parkedDay: state.parkedDay ?? dayOf(this.dependencies.now()),
      errorKind: runtimeDiagnosticErrorCode(error),
      ...(pin ?? {}),
      ...(error instanceof EvolutionModelCallError ? { failure: error.failure } : {}),
      ...(detail === undefined ? {} : { errorDetail: detail }),
    });
  }
  /**
   * Infrastructure failure semantics match crash recovery: keep the batch and every completed
   * trial, drop only the interrupted attempt, park for the UTC day, and abandon the batch only
   * after MAX_CONSECUTIVE_CALL_FAILURES consecutive failures. A successful call resets the count.
   */
  #failStep(state: EvolutionState, day: string): void {
    if (state.call !== null && state.call.state !== "DONE") state.call.state = "DONE";
    state.parkedDay = day;
    state.reason = "call_failed";
    state.callFailures = (state.callFailures ?? 0) + 1;
    if (state.batch === null) { state.lastCandidateDay = day; return; }
    discardInterruptedRollout(state.batch);
    if ((state.callFailures ?? 0) >= MAX_CONSECUTIVE_CALL_FAILURES) finishBatch(state, "call_failed", this.dependencies.now());
  }
  /** Claims one bounded call, runs it and accepts the result. True when a call was actually issued. */
  async #step(id: string, signal?: AbortSignal): Promise<boolean> {
    const pin = await this.dependencies.model.pin();
    if (signal?.aborted === true || !this.dependencies.store.idle()) return false;
    const now = this.dependencies.now();
    const day = dayOf(now);
    const evidenceIds = this.dependencies.store.evidence(id).filter(evaluable).slice(0, 30).map((e) => e.goalId);
    const snapshot = this.dependencies.store.read(id);
    let scope: EvolutionScope = "GLOBAL";
    let effectiveParent: { workbenchId: string; revision: EvolutionRevision } | undefined;
    let baseline = baselineStrategy;
    let cacheKey = "";
    let sharedBaseline: EvolutionRollout[] | undefined;
    if (snapshot.batch === null) {
      const globalActive = this.#globalRevision("ACTIVE");
      const requested = EvolutionService.#runNowActive(snapshot, now);
      const localTotals = this.dependencies.store.evidenceTotals(snapshot.lastBatchFinishedAt ?? null, id);
      scope = globalActive !== undefined && compatible(globalActive.revision, pin)
        && (requested || (localTotals.evaluable >= EVOLUTION_EVIDENCE_THRESHOLD && localTotals.verificationFailed >= EVOLUTION_FAILURE_THRESHOLD)) ? "WORKBENCH" : "GLOBAL";
      effectiveParent = scope === "GLOBAL" ? globalActive : this.#effectiveActive(id);
      baseline = effectiveParent !== undefined && compatible(effectiveParent.revision, pin) ? effectiveParent.revision.strategy : baselineStrategy;
      cacheKey = baselineCacheKeyFor(EVOLUTION_EVALUATOR_VERSION, pin, baseline);
      sharedBaseline = this.dependencies.store.listWorkbenchIds().map((workbenchId) => this.dependencies.store.read(workbenchId).sealedBaselineCache?.[cacheKey])
        .find((rollouts) => rollouts !== undefined);
    }
    const call = this.dependencies.store.update(id, (state) => {
      if (state.paused || (state.usage[day] ?? 0) >= state.dailyCallLimit) return null;
      if (state.batch === null) {
        // A pending run-now request also bypasses the once-per-day candidate lock here: the gate
        // above already admitted it, and a request that could not actually start a batch would be
        // silently swallowed by this check on a day when a batch already ran.
        const requested = state.runRequestedAt !== null && state.runRequestedAt !== undefined;
        if (state.lastCandidateDay === day && !requested) return null;
        const batchId = this.dependencies.id();
        state.batch = { id: batchId, startedAt: now, workbenchId: id, scope, calls: 0, tokens: 0, tokensComplete: true, evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, parentStrategy: baseline, parentRevisionId: effectiveParent?.revision.revisionId ?? null, strategy: baseline, pin, phase: "DEVELOP", evidenceIds, rollouts: [] };
        if (sharedBaseline !== undefined) state.sealedBaselineCache = { ...(state.sealedBaselineCache ?? {}), [cacheKey]: structuredClone(sharedBaseline) };
        state.lastCandidateDay = day;
        // The run-now request is consumed by the batch it started; the response streak belongs to
        // the previous batch and says nothing about the new one.
        state.runRequestedAt = null;
        state.responseInvalidStreak = 0;
        delete state.failure;
      }
      if (JSON.stringify(state.batch.pin) !== JSON.stringify(pin) || state.batch.evaluatorVersion !== EVOLUTION_EVALUATOR_VERSION) { finishBatch(state, "model_changed", now); return null; }
      const batch = state.batch;
      // A batch resumed across midnight consumes the proposal day's candidate slot too.
      if (batch.phase === "PROPOSE") state.lastCandidateDay = day;
      if (batch.phase !== "PROPOSE") this.#ensureRollout(batch);
      const run = batch.phase === "PROPOSE" ? undefined : batch.rollouts.at(-1);
      if (run !== undefined) run.modelCalls = (run.modelCalls ?? run.calls) + 1;
      state.callSequence += 1;
      batch.calls = (batch.calls ?? 0) + 1;
      const callId = `${batch.id}:call:${String(state.callSequence)}`;
      state.usage[day] = (state.usage[day] ?? 0) + 1;
      const cutoff = new Date(Date.parse(now) - 32 * 86_400_000).toISOString().slice(0, 10);
      state.usage = Object.fromEntries(Object.entries(state.usage).filter(([key]) => key >= cutoff));
      state.call = { id: callId, state: "PENDING", createdAt: now };
      state.reason = "evaluating";
      return { batch: structuredClone(batch), experiences: state.experiences ?? [], id: callId };
    });
    if (call === null) return false;
    this.dependencies.store.update(id, (state) => { required(state.call).state = "RUNNING"; });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.batch_step_started",
      { workbenchId: id, batchId: call.batch.id, callId: call.id, phase: call.batch.phase });
    let returnedTokens: number | null = null;
    try {
      const prompt = call.batch.phase === "PROPOSE" ? this.#proposalPrompt(call.batch, call.experiences) : this.#simulationPrompt(call.batch);
      const raw = await this.dependencies.model.call({ pin, ...prompt, workbenchId: id, idempotencyId: call.id, ...(signal === undefined ? {} : { signal }) });
      const result = modelResult(raw);
      returnedTokens = result.tokens;
      const stillPinned = JSON.stringify(await this.dependencies.model.pin()) === JSON.stringify(pin);
      this.dependencies.store.update(id, (state) => {
        if (state.call?.id !== call.id || state.call.state === "DONE") return;
        state.call.state = "DONE";
        chargeCallTokens(state, call.batch.id, result.tokens);
        state.callFailures = 0;
        state.responseInvalidStreak = 0;
        delete state.failure;
        if (state.batch?.id !== call.batch.id || state.paused || state.dailyCallLimit === 0) return;
        delete state.batch.failure;
        if (!stillPinned) { finishBatch(state, "model_changed", now); return; }
        if (call.batch.phase === "PROPOSE") this.#acceptProposal(state, result.value, now);
        else this.#acceptSimulation(state, result.value, now, result.tokens);
      });
      this.#responseInvalidStreak = 0;
    } catch (error) {
      const kind = EvolutionService.#classifyStepFailure(error, signal);
      let consecutive = 0;
      const handled = this.dependencies.store.update(id, (state) => {
        if (state.call?.id !== call.id || state.call.state === "DONE") return false;
        state.call.state = "DONE";
        const tokens = error instanceof EvolutionModelCallError ? error.tokens : returnedTokens;
        chargeCallTokens(state, call.batch.id, tokens);
        if (state.batch?.id !== call.batch.id) return false;
        if (error instanceof EvolutionModelCallError) { state.failure = error.failure; state.batch.failure = error.failure; }
        else { delete state.failure; delete state.batch.failure; }
        const interrupted = state.batch.phase === "PROPOSE" ? undefined : state.batch.rollouts.at(-1);
        if (interrupted !== undefined) {
          if (tokens === null) interrupted.tokensComplete = false;
          else interrupted.tokens = (interrupted.tokens ?? 0) + tokens;
        }
        if (kind === "response_invalid") {
          // The provider answered, so the call was consumed — but this is a model-quality signal,
          // not an infrastructure fault: retry the same rollout tomorrow-grade rather than parking
          // the day, and only abandon the batch after the retry limit.
          state.responseInvalidStreak = (state.responseInvalidStreak ?? 0) + 1;
          consecutive = state.responseInvalidStreak;
          if (state.responseInvalidStreak >= EVOLUTION_RESPONSE_INVALID_RETRY_LIMIT) finishBatch(state, "model_response_invalid", now);
        } else if (kind === "aborted") {
          state.responseInvalidStreak = 0;
          // Crash-recovery semantics: keep the batch and every completed trial, drop only the
          // interrupted attempt, and leave parkedDay and callFailures alone — a user cancelling
          // must not cost the workbench its daily candidate.
          discardInterruptedRollout(state.batch);
          state.reason = "call_failed";
        } else {
          state.responseInvalidStreak = 0;
          this.#failStep(state, day);
        }
        return true;
      });
      if (!handled) return true;
      if (kind === "response_invalid") {
        this.#responseInvalidStreak += 1;
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.response_invalid",
          { workbenchId: id, callId: call.id, consecutive, ...pin,
            ...(error instanceof EvolutionModelCallError ? { failure: error.failure } : {}) });
        if (this.#responseInvalidStreak >= EVOLUTION_RESPONSE_INVALID_BREAKER_LIMIT) this.#tripBreaker();
      } else {
        this.#responseInvalidStreak = 0;
        this.#emitCallFailure(id, call.id, error, pin);
      }
    }
    return true;
  }
  static #classifyStepFailure(error: unknown, signal: AbortSignal | undefined): "response_invalid" | "aborted" | "infra" {
    if (signal?.aborted === true) return "aborted";
    if (error instanceof EvolutionModelCallError && error.failure.kind === "aborted") return "aborted";
    if (error instanceof DomainError && error.code === "evolution_response_invalid") return "response_invalid";
    if (error instanceof Error && error.name === "AbortError") return "aborted";
    return "infra";
  }
  /**
   * Too many consecutive invalid responses across every workbench mean the pinned model cannot meet
   * the evaluation contract at all; continuing would just keep paying for rejections. Pausing is the
   * durable effect (it survives restarts); recovery is a manual configure() once the model source
   * has been fixed, or run-now afterwards.
   */
  #tripBreaker(): void {
    this.#responseInvalidStreak = 0;
    const now = this.dependencies.now();
    let paused = 0;
    for (const id of this.dependencies.store.listWorkbenchIds()) {
      this.dependencies.store.update(id, (state) => {
        // Only a batch in flight has a verdict to record. Finishing a batch-less state would stamp
        // its evidence trigger with no verdict behind it, discarding the backlog it accumulated
        // before the breaker tripped — so a workbench re-enabled through configure() would sit idle
        // waiting for fresh failures instead of resuming on the ones it already had.
        if (state.batch === null) state.reason = "model_response_invalid";
        else finishBatch(state, "model_response_invalid", now);
        state.paused = true;
        state.responseInvalidStreak = 0;
        paused += 1;
      });
    }
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.breaker_tripped",
      { consecutive: EVOLUTION_RESPONSE_INVALID_BREAKER_LIMIT, pausedWorkbenches: paused });
  }
  #ensureRollout(batch: EvolutionBatch): void {
    if (batch.rollouts.at(-1)?.success === undefined && batch.rollouts.length > 0) return;
    const scenarios = evolutionScenarios(batch.phase === "EVALUATE" ? "sealed" : "development");
    if (batch.phase === "EVALUATE") {
      for (const scenario of scenarios) {
        const rows = batch.rollouts.filter((row) => row.scenarioId === scenario.id);
        const baseline = rows.filter((row) => row.variant === "baseline");
        const candidate = rows.filter((row) => row.variant === "candidate");
        if (baseline.length < 3) { batch.rollouts.push(newRollout(batch, scenario.id, "baseline", baseline.length)); return; }
        if (candidate.length < 3) { batch.rollouts.push(newRollout(batch, scenario.id, "candidate", candidate.length)); return; }
      }
      throw new DomainError("evolution_evaluation_invalid", "Evaluation cursor is invalid.");
    }
    const completed = batch.phase === "DEVELOP" ? batch.rollouts.length : batch.rollouts.filter((r) => r.scenarioId.startsWith("development:") && r.variant === "candidate").length;
    const scenario = scenarios[Math.floor(completed / 3)];
    if (scenario === undefined) throw new DomainError("evolution_evaluation_invalid", "Evaluation cursor is invalid.");
    batch.rollouts.push(newRollout(batch, scenario.id, batch.phase === "VALIDATE" ? "candidate" : "baseline", completed % 3));
  }
  #proposalPrompt(batch: EvolutionBatch, experiences: EvolutionExperience[]): { mode: "proposal"; prompt: string; systemPrompt: string } {
    const relevant = selectEvolutionExperiences(experiences, { sourcePin: JSON.stringify(batch.pin), evaluatorVersion: batch.evaluatorVersion,
      parentStrategy: batch.parentStrategy, failedScenarioIds: batch.rollouts.filter(row => row.scenarioId.startsWith("development:") && row.success === false).map(row => row.scenarioId) });
    // Only development traces go to the proposer. Sealed verdicts and bodies never do.
    return { mode: "proposal", systemPrompt: "Propose one bounded joi strategy change. Compare successes and failures for the SAME development scenario, then aggregate recurring deficiencies across scenarios. Experiences are conditional synthetic development comparisons, including counterexamples; they establish neither sealed nor production correctness. No code, free-form instructions, task answers or new permissions. Change exactly one module. Report fixes and risks as development scenario IDs only.",
      prompt: JSON.stringify({ parent: batch.strategy, modes: { context: ["baseline", "requirements_first", "open_questions_first"], completion: ["baseline", "evidence_matrix", "contradiction_check"] }, evidenceCount: batch.evidenceIds.length,
        experiences: relevant,
        development: batch.rollouts.filter((r) => r.scenarioId.startsWith("development:")).map((r) => ({ scenarioId: r.scenarioId, success: r.success, calls: r.modelCalls ?? r.calls, tokens: r.tokensComplete === true ? r.tokens ?? 0 : null, actions: r.actions, observations: r.observations })) }) };
  }
  #simulationPrompt(batch: EvolutionBatch): { mode: "simulation"; prompt: string; systemPrompt: string } {
    const run = required(batch.rollouts.at(-1));
    const scenario = required(evolutionScenarios(run.scenarioId.startsWith("sealed:") ? "sealed" : "development").find((s) => s.id === run.scenarioId));
    const strategy = run.variant === "candidate" ? batch.strategy : batch.parentStrategy;
    return { mode: "simulation", systemPrompt: `${buildJoiSystemPrompt({ workbenchName: "Evaluation", personaSummary: "", projectLabel: "", scopeSummary: "Synthetic evaluation only", taskContextSummary: "Only this current synthetic goal." })}\n${composeStrategyInstructions(strategy)}\nThis is an isolated completion-decision simulation. Only read_evidence and finish exist. Do not invoke production tools.`,
      prompt: `${scenarioPrompt(scenario)}\nObserved evidence:\n${run.observations.join("\n")}\nPrevious actions: ${run.actions.join(", ")}` };
  }
  #acceptProposal(state: EvolutionState, value: unknown, now: string): void {
    const batch = required(state.batch);
    try {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
      const candidate = value as Record<string, unknown>;
      if (Object.keys(candidate).some((key) => !["strategy", "fixes", "risks"].includes(key))) throw new Error("invalid");
      const strategy = parseStrategy(candidate.strategy, batch.strategy);
      const known = new Set(evolutionScenarios("development").map((s) => s.id));
      const ids = (value: unknown): string[] => {
        if (!Array.isArray(value) || value.length > 10 || value.some((id) => typeof id !== "string" || !known.has(id))) throw new Error("invalid");
        return [...new Set(value as string[])];
      };
      const fixes = ids(candidate.fixes);
      const risks = ids(candidate.risks);
      // Frozen for this pin: live/promoted revisions, merit rejections and rollbacks. Infrastructure
      // rejections (call_failed/model_changed) allow at most MAX_STRATEGY_ATTEMPTS total attempts.
      const attempts = state.revisions.filter((r) => JSON.stringify(r.strategy) === JSON.stringify(strategy) && JSON.stringify(r.pin) === JSON.stringify(batch.pin) && r.evaluatorVersion === EVOLUTION_EVALUATOR_VERSION);
      if (fixes.length < 3 || fixes.some((id) => !batch.rollouts.some((r) => r.scenarioId === id && r.success === false))
        || attempts.some((r) => r.status !== "REJECTED" || FROZEN_REJECTION_REASONS.has(r.reason))
        || attempts.length >= MAX_STRATEGY_ATTEMPTS) throw new Error("unsupported");
      const revision: EvolutionRevision = { revisionId: `${batch.id}:strategy`, monitoredGoals: [], controlGoals: [], scope: batch.scope ?? "WORKBENCH", evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, parentRevisionId: batch.parentRevisionId,
        module: strategy.context !== batch.strategy.context ? "context" : "completion", status: "CANDIDATE", createdAt: now, reason: "evaluating",
        baselineSuccesses: 0, candidateSuccesses: 0, evaluatedRuns: 0, strategy, pin: batch.pin, evidenceIds: batch.evidenceIds, prediction: { fixes, risks } };
      state.revisions.push(revision);
      batch.strategy = strategy;
      batch.revisionId = revision.revisionId;
      batch.phase = "VALIDATE";
    } catch { finishBatch(state, "invalid_candidate", now); }
  }
  #acceptSimulation(state: EvolutionState, value: unknown, now: string, tokens: number | null = null): void {
    const batch = required(state.batch);
    const run = required(batch.rollouts.at(-1));
    const scenario = required(evolutionScenarios(batch.phase === "EVALUATE" ? "sealed" : "development").find((s) => s.id === run.scenarioId));
    const next = simulateAction(scenario, { ...run, calls: run.calls + 1 }, value);
    if (tokens === null) next.tokensComplete = false;
    else next.tokens = (run.tokens ?? 0) + tokens;
    if (next.calls >= MAX_CALLS_PER_ROLLOUT && next.success === undefined) next.success = false;
    batch.rollouts[batch.rollouts.length - 1] = next;
    if (next.success === undefined) return;
    if (batch.phase === "DEVELOP") {
      state.developmentHistory = [...state.developmentHistory, next].slice(-60);
      if (batch.rollouts.length === evolutionScenarios("development").length * 3) batch.phase = "PROPOSE";
      return;
    }
    if (batch.phase === "VALIDATE") {
      const trials = batch.rollouts.filter((r) => r.scenarioId.startsWith("development:") && r.variant === "candidate");
      if (trials.length !== evolutionScenarios("development").length * 3) return;
      const revision = required(state.revisions.find((r) => r.revisionId === batch.revisionId));
      const experience = deriveEvolutionExperience({ id: `${revision.revisionId}:development`, revisionId: revision.revisionId, batchId: batch.id,
        createdAt: now, sourcePin: JSON.stringify(batch.pin), evaluatorVersion: batch.evaluatorVersion, parentStrategy: batch.parentStrategy,
        strategy: batch.strategy, comparisons: rolloutComparisons(batch, "development") });
      if (experience !== undefined) state.experiences = [...(state.experiences ?? []).filter(row => row.id !== experience.id), experience].slice(-60);
      if (trials.some((r) => r.violation === true)) { finishBatch(state, "hard_violation", now); return; }
      const improvements = evolutionScenarios("development").map((s) => ({ id: s.id,
        delta: trials.filter((r) => r.scenarioId === s.id && r.success === true).length - batch.rollouts.filter((r) => r.scenarioId === s.id && r.variant === "baseline" && r.success === true).length }));
      if (improvements.some((r) => r.delta < 0)) { finishBatch(state, "quality_regression", now); return; }
      if (revision.prediction.fixes.some((id) => !improvements.some((r) => r.id === id && r.delta > 0))) { finishBatch(state, "insufficient_gain", now); return; }
      batch.phase = "EVALUATE";
      const cached = state.sealedBaselineCache?.[baselineCacheKey(batch)] ?? [];
      if (cached.length === evolutionScenarios("sealed").length * 3 && cached.every((row) => row.variant === "baseline" && row.success !== undefined)) {
        batch.rollouts.push(...structuredClone(cached));
      }
      return;
    }
    const sealed = batch.rollouts.filter((r) => r.scenarioId.startsWith("sealed:"));
    const revision = required(state.revisions.find((r) => r.revisionId === batch.revisionId));
    revision.evaluatedRuns = sealed.filter((r) => r.success !== undefined).length;
    revision.baselineSuccesses = sealed.filter((r) => r.variant === "baseline" && r.success === true).length;
    revision.candidateSuccesses = sealed.filter((r) => r.variant === "candidate" && r.success === true).length;
    if (next.variant === "candidate" && next.violation === true) { finishBatch(state, "hard_violation", now); return; }
    const paired = evolutionScenarios("sealed").map((entry) => sealed.filter((row) => row.scenarioId === entry.id)).filter((rows) => rows.filter((row) => row.variant === "baseline").length === 3 && rows.filter((row) => row.variant === "candidate").length === 3);
    if (paired.some((rows) => rows.filter((row) => row.variant === "candidate" && row.success === true).length < rows.filter((row) => row.variant === "baseline" && row.success === true).length)) {
      finishBatch(state, "quality_regression", now); return;
    }
    const baselines = sealed.filter((row) => row.variant === "baseline");
    const candidates = sealed.filter((row) => row.variant === "candidate");
    if (baselines.length === evolutionScenarios("sealed").length * 3) {
      const bestPossibleGain = candidates.filter((row) => row.success === true).length + (evolutionScenarios("sealed").length * 3 - candidates.length)
        - baselines.filter((row) => row.success === true).length;
      if (bestPossibleGain < 5) { finishBatch(state, "insufficient_gain", now); return; }
    }
    if (sealed.length !== evolutionScenarios("sealed").length * 6) return;
    const comparisons = rolloutComparisons(batch, "sealed");
    state.sealedBaselineCache = { ...(state.sealedBaselineCache ?? {}), [baselineCacheKey(batch)]: structuredClone(sealed.filter((row) => row.variant === "baseline")) };
    const result = promotionDecision(comparisons);
    revision.evaluation = comparisons;
    if (result !== "promote") { finishBatch(state, result, now); return; }
    revision.status = "CANARY"; revision.reason = "canary";
    state.reason = "canary";
    state.batchHistory = [batchRecord(batch, "canary", now), ...(state.batchHistory ?? [])].slice(0, 50);
    state.batch = null;
    state.lastBatchFinishedAt = now;
    state.lastVerdict = { reason: "canary", at: now, baselineSuccesses: revision.baselineSuccesses, candidateSuccesses: revision.candidateSuccesses, evaluatedRuns: revision.evaluatedRuns };
  }
  get evaluatorVersion(): string { return EVOLUTION_EVALUATOR_VERSION; }
}
