import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
} from "../../ports/runtime-diagnostics.js";
import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";
import type { JoiHarnessScan, JoiHarnessWriter } from "../../ports/joi-harness.js";

const DEFAULT_SCAN_EVERY_MILLIS = 10_000;
const DEFAULT_SLOW_SCAN_MILLIS = 50;
const SLOW_SCAN_REPORT_EVERY_MILLIS = 5 * 60_000;
const FEEDBACK_ENTRY_SUMMARY_LIMIT = 160;
/** How long a re-driven synthesis is given to run before the scan may re-drive it again. */
const STALLED_SYNTHESIS_COOLDOWN_MILLIS = 10 * 60_000;

/**
 * Traversal over harness map facts: adopts goals into maps on their first turn,
 * records completion feedback into the workbench task context once a map clears,
 * silently clears trivial maps, starts bounded recovery for blocked goals, posts
 * exactly one review input per completed result layer, and reconciles historical
 * review rows. A dedicated recovery input owns blocked-goal repair so the legacy
 * review reconciler cannot race it or turn an internal failure into user work.
 * Never calls an LLM and never dispatches: progression is delegated to joi reasoning
 * turns via PENDING rows in joi_inbox_messages (single scheduling authority stays
 * with the task slot).
 */
export class JoiHarnessComponent implements ActorComponent {
  readonly componentName = "joi-harness";
  #lastScanAt = 0;
  readonly #lastSlowReportAt = new Map<string, number>();

  constructor(private readonly dependencies: {
    reviewEnabled?: boolean;
    monotonicNow?: () => number;
    scan: JoiHarnessScan;
    scanEveryMillis?: number;
    slowScanMillis?: number;
    writer: JoiHarnessWriter;
  }) {}

  async update(ctx: ActorTickContext): Promise<void> {
    const everyMillis = this.dependencies.scanEveryMillis ?? DEFAULT_SCAN_EVERY_MILLIS;
    if (ctx.now.getTime() - this.#lastScanAt < everyMillis) return;
    this.#lastScanAt = ctx.now.getTime();
    await this.#step(ctx, "adopt", () => this.#adoptNewGoals(ctx));
    await this.#step(ctx, "paths", () => this.#synchronizeWorkPaths(ctx));
    await this.#step(ctx, "feedback", () => this.#recordCompletionFeedback(ctx));
    await this.#step(ctx, "trivial_clear", () => this.#clearTrivialMaps(ctx));
    await this.#step(ctx, "work_recovery", () => this.#enqueueWorkRecoveries(ctx));
    await this.#step(ctx, "stalled_synthesis", () => this.#redriveStalledSyntheses(ctx));
    if (this.dependencies.reviewEnabled === true) {
      await this.#step(ctx, "reopen_unreviewed", () => this.#reopenUnreviewedMaps(ctx));
      await this.#step(ctx, "close_finished_paths", () => this.#closeFinishedPaths(ctx));
      await this.#step(ctx, "review", () => this.#enqueueReviews(ctx));
      await this.#step(ctx, "continuation_decision", () => this.#requestContinuationDecisions(ctx));
      await this.#step(ctx, "review_recovery", () => this.#reconcileReviews(ctx));
    }
  }

  async #synchronizeWorkPaths(ctx: ActorTickContext): Promise<void> {
    const result = await this.dependencies.writer.synchronizeWorkPaths({ now: ctx.now.toISOString() });
    if (result.created > 0 || result.closed > 0) {
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.paths_synchronized", result);
    }
  }

