import type { EvolutionEvidence, EvolutionEvidenceSeed, EvolutionSourcePin, EvolutionState, EvolutionStore } from "../ports/evolution.js";
import { EVOLUTION_EVIDENCE_THRESHOLD, EVOLUTION_FAILURE_THRESHOLD } from "../../../shared/evolution.js";

/** Synthetic budget: the dry run issues no provider calls, so this only has to outlast one full batch. */
const DRY_RUN_DAILY_CALL_LIMIT = 10_000;
/** Well before the dry run's frozen clock, so every synthetic record lands inside the trigger window. */
const SYNTHETIC_OBSERVED_AT = "2026-01-01T00:00:00.000Z";

/**
 * Everything a dry run touches, in memory and nowhere else. The real store reaches `runtime.sqlite`,
 * the outbox and the usage ledger; this one holds a single state object, so a dry run cannot pollute
 * the workbench it is diagnosing even if the batch misbehaves.
 *
 * `evidenceSeeds()` returns nothing on purpose. Seeding is the real classifier's job and the dry run
 * is not a second implementation of it: it starts from a synthetic pool that already clears the gate,
 * which is exactly the situation the gate is withholding from a real workbench.
 */
export class InMemoryEvolutionStore implements EvolutionStore {
  #state: EvolutionState;
  #maxRollouts = 0;
  readonly #evidence: EvolutionEvidence[];
  constructor(private readonly workbenchId: string) {
    // The gate is bypassed by supplying the evidence the gate is waiting for, not by weakening it:
    // the thresholds still come from the shared constants the production gate reads.
    this.#evidence = syntheticEvidence(workbenchId);
    this.#state = {
      callSequence: 0, developmentHistory: [], dailyCallLimit: DRY_RUN_DAILY_CALL_LIMIT, usage: {},
      activeRevisionId: null, reason: "collecting", lastCandidateDay: null, revisions: [], batch: null,
      call: null, paused: false,
    };
  }
  listWorkbenchIds(): string[] { return [this.workbenchId]; }
  read(): EvolutionState { return structuredClone(this.#state); }
  /** Mirrors the real store's read-modify-write, minus the serialization round trip it does not need. */
  update<T>(_workbenchId: string, operation: (state: EvolutionState) => T): T {
    const result = operation(this.#state);
    if (this.#state.batch !== null) this.#maxRollouts = Math.max(this.#maxRollouts, this.#state.batch.rollouts.length);
    return result;
  }
  /**
   * The batch is discarded the moment it reaches a verdict, so the final phase's rollout count cannot
   * be read back afterwards. This is the only place that sees it.
   */
  maxRolloutsObserved(): number { return this.#maxRollouts; }
  evidence(): EvolutionEvidence[] { return structuredClone(this.#evidence); }
  evidenceTotals(since: string | null): { evaluable: number; verificationFailed: number } {
    const within = this.#evidence.filter((entry) => since === null || entry.observedAt > since);
    return {
      evaluable: within.filter((entry) => entry.outcome === "VERIFIED" || entry.outcome === "VERIFICATION_FAILED").length,
      verificationFailed: within.filter((entry) => entry.outcome === "VERIFICATION_FAILED").length,
    };
  }
  evidenceSeeds(): EvolutionEvidenceSeed[] { return []; }
  /**
   * Only `scan()` records evidence, and the dry run never scans: it drives the batch pipeline, which
   * is the part the gate has kept untested. Throwing keeps a future caller from believing a
   * classification was stored when the whole point of this store is that nothing is.
   */
  recordEvidence(): EvolutionEvidence["outcome"] | null { throw new Error("evolution_dry_run_does_not_record_evidence"); }
  bindGoal(): string | null { return null; }
  goalRevision(): string | null { return null; }
  idle(): boolean { return true; }
  /** Single-workbench store, so the "global" candidate day is this state's own value. */
  lastCandidateDay(): string | null { return this.#state.lastCandidateDay; }
  /** Exposed for the report, so the operator can see which pool the dry run started from. */
  syntheticPool(): { evaluable: number; verificationFailed: number } { return this.evidenceTotals(null); }
}

/**
 * A pool that clears the gate by construction, sized from the thresholds themselves so raising a
 * threshold cannot leave the dry run unable to start. Most of it verifies; the failures are the ones
 * the trigger actually counts.
 */
function syntheticEvidence(workbenchId: string): EvolutionEvidence[] {
  const failures = Math.max(EVOLUTION_FAILURE_THRESHOLD, 1);
  const evaluable = Math.max(EVOLUTION_EVIDENCE_THRESHOLD, failures);
  return Array.from({ length: evaluable }, (_, index) => ({
    goalId: `dry-run-evidence:${String(index)}`,
    workbenchId,
    revisionId: null,
    outcome: index < failures ? "VERIFICATION_FAILED" as const : "VERIFIED" as const,
    observedAt: SYNTHETIC_OBSERVED_AT,
  }));
}

/** The dry run's stand-in source pin; never resolved against a real provider. */
export const DRY_RUN_SOURCE_PIN: EvolutionSourcePin = {
  modelId: "dry-run-model", modelRevisionId: "dry-run-model-revision",
  sourceId: "dry-run-source", sourceRevisionId: "dry-run-source-revision",
};
