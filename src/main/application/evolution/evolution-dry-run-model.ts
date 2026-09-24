import { type CompletionDecision, type EvolutionScenario, evolutionScenarios } from "../../domain/evolution/scenarios.js";
import { baselineStrategy } from "../../domain/evolution/strategy.js";
import type { EvolutionBatch, EvolutionModel, EvolutionRollout, EvolutionSourcePin, EvolutionStore } from "../ports/evolution.js";
import { DRY_RUN_SOURCE_PIN } from "./evolution-dry-run-store.js";

/**
 * A stand-in proposer and simulator. It never reaches a provider: every answer is derived from the
 * batch's own cursor, so a dry run costs nothing and returns the same result every time.
 *
 * It reads the live batch rather than being told what to answer, which is what makes it exercise the
 * real orchestration: the service's phase transitions, rollout cursor and promotion gates all have to
 * hold for the run to reach a verdict.
 */
export class DeterministicEvolutionModel implements EvolutionModel {
  constructor(private readonly store: EvolutionStore, private readonly workbenchId: string) {}
  pin(): Promise<EvolutionSourcePin> { return Promise.resolve(DRY_RUN_SOURCE_PIN); }
  call(input: { mode: "proposal" | "simulation" }): Promise<unknown> {
    const batch = this.store.read(this.workbenchId).batch;
    if (batch === null) throw new Error("evolution_dry_run_batch_missing");
    return Promise.resolve(input.mode === "proposal" ? this.#propose(batch) : this.#simulate(batch));
  }
  /**
   * The candidate is whatever the observed development failures imply: one module moves, and the
   * claimed fixes are the scenarios that actually failed. Deriving them from the rollouts instead of
   * naming a fixed set keeps the proposal honest when the authored fixtures change — if fewer than
   * three scenarios fail, the service rejects the proposal and the dry run reports that, rather than
   * pretending the pipeline is sound.
   */
  #propose(batch: EvolutionBatch): unknown {
    const failed = [...new Set(batch.rollouts
      .filter((run) => run.scenarioId.startsWith("development:") && run.success === false)
      .map((run) => run.scenarioId))].sort();
    // Ten is the service's own ceiling on a proposal's claims; exceeding it would be rejected as an
    // invalid candidate rather than as the pipeline failure it is not.
    return { strategy: { ...baselineStrategy, completion: "evidence_matrix" }, fixes: failed.slice(0, 10), risks: [] };
  }
  #simulate(batch: EvolutionBatch): unknown {
    const run = batch.rollouts.at(-1);
    if (run === undefined) throw new Error("evolution_dry_run_rollout_missing");
    const scenario = scenarioById(run.scenarioId);
    // Reading is what makes a finish count: an unread required record fails the rollout outright.
    if (run.calls < scenario.requiredIds.length) return { action: "read_evidence", evidenceId: scenario.requiredIds[run.calls] };
    return { action: "finish", decision: shouldFail(batch, run, scenario) ? failingDecision(scenario.expected) : scenario.expected, evidenceIds: scenario.requiredIds };
  }
}

/**
 * DEVELOPMENT: the baseline under-verifies the families whose expected decision is to keep going.
 * Selecting by expected value rather than list position keeps the dry run meaningful when the
 * authored fixtures are reordered, and yields the failures the proposal has to point at.
 *
 * VALIDATE: never. The candidate has to beat the baseline the proposal just claimed to fix, or the
 * service would rightly reject it for insufficient gain.
 *
 * EVALUATE: exactly enough baseline failures to clear the promotion gate's five percent gain floor,
 * spread one per scenario so the candidate can never fall below the baseline in any single row. One
 * failed attempt out of three leaves that row at two against the candidate's three.
 */
function shouldFail(batch: EvolutionBatch, run: EvolutionRollout, scenario: EvolutionScenario): boolean {
  if (batch.phase === "DEVELOP") return scenario.expected === "continue";
  if (batch.phase === "VALIDATE") return false;
  return run.variant === "baseline" && run.attempt === 0 && sealedBaselineFailureIds().has(scenario.id);
}

/**
 * Never equal to the scenario's expected answer and never `complete`, so the failure reads as a
 * wrong decision rather than a violation. `simulateAction` treats claiming completion on a goal that
 * was not complete as a violation, and a violation hard-fails the whole batch.
 */
const failingDecision = (expected: CompletionDecision): CompletionDecision => expected === "wait" ? "continue" : "wait";

/**
 * Sized from the sealed set rather than fixed: the gain is a share of every sealed trial, so this
 * keeps a little more than five percent of headroom however many sealed scenarios are authored.
 */
function sealedBaselineFailureIds(): ReadonlySet<string> {
  const required = Math.ceil(0.05 * evolutionScenarios("sealed").length * 3);
  return new Set(evolutionScenarios("sealed").map((scenario) => scenario.id).sort().slice(0, required));
}

function scenarioById(id: string): EvolutionScenario {
  const scenario = evolutionScenarios(id.startsWith("sealed:") ? "sealed" : "development").find((entry) => entry.id === id);
  if (scenario === undefined) throw new Error("evolution_dry_run_scenario_missing");
  return scenario;
}
