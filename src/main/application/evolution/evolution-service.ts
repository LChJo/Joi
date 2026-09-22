import { DomainError } from "../../domain/errors.js";
import { baselineStrategy, composeStrategyInstructions, parseStrategy, promotionDecision } from "../../domain/evolution/strategy.js";
import { EVOLUTION_EVALUATOR_VERSION, evolutionScenarios, scenarioPrompt, simulateAction } from "../../domain/evolution/scenarios.js";
import type { EvolutionReason, EvolutionStatusDto } from "../../../shared/evolution.js";
import type { EvolutionBatch, EvolutionEvidence, EvolutionModel, EvolutionRevision, EvolutionRollout, EvolutionSourcePin, EvolutionState, EvolutionStore } from "../ports/evolution.js";
import { buildJoiSystemPrompt } from "../joi/joi-system-prompt.js";

const MAX_CALLS_PER_ROLLOUT = 6;
const MAX_CONSECUTIVE_CALL_FAILURES = 3;
const MAX_STRATEGY_ATTEMPTS = 2;
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
  state.reason = reason;
  state.batch = null;
  // A verdict consumes the evidence trigger, so resolved historical failures never re-run daily.
  // Infrastructure aborts (call_failed/model_changed) leave the trigger intact for a later retry.
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
  constructor(private readonly dependencies: { store: EvolutionStore; model: EvolutionModel; now: () => string; id: () => string }) {}

  status(workbenchId: string): EvolutionStatusDto {
    const state = this.dependencies.store.read(workbenchId);
    const evidence = this.dependencies.store.evidence(workbenchId);
    const used = state.usage[dayOf(this.dependencies.now())] ?? 0;
    return { workbenchId, dailyCallLimit: state.dailyCallLimit, callsUsedToday: used, evidenceCount: evidence.length,
      evaluableCount: evidence.filter(evaluable).length, activeRevisionId: state.activeRevisionId,
      reason: state.paused ? state.reason : state.dailyCallLimit === 0 ? "disabled" : used >= state.dailyCallLimit ? "budget_exhausted" : state.reason,
      versions: state.revisions.slice(-30).reverse().map(({ revisionId, parentRevisionId, module, status, createdAt, reason, baselineSuccesses, candidateSuccesses, evaluatedRuns }) =>
        ({ revisionId, parentRevisionId, module, status, createdAt, reason, baselineSuccesses, candidateSuccesses, evaluatedRuns })),
    };
  }
  configure(workbenchId: string, dailyCallLimit: number): EvolutionStatusDto {
    if (!Number.isInteger(dailyCallLimit) || dailyCallLimit < 0 || dailyCallLimit > 10_000) throw new DomainError("evolution_budget_invalid", "Daily call limit must be an integer between 0 and 10000.");
    this.dependencies.store.update(workbenchId, (state) => { state.dailyCallLimit = dailyCallLimit; state.paused = false; if (state.reason === "disabled" || state.reason === "rolled_back") state.reason = "collecting"; });
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
    for (const seed of this.dependencies.store.evidenceSeeds()) {
      const outcome: EvolutionEvidence["outcome"] = seed.canceled ? "CANCELED"
        : seed.disposition === "ACCEPTED_WITH_GAPS" ? "ACCEPTED_WITH_GAPS"
          : seed.failed > 0 ? "VERIFICATION_FAILED"
            : seed.workFailed > 0 ? "ENVIRONMENT_FAILED"
              : seed.verified > 0 && seed.unverified === 0 && seed.disposition === "COMPLETED" ? "VERIFIED" : "UNEVALUABLE";
      this.dependencies.store.recordEvidence({ goalId: seed.goalId, workbenchId: seed.workbenchId, observedAt: seed.observedAt, outcome,
        revisionId: this.dependencies.store.goalRevision(seed.workbenchId, seed.goalId) ?? null });
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
      if (first.length > 0) this.dependencies.store.update(id, (s) => {
        required(s.revisions.find((r) => r.revisionId === s.activeRevisionId)).monitoredGoals.push(...first.map((e) => e.goalId));
        if (first.some((e) => e.outcome === "VERIFICATION_FAILED")) revert(s, this.dependencies.now());
      });
    }
  }
  pending(): { inputId: string; createdAt: string }[] {
    if (!this.dependencies.store.idle()) return [];
    const now = this.dependencies.now();
    return this.dependencies.store.listWorkbenchIds().filter((id) => this.#eligible(id)).slice(0, 1)
      .map((id) => ({ inputId: `evolution:${id}`, createdAt: now }));
  }
  #eligible(id: string): boolean {
    const state = this.dependencies.store.read(id);
    const day = dayOf(this.dependencies.now());
    if (state.paused || state.dailyCallLimit === 0 || (state.usage[day] ?? 0) >= state.dailyCallLimit || this.#running.has(id)) return false;
    if (state.parkedDay === day) return false;
    if (state.batch !== null) return true;
    if (state.lastCandidateDay === day || state.revisions.length >= 30) return false;
    // A verdict consumes its trigger: only evidence observed after the last verdict starts a new
    // batch, so historical failures the pipeline already addressed never re-run evaluation daily.
    const since = state.lastBatchFinishedAt ?? null;
    const evidence = this.dependencies.store.evidence(id).filter((e) => since === null || e.observedAt > since);
    return evidence.filter(evaluable).length >= 10 && evidence.filter((e) => e.outcome === "VERIFICATION_FAILED").length >= 3;
  }
  async handle(inputId: string, signal?: AbortSignal): Promise<void> {
    const id = inputId.slice("evolution:".length);
    if (!inputId.startsWith("evolution:") || signal?.aborted === true || !this.dependencies.store.idle() || !this.#eligible(id)) return;
    this.#running.add(id);
    this.#recovered.add(id);
    try { await this.#step(id, signal); }
    catch {
      this.dependencies.store.update(id, (state) => { this.#failStep(state, dayOf(this.dependencies.now())); });
    } finally { this.#running.delete(id); }
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
  async #step(id: string, signal?: AbortSignal): Promise<void> {
    const pin = await this.dependencies.model.pin();
    if (signal?.aborted === true || !this.dependencies.store.idle()) return;
    const now = this.dependencies.now();
    const day = dayOf(now);
    const evidenceIds = this.dependencies.store.evidence(id).filter(evaluable).slice(0, 30).map((e) => e.goalId);
    const call = this.dependencies.store.update(id, (state) => {
      if (state.paused || (state.usage[day] ?? 0) >= state.dailyCallLimit) return null;
      if (state.batch === null) {
        if (state.lastCandidateDay === day) return null;
        const batchId = this.dependencies.id();
        const active = state.revisions.find((r) => r.revisionId === state.activeRevisionId);
        const baseline = active !== undefined && JSON.stringify(active.pin) === JSON.stringify(pin) && active.evaluatorVersion === EVOLUTION_EVALUATOR_VERSION ? activeStrategy(state) : baselineStrategy;
        state.batch = { id: batchId, evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, parentStrategy: baseline, parentRevisionId: state.activeRevisionId, strategy: baseline, pin, phase: "DEVELOP", evidenceIds, rollouts: [] };
        state.lastCandidateDay = day;
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
    if (call === null) return;
    this.dependencies.store.update(id, (state) => { required(state.call).state = "RUNNING"; });
    try {
      const prompt = call.batch.phase === "PROPOSE" ? this.#proposalPrompt(call.batch, call.history) : this.#simulationPrompt(call.batch);
      const result = await this.dependencies.model.call({ pin, ...prompt, idempotencyId: call.id, ...(signal === undefined ? {} : { signal }) });
      const stillPinned = JSON.stringify(await this.dependencies.model.pin()) === JSON.stringify(pin);
      this.dependencies.store.update(id, (state) => {
        if (state.call?.id !== call.id) return;
        state.call.state = "DONE";
        state.callFailures = 0;
        if (state.batch?.id !== call.batch.id || state.paused || state.dailyCallLimit === 0) return;
        if (!stillPinned) { finishBatch(state, "model_changed", now); return; }
        if (call.batch.phase === "PROPOSE") this.#acceptProposal(state, result, now);
        else this.#acceptSimulation(state, result, now);
      });
    } catch {
      this.dependencies.store.update(id, (state) => {
        if (state.call?.id === call.id) state.call.state = "DONE";
        this.#failStep(state, day);
      });
    }
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
  }
  get evaluatorVersion(): string { return EVOLUTION_EVALUATOR_VERSION; }
}