  async #step(ctx: ActorTickContext, step: string, action: () => Promise<void>): Promise<void> {
    const monotonicNow = this.dependencies.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();
    try {
      await action();
    } catch (error) {
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.scan_failed", {
        errorCode: runtimeDiagnosticErrorCode(error),
        step,
      });
    }
    const durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
    const lastReportedAt = this.#lastSlowReportAt.get(step) ?? Number.NEGATIVE_INFINITY;
    if (durationMs >= (this.dependencies.slowScanMillis ?? DEFAULT_SLOW_SCAN_MILLIS)
      && ctx.now.getTime() - lastReportedAt >= SLOW_SCAN_REPORT_EVERY_MILLIS) {
      this.#lastSlowReportAt.set(step, ctx.now.getTime());
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.actor.scan_slow", {
        componentName: this.componentName,
        durationMs,
        step,
      });
    }
  }

  async #adoptNewGoals(ctx: ActorTickContext): Promise<void> {
    for (const seed of await this.dependencies.scan.listGoalsWithoutMap()) {
      const created = await this.dependencies.writer.createMap({ ...seed, now: ctx.now.toISOString() });
      if (created) {
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.map_created", { goalInputId: seed.goalInputId });
      }
    }
  }

  async #recordCompletionFeedback(ctx: ActorTickContext): Promise<void> {
    for (const target of await this.dependencies.scan.listFeedbackTargets()) {
      const heading = target.destination ?? "目标";
      const summary = target.completionSummary.trim() === "" ? "目标已收尾" : target.completionSummary.slice(0, FEEDBACK_ENTRY_SUMMARY_LIMIT);
      const outcomeLabel = target.acceptedWithGaps === true ? "接受当前结果（有缺口）" : "达成";
      const entry = `[${ctx.now.toISOString().slice(0, 10)}] 「${heading}」${outcomeLabel}：${summary}`;
      const recorded = await this.dependencies.writer.recordCompletionFeedback({
        workbenchId: target.workbenchId,
        entry,
        goalInputId: target.goalInputId,
        now: ctx.now.toISOString(),
      });
      if (recorded) {
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.feedback_recorded", {
          workbenchId: target.workbenchId,
          goalInputId: target.goalInputId,
        });
      }
    }
  }

  async #clearTrivialMaps(ctx: ActorTickContext): Promise<void> {
    for (const candidate of await this.dependencies.scan.listTrivialMapCandidates()) {
      const cleared = await this.dependencies.writer.clearTrivialMap({ goalInputId: candidate.goalInputId, now: ctx.now.toISOString() });
      if (cleared) {
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.map_cleared_trivial", { goalInputId: candidate.goalInputId });
      }
    }
  }

  async #enqueueReviews(ctx: ActorTickContext): Promise<void> {
    for (const digest of await this.dependencies.scan.listReviewDigests()) {
      const inputId = await this.dependencies.writer.enqueueReview({ digest, now: ctx.now.toISOString() });
      if (inputId !== null) {
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.review_enqueued", {
          goalInputId: digest.goalInputId,
          inputId,
          resultRevision: digest.resultRevision,
        });
      }
    }
  }

  async #enqueueWorkRecoveries(ctx: ActorTickContext): Promise<void> {
    if (this.dependencies.scan.listWorkRecoverySeeds === undefined || this.dependencies.writer.enqueueWorkRecovery === undefined) return;
    for (const seed of await this.dependencies.scan.listWorkRecoverySeeds()) {
      const inputId = await this.dependencies.writer.enqueueWorkRecovery({ now: ctx.now.toISOString(), seed });
      if (inputId !== null) emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.work_recovery_enqueued", {
        attemptNo: seed.attemptNo,
        goalInputId: seed.goalInputId,
        inputId,
        sourceWorkId: seed.sourceWorkId,
      });
    }
  }

  async #requestContinuationDecisions(ctx: ActorTickContext): Promise<void> {
    if (this.dependencies.scan.listContinuationDecisionSeeds === undefined
      || this.dependencies.writer.requestContinuationDecision === undefined) return;
    for (const seed of await this.dependencies.scan.listContinuationDecisionSeeds()) {
      const created = await this.dependencies.writer.requestContinuationDecision({ now: ctx.now.toISOString(), seed });
      if (created) emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.continuation_decision_requested", {
        goalInputId: seed.goalInputId,
        resultRevision: seed.resultRevision,
      });
    }
  }

  /**
   * Re-drives a synthesis that no other scan can reach: once every Work is terminal and the
   * synthesis input has been consumed, a result revision that never got synthesized has no path
   * back into the scheduler. The cooldown bounds this to one attempt per goal per window, so a
   * synthesis that keeps failing settles into a slow retry instead of a hot loop.
   */
  async #redriveStalledSyntheses(ctx: ActorTickContext): Promise<void> {
    if (this.dependencies.scan.listStalledSyntheses === undefined
      || this.dependencies.writer.redriveSynthesis === undefined) return;
    const stalled = await this.dependencies.scan.listStalledSyntheses({
      cooldownMillis: STALLED_SYNTHESIS_COOLDOWN_MILLIS,
      now: ctx.now.toISOString(),
    });
    for (const seed of stalled) {
      const redriven = await this.dependencies.writer.redriveSynthesis({ now: ctx.now.toISOString(), seed });
      if (redriven) emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.stalled_synthesis_redriven", {
        goalInputId: seed.goalInputId,
        resultRevision: seed.resultRevision,
      });
    }
  }

  /**
   * A close-out can outrun the result it was reading: a Work turns terminal a few milliseconds
   * before its result joins the goal's result set, so the map may be CLEARED while a newer layer
   * is still arriving. Both surfaces that could arrange that layer — review and continuation —
   * require an ACTIVE map, so nothing ever revisits the goal and its card reports review forever.
   * Returning the map to ACTIVE lets the review scan below adopt the layer within this same tick.
   */
  async #reopenUnreviewedMaps(ctx: ActorTickContext): Promise<void> {
    if (this.dependencies.scan.listUnreviewedClearedMaps === undefined
      || this.dependencies.writer.reopenUnreviewedMap === undefined) return;
    for (const seed of await this.dependencies.scan.listUnreviewedClearedMaps()) {
      const reopened = await this.dependencies.writer.reopenUnreviewedMap({ now: ctx.now.toISOString(), seed });
      if (reopened) emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.map_reopened", {
        goalInputId: seed.goalInputId,
        resultRevision: seed.resultRevision,
      });
    }
  }

  /**
   * Closes the routes a finished goal's review left open.
   *
   * `REVIEW_FACTS_COMPLETE_SQL` wants every path closed before a map may clear, and only a review
   * turn closes one — but a review is queued by a new revision, and `enqueueReview` advances
   * `reviewed_revision` as it queues. A review that finished with a route still open therefore has
   * no successor, and the goal sits behind a "reviewing" badge with every other fact already
   * settled. Such a route is a plan the work moved past rather than work outstanding: nothing is
   * running, and the goal's own outcome already says COMPLETED.
   */
  async #closeFinishedPaths(ctx: ActorTickContext): Promise<void> {
    if (this.dependencies.scan.listFinishedGoalsWithOpenPaths === undefined
      || this.dependencies.writer.closeFinishedGoalPaths === undefined) return;
    for (const seed of await this.dependencies.scan.listFinishedGoalsWithOpenPaths()) {
      const closed = await this.dependencies.writer.closeFinishedGoalPaths({ now: ctx.now.toISOString(), seed });
      if (closed > 0) emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.finished_paths_closed", {
        closed,
        goalInputId: seed.goalInputId,
      });
    }
  }

  async #reconcileReviews(ctx: ActorTickContext): Promise<void> {
    for (const candidate of await this.dependencies.scan.listReviewRecoveries()) {
      const result = await this.dependencies.writer.reconcileReview({ candidate, now: ctx.now.toISOString() });
      if (result === null) continue;
      const diagnostic = result.action === "REQUEUED"
        ? "joi.harness.review_requeued"
        : result.action === "AUTO_CLEARED"
          ? "joi.harness.review_auto_cleared"
          : "joi.harness.review_quarantined";
      emitRuntimeDiagnostic(ctx.diagnostics, diagnostic, {
        goalInputId: candidate.digest.goalInputId,
        reasonCode: candidate.reasonCode,
        ...(result.inputId === undefined ? {} : { inputId: result.inputId }),
        resultRevision: candidate.digest.resultRevision,
      });
    }
  }
}
