import { DomainError } from "../../domain/errors.js";
import { baselineStrategy, composeStrategyInstructions, parseStrategy, promotionDecision } from "../../domain/evolution/strategy.js";
import { EVOLUTION_EVALUATOR_VERSION, evolutionScenarios, scenarioPrompt, simulateAction } from "../../domain/evolution/scenarios.js";
import { EVOLUTION_EVIDENCE_THRESHOLD, EVOLUTION_FAILURE_THRESHOLD, EVOLUTION_HANDLE_TIME_BUDGET_MS, EVOLUTION_MAX_STEPS_PER_HANDLE, EVOLUTION_MONITOR_REVERT_THRESHOLD, EVOLUTION_RESPONSE_INVALID_BREAKER_LIMIT, EVOLUTION_RESPONSE_INVALID_RETRY_LIMIT, EVOLUTION_RUN_NOW_TTL_MILLIS, type EvolutionReason, type EvolutionStatusDto } from "../../../shared/evolution.js";
import type { EvolutionBatch, EvolutionEvidence, EvolutionModel, EvolutionRevision, EvolutionRollout, EvolutionSourcePin, EvolutionState, EvolutionStore } from "../ports/evolution.js";
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
const activeStrategy = (state: EvolutionState) => state.revisions.find((r) => r.revisionId === state.activeRevisionId)?.strategy ?? baselineStrategy;
function finishBatch(state: EvolutionState, reason: EvolutionReason, now: string): void {
  const revision = state.revisions.find((r) => r.revisionId === state.batch?.revisionId);
  if (revision !== undefined) { revision.status = "REJECTED"; revision.reason = reason; }
  // Keep the outcome counts of the finished batch visible: a rejection that consumed its trigger
  // window should also show how far from promotion it landed.
  if (revision !== undefined) state.lastVerdict = { reason, at: now, baselineSuccesses: revision.baselineSuccesses, candidateSuccesses: revision.candidateSuccesses, evaluatedRuns: revision.evaluatedRuns };
  state.reason = reason;
  state.batch = null;
  // A verdict consumes the evidence trigger, so resolved historical failures never re-run daily.
  // Infrastructure aborts (call_failed/model_changed) leave the trigger intact for a later retry.
  // model_response_invalid is deliberately NOT in that exception: a model that cannot answer the
  // evaluation contract would otherwise restart a paying batch every day. Recovery is via run-now.
  if (reason !== "call_failed" && reason !== "model_changed") state.lastBatchFinishedAt = now;
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
    const pool = totals ?? this.dependencies.store.evidenceTotals(null);
    const workbenches = workbenchCount ?? this.dependencies.store.listWorkbenchIds().length;
    const signature = `${reason}|${String(pool.evaluable)}|${String(pool.verificationFailed)}|${String(workbenches)}`;
    if (signature === this.#gateSignature) return;
    this.#gateSignature = signature;
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.gate_skipped", {
      reason, evaluable: pool.evaluable, verificationFailed: pool.verificationFailed,
      thresholdEvaluable: EVOLUTION_EVIDENCE_THRESHOLD, thresholdFailed: EVOLUTION_FAILURE_THRESHOLD, workbenchCount: workbenches,
    });
  }

  status(workbenchId: string): EvolutionStatusDto {
    const state = this.dependencies.store.read(workbenchId);
    const evidence = this.dependencies.store.evidence(workbenchId);
    const used = state.usage[dayOf(this.dependencies.now())] ?? 0;
    // The same window #eligible uses, so the panel explains the actual gate instead of a proxy.
    const pool = this.dependencies.store.evidenceTotals(state.lastBatchFinishedAt ?? null);
    return { workbenchId, dailyCallLimit: state.dailyCallLimit, callsUsedToday: used, evidenceCount: evidence.length,
      evaluableCount: evidence.filter(evaluable).length, activeRevisionId: state.activeRevisionId,
      poolEvaluable: pool.evaluable, poolVerificationFailed: pool.verificationFailed,
      reason: state.paused ? state.reason : state.dailyCallLimit === 0 ? "disabled" : used >= state.dailyCallLimit ? "budget_exhausted" : state.reason,
      runRequestedAt: state.runRequestedAt ?? null,
      lastVerdict: state.lastVerdict ?? null,
      versions: state.revisions.slice(-30).reverse().map(({ revisionId, parentRevisionId, module, status, createdAt, reason, baselineSuccesses, candidateSuccesses, evaluatedRuns }) =>
        ({ revisionId, parentRevisionId, module, status, createdAt, reason, baselineSuccesses, candidateSuccesses, evaluatedRuns })),
    };
  }
  configure(workbenchId: string, dailyCallLimit: number): EvolutionStatusDto {
    if (!Number.isInteger(dailyCallLimit) || dailyCallLimit < 0 || dailyCallLimit > 10_000) throw new DomainError("evolution_budget_invalid", "Daily call limit must be an integer between 0 and 10000.");
    this.dependencies.store.update(workbenchId, (state) => { state.dailyCallLimit = dailyCallLimit; state.paused = false; if (state.reason === "disabled" || state.reason === "rolled_back" || state.reason === "model_response_invalid") state.reason = "collecting"; });
    return this.status(workbenchId);
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
      state.runRequestedAt = now;
    });
    return this.status(workbenchId);
  }
  rollback(workbenchId: string, revisionId: string): EvolutionStatusDto {
    const now = this.dependencies.now();
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
    const state = this.dependencies.store.read(workbenchId);
    if (revision !== null && revision === state.activeRevisionId) return this.rollback(workbenchId, revision);
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
  strategyForGoal(workbenchId: string, goalId: string, pin?: EvolutionSourcePin): { strategyRevisionId: string | null; instructions: string } {
    const state = this.dependencies.store.read(workbenchId);
    const active = state.revisions.find((r) => r.revisionId === state.activeRevisionId);
    const compatible = active === undefined || (active.evaluatorVersion === EVOLUTION_EVALUATOR_VERSION && (pin === undefined || Object.entries(active.pin).every(([key, value]) => pin[key as keyof EvolutionSourcePin] === value)));
    const revisionId = this.dependencies.store.bindGoal(workbenchId, goalId, compatible ? state.activeRevisionId : null, pin);
    const strategy = state.revisions.find((r) => r.revisionId === revisionId)?.strategy ?? baselineStrategy;
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
      const persisted = this.dependencies.store.recordEvidence({ goalId: seed.goalId, workbenchId: seed.workbenchId, observedAt: seed.observedAt, outcome,
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
          // Restart just the interrupted simulation attempt; completed trials remain reusable.
          // The abandoned request remains charged in the daily ledger and the outbox.
          if (s.batch?.phase !== "PROPOSE" && s.batch?.rollouts.at(-1)?.success === undefined) s.batch?.rollouts.pop();
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
  }
  pending(): { inputId: string; createdAt: string }[] {
    const workbenchIds = this.dependencies.store.listWorkbenchIds();
    if (!this.dependencies.store.idle()) { this.#skipGate("not_idle", undefined, workbenchIds.length); return []; }
    const now = this.dependencies.now();
    // One query per tick, passed down: reading it inside #eligible would re-parse every state's JSON
    // on every check.
    const globalCandidateDay = this.dependencies.store.lastCandidateDay();
    const candidates = workbenchIds.filter((id) => this.#eligible(id, globalCandidateDay));
    if (candidates.length === 0) {
      // The pool is shared, so a single query explains why every workbench declined. Distinguish
      // "not enough evidence yet" from "enough evidence, but every workbench is out of budget,
      // parked, or already proposed today" — they need completely different responses.
      const totals = this.dependencies.store.evidenceTotals(null);
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
    const totals = this.dependencies.store.evidenceTotals(state.lastBatchFinishedAt ?? null);
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
  #emitCallFailure(id: string, callId: string | null, error: unknown): void {
    const state = this.dependencies.store.read(id);
    const detail = runtimeDiagnosticErrorDetail(error);
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.call_failed", {
      workbenchId: id, callId: callId ?? "unknown", consecutiveFailures: state.callFailures ?? 0,
      parkedDay: state.parkedDay ?? dayOf(this.dependencies.now()),
      errorKind: runtimeDiagnosticErrorCode(error),
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
    if (state.batch.phase !== "PROPOSE" && state.batch.rollouts.at(-1)?.success === undefined) state.batch.rollouts.pop();
    if ((state.callFailures ?? 0) >= MAX_CONSECUTIVE_CALL_FAILURES) finishBatch(state, "call_failed", this.dependencies.now());
  }
  /** Claims one bounded call, runs it and accepts the result. True when a call was actually issued. */
  async #step(id: string, signal?: AbortSignal): Promise<boolean> {
    const pin = await this.dependencies.model.pin();
    if (signal?.aborted === true || !this.dependencies.store.idle()) return false;
    const now = this.dependencies.now();
    const day = dayOf(now);
    const evidenceIds = this.dependencies.store.evidence(id).filter(evaluable).slice(0, 30).map((e) => e.goalId);
    const call = this.dependencies.store.update(id, (state) => {
      if (state.paused || (state.usage[day] ?? 0) >= state.dailyCallLimit) return null;
      if (state.batch === null) {
        // A pending run-now request also bypasses the once-per-day candidate lock here: the gate
        // above already admitted it, and a request that could not actually start a batch would be
        // silently swallowed by this check on a day when a batch already ran.
        const requested = state.runRequestedAt !== null && state.runRequestedAt !== undefined;
        if (state.lastCandidateDay === day && !requested) return null;
        const batchId = this.dependencies.id();
        const active = state.revisions.find((r) => r.revisionId === state.activeRevisionId);
        const baseline = active !== undefined && JSON.stringify(active.pin) === JSON.stringify(pin) && active.evaluatorVersion === EVOLUTION_EVALUATOR_VERSION ? activeStrategy(state) : baselineStrategy;
        state.batch = { id: batchId, evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, parentStrategy: baseline, parentRevisionId: state.activeRevisionId, strategy: baseline, pin, phase: "DEVELOP", evidenceIds, rollouts: [] };
        state.lastCandidateDay = day;
        // The run-now request is consumed by the batch it started; the response streak belongs to
        // the previous batch and says nothing about the new one.
        state.runRequestedAt = null;
        state.responseInvalidStreak = 0;
      }
      if (JSON.stringify(state.batch.pin) !== JSON.stringify(pin) || state.batch.evaluatorVersion !== EVOLUTION_EVALUATOR_VERSION) { finishBatch(state, "model_changed", now); return null; }
      const batch = state.batch;
      // A batch resumed across midnight consumes the proposal day's candidate slot too.
      if (batch.phase === "PROPOSE") state.lastCandidateDay = day;
      if (batch.phase !== "PROPOSE") this.#ensureRollout(batch);
      state.callSequence += 1;
      const callId = `${batch.id}:call:${String(state.callSequence)}`;
      state.usage[day] = (state.usage[day] ?? 0) + 1;
      const cutoff = new Date(Date.parse(now) - 32 * 86_400_000).toISOString().slice(0, 10);
      state.usage = Object.fromEntries(Object.entries(state.usage).filter(([key]) => key >= cutoff));
      state.call = { id: callId, state: "PENDING", createdAt: now };
      state.reason = "evaluating";
      return { batch: structuredClone(batch), history: state.developmentHistory, id: callId };
    });
    if (call === null) return false;
    this.dependencies.store.update(id, (state) => { required(state.call).state = "RUNNING"; });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.batch_step_started",
      { workbenchId: id, batchId: call.batch.id, callId: call.id, phase: call.batch.phase });
    try {
      const prompt = call.batch.phase === "PROPOSE" ? this.#proposalPrompt(call.batch, call.history) : this.#simulationPrompt(call.batch);
      const result = await this.dependencies.model.call({ pin, ...prompt, workbenchId: id, idempotencyId: call.id, ...(signal === undefined ? {} : { signal }) });
      const stillPinned = JSON.stringify(await this.dependencies.model.pin()) === JSON.stringify(pin);
      this.dependencies.store.update(id, (state) => {
        if (state.call?.id !== call.id) return;
        state.call.state = "DONE";
        state.callFailures = 0;
        state.responseInvalidStreak = 0;
        if (state.batch?.id !== call.batch.id || state.paused || state.dailyCallLimit === 0) return;
        if (!stillPinned) { finishBatch(state, "model_changed", now); return; }
        if (call.batch.phase === "PROPOSE") this.#acceptProposal(state, result, now);
        else this.#acceptSimulation(state, result, now);
      });
      this.#responseInvalidStreak = 0;
    } catch (error) {
      const kind = EvolutionService.#classifyStepFailure(error, signal);
      let consecutive = 0;
      this.dependencies.store.update(id, (state) => {
        if (state.call?.id !== call.id) return;
        state.call.state = "DONE";
        if (kind === "response_invalid") {
          // The provider answered, so the call was consumed — but this is a model-quality signal,
          // not an infrastructure fault: retry the same rollout tomorrow-grade rather than parking
          // the day, and only abandon the batch after the retry limit.
          state.responseInvalidStreak = (state.responseInvalidStreak ?? 0) + 1;
          consecutive = state.responseInvalidStreak;
          if (state.responseInvalidStreak >= EVOLUTION_RESPONSE_INVALID_RETRY_LIMIT) finishBatch(state, "model_response_invalid", now);
        } else if (kind === "aborted") {
          // Crash-recovery semantics: keep the batch and every completed trial, drop only the
          // interrupted attempt, and leave parkedDay and callFailures alone — a user cancelling
          // must not cost the workbench its daily candidate.
          if (state.batch?.phase !== "PROPOSE" && state.batch?.rollouts.at(-1)?.success === undefined) state.batch?.rollouts.pop();
          state.reason = "call_failed";
        } else {
          this.#failStep(state, day);
        }
      });
      if (kind === "response_invalid") {
        this.#responseInvalidStreak += 1;
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.evolution.response_invalid",
          { workbenchId: id, callId: call.id, consecutive });
        if (this.#responseInvalidStreak >= EVOLUTION_RESPONSE_INVALID_BREAKER_LIMIT) this.#tripBreaker();
      } else {
        this.#responseInvalidStreak = 0;
        this.#emitCallFailure(id, call.id, error);
      }
    }
    return true;
  }
  static #classifyStepFailure(error: unknown, signal: AbortSignal | undefined): "response_invalid" | "aborted" | "infra" {
    if (signal?.aborted === true) return "aborted";
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
    const completed = batch.phase === "DEVELOP" ? batch.rollouts.length : batch.phase === "VALIDATE" ? batch.rollouts.filter((r) => r.scenarioId.startsWith("development:") && r.variant === "candidate").length : batch.rollouts.filter((r) => r.scenarioId.startsWith("sealed:")).length;
    const scenarios = evolutionScenarios(batch.phase === "EVALUATE" ? "sealed" : "development");
    const perScenario = batch.phase === "EVALUATE" ? 6 : 3;
    const scenario = scenarios[Math.floor(completed / perScenario)];
    if (scenario === undefined) throw new DomainError("evolution_evaluation_invalid", "Evaluation cursor is invalid.");
    batch.rollouts.push({ scenarioId: scenario.id, variant: batch.phase === "VALIDATE" ? "candidate" : batch.phase === "DEVELOP" || completed % 6 < 3 ? "baseline" : "candidate", attempt: completed % 3, calls: 0, observations: [], actions: [] });
  }
  #proposalPrompt(batch: EvolutionBatch, history: EvolutionRollout[]): { mode: "proposal"; prompt: string; systemPrompt: string } {
    // Only development traces go to the proposer. Sealed verdicts and bodies never do.
    return { mode: "proposal", systemPrompt: "Propose one bounded joi strategy change. Compare successes and failures for the SAME development scenario, then aggregate recurring deficiencies across scenarios. No code, free-form instructions, task answers or new permissions. Change exactly one module. Report fixes and risks as development scenario IDs only.",
      prompt: JSON.stringify({ parent: batch.strategy, modes: { context: ["baseline", "requirements_first", "open_questions_first"], completion: ["baseline", "evidence_matrix", "contradiction_check"] }, evidenceCount: batch.evidenceIds.length,
        historicalSuccesses: history.filter((r) => r.scenarioId.startsWith("development:") && r.success === true).slice(-10),
        development: batch.rollouts.filter((r) => r.scenarioId.startsWith("development:")).map((r) => ({ scenarioId: r.scenarioId, success: r.success, calls: r.calls, actions: r.actions, observations: r.observations })) }) };
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
      const revision: EvolutionRevision = { revisionId: `${batch.id}:strategy`, monitoredGoals: [], evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, parentRevisionId: batch.parentRevisionId,
        module: strategy.context !== batch.strategy.context ? "context" : "completion", status: "CANDIDATE", createdAt: now, reason: "evaluating",
        baselineSuccesses: 0, candidateSuccesses: 0, evaluatedRuns: 0, strategy, pin: batch.pin, evidenceIds: batch.evidenceIds, prediction: { fixes, risks } };
      state.revisions.push(revision);
      batch.strategy = strategy;
      batch.revisionId = revision.revisionId;
      batch.phase = "VALIDATE";
    } catch { finishBatch(state, "invalid_candidate", now); }
  }
  #acceptSimulation(state: EvolutionState, value: unknown, now: string): void {
    const batch = required(state.batch);
    const run = required(batch.rollouts.at(-1));
    const scenario = required(evolutionScenarios(batch.phase === "EVALUATE" ? "sealed" : "development").find((s) => s.id === run.scenarioId));
    const next = simulateAction(scenario, { ...run, calls: run.calls + 1 }, value);
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
      if (trials.some((r) => r.violation === true)) { finishBatch(state, "hard_violation", now); return; }
      const improvements = evolutionScenarios("development").map((s) => ({ id: s.id,
        delta: trials.filter((r) => r.scenarioId === s.id && r.success === true).length - batch.rollouts.filter((r) => r.scenarioId === s.id && r.variant === "baseline" && r.success === true).length }));
      if (improvements.some((r) => r.delta < 0)) { finishBatch(state, "quality_regression", now); return; }
      if (revision.prediction.fixes.some((id) => !improvements.some((r) => r.id === id && r.delta > 0))) { finishBatch(state, "insufficient_gain", now); return; }
      batch.phase = "EVALUATE";
      return;
    }
    const sealed = batch.rollouts.filter((r) => r.scenarioId.startsWith("sealed:"));
    const revision = required(state.revisions.find((r) => r.revisionId === batch.revisionId));
    revision.evaluatedRuns = sealed.filter((r) => r.success !== undefined).length;
    revision.baselineSuccesses = sealed.filter((r) => r.variant === "baseline" && r.success === true).length;
    revision.candidateSuccesses = sealed.filter((r) => r.variant === "candidate" && r.success === true).length;
    if (sealed.length !== evolutionScenarios("sealed").length * 6) return;
    const comparisons = evolutionScenarios("sealed").map((scenario) => {
      const rows = sealed.filter((r) => r.scenarioId === scenario.id);
      const base = rows.filter((r) => r.variant === "baseline");
      const candidate = rows.filter((r) => r.variant === "candidate");
      return { scenarioId: scenario.id, baseline: base.map((r) => r.success === true), candidate: candidate.map((r) => r.success === true), baselineCalls: base.reduce((n, r) => n + r.calls, 0), candidateCalls: candidate.reduce((n, r) => n + r.calls, 0), violations: candidate.filter((r) => r.violation === true).length };
    });
    const result = promotionDecision(comparisons);
    revision.evaluation = comparisons;
    if (result !== "promote") { finishBatch(state, result, now); return; }
    if (state.activeRevisionId !== batch.parentRevisionId) { finishBatch(state, "invalid_candidate", now); return; }
    const parent = state.revisions.find((r) => r.revisionId === state.activeRevisionId);
    if (parent !== undefined) parent.status = "SUPERSEDED";
    revision.status = "ACTIVE"; revision.reason = "promoted";
    state.activeRevisionId = revision.revisionId; state.reason = "promoted"; state.batch = null;
    state.lastBatchFinishedAt = now;
    state.lastVerdict = { reason: "promoted", at: now, baselineSuccesses: revision.baselineSuccesses, candidateSuccesses: revision.candidateSuccesses, evaluatedRuns: revision.evaluatedRuns };
  }
  get evaluatorVersion(): string { return EVOLUTION_EVALUATOR_VERSION; }
}
