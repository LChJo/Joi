import type { EvolutionDryRunOutcome, EvolutionDryRunPhaseDto, EvolutionDryRunReportDto, EvolutionPhase, EvolutionVersionDto } from "../../../shared/evolution.js";
import type { RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import type { EvolutionRevision } from "../ports/evolution.js";
import { DeterministicEvolutionModel } from "./evolution-dry-run-model.js";
import { InMemoryEvolutionStore } from "./evolution-dry-run-store.js";
import { EvolutionService } from "./evolution-service.js";

/** A healthy batch takes 721 steps; the worst case is 1441. Anything past this is a runaway loop. */
const DEFAULT_MAX_STEPS = 1_600;
/** The route answers synchronously, so the loop needs a wall-clock backstop as well as a step cap. */
const DEFAULT_TIME_BUDGET_MS = 10_000;

interface PhaseTracker {
  phase: EvolutionPhase;
  steps: number;
  entryRollouts: number;
  cumulativeRollouts: number;
}

/**
 * Runs one complete batch on demand with no provider calls and no durable writes, so the pipeline can
 * be checked before the evidence gate has opened on its own.
 *
 * It drives the real `EvolutionService` step by step, exactly as the background scheduler does, so a
 * verdict here means the orchestration, the rollout cursor, the promotion gates and the state machine
 * all work together. It says nothing about whether a real strategy would earn anything: the proposals
 * and simulations come from a stand-in, so this proves the machinery, not the payoff.
 */
export class EvolutionDryRun {
  constructor(private readonly dependencies: { now: () => string; id: () => string; maxSteps?: number; timeBudgetMs?: number }) {}

  async run(workbenchId: string): Promise<EvolutionDryRunReportDto> {
    const startedAt = Date.now();
    const maxSteps = this.dependencies.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeBudgetMs = this.dependencies.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
    const store = new InMemoryEvolutionStore(workbenchId);
    const events = new Map<string, number>();
    // A collector rather than the real sink: the production events are how a real investigation is
    // read, and interleaving a synthetic run would make those logs harder to trust, not easier.
    const diagnostics: RuntimeDiagnostics = { emit: (event) => { events.set(event, (events.get(event) ?? 0) + 1); } };
    const service = new EvolutionService({
      store, diagnostics,
      model: new DeterministicEvolutionModel(store, workbenchId),
      now: this.dependencies.now,
      id: () => `${this.dependencies.id()}:dry`,
    });

    const inputId = `evolution:${workbenchId}`;
    const phases: EvolutionDryRunPhaseDto[] = [];
    let tracker: PhaseTracker | null = null;
    let steps = 0;

    // One step is one bounded model call, matching the scheduler's cadence: the batch only advances
    // because the loop keeps asking, which is the property a real unattended run depends on. The loop
    // is post-tested rather than gated on the batch, because the batch does not exist until the first
    // step creates it.
    for (;;) {
      if (steps >= maxSteps || Date.now() - startedAt > timeBudgetMs) break;
      const before = store.read();
      const beforePhase = before.batch?.phase ?? null;
      const beforeRollouts = before.batch?.rollouts.length ?? 0;
      steps += 1;
      await service.handle(inputId);
      const after = store.read();
      const afterRollouts = after.batch?.rollouts.length ?? 0;
      // The step that creates the batch also issues its first call, so a step with no phase yet
      // belongs to the phase it produced. Every other step belongs to the phase it started in.
      const phase = beforePhase ?? after.batch?.phase ?? null;
      // Rollouts are cumulative, so a phase's own count is its high-water mark minus what it inherited.
      // Taking the post-step count too keeps the last rollout of a phase attributed to that phase even
      // when completing it is what moved the batch on.
      if (phase !== null) {
        if (tracker !== null && tracker.phase === phase) {
          tracker.steps += 1;
          tracker.cumulativeRollouts = Math.max(tracker.cumulativeRollouts, beforeRollouts, afterRollouts);
        } else {
          if (tracker !== null) phases.push(finishPhase(tracker));
          tracker = { phase, steps: 1, entryRollouts: beforeRollouts, cumulativeRollouts: Math.max(beforeRollouts, afterRollouts) };
        }
      }
      if (after.batch === null) break;
    }
    if (tracker !== null) {
      tracker.cumulativeRollouts = Math.max(tracker.cumulativeRollouts, store.maxRolloutsObserved());
      phases.push(finishPhase(tracker));
    }

    const state = store.read();
    const truncated = state.batch !== null;
    const promoted = state.activeRevisionId !== null;
    const candidate = state.revisions.at(-1) ?? null;
    const outcome: EvolutionDryRunOutcome = truncated ? "truncated"
      : promoted ? "promoted"
        : state.callSequence === 0 ? "not_started" : "rejected";
    return {
      workbenchId, outcome, promoted, steps, phases, truncated,
      // "collecting" is the untouched initial reason, so it would misdescribe a run that never started.
      verdict: outcome === "not_started" ? null : state.reason,
      blockedAt: promoted ? null : { phase: state.batch?.phase ?? phases.at(-1)?.phase ?? null, reason: state.reason },
      revision: promoted ? projectRevision(state.revisions.find((r) => r.revisionId === state.activeRevisionId)) : null,
      evaluation: candidate?.evaluation === undefined ? null : {
        scenarios: candidate.evaluation.length,
        baselineSuccesses: candidate.baselineSuccesses,
        candidateSuccesses: candidate.candidateSuccesses,
        evaluatedRuns: candidate.evaluatedRuns,
      },
      // The stand-in is authored to promote. A miss means the fixtures drifted, not that the pipeline broke.
      selfCheck: { expectedVerdict: "promote", matched: promoted },
      syntheticEvidence: store.syntheticPool(),
      events: [...events.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
      durationMs: Date.now() - startedAt,
    };
  }
}

function finishPhase(tracker: PhaseTracker): EvolutionDryRunPhaseDto {
  return { phase: tracker.phase, steps: tracker.steps, rollouts: Math.max(0, tracker.cumulativeRollouts - tracker.entryRollouts) };
}

/** Field by field, so the revision's strategy, pin and evidence ids stay out of the report. */
function projectRevision(revision: EvolutionRevision | undefined): EvolutionVersionDto | null {
  if (revision === undefined) return null;
  const { revisionId, parentRevisionId, module, status, createdAt, reason, baselineSuccesses, candidateSuccesses, evaluatedRuns } = revision;
  return { revisionId, parentRevisionId, module, status, createdAt, reason, baselineSuccesses, candidateSuccesses, evaluatedRuns };
}
