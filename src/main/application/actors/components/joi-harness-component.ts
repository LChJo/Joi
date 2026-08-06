import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
} from "../../ports/runtime-diagnostics.js";
import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";
import type { JoiHarnessScan, JoiHarnessWriter } from "../../ports/joi-harness.js";

const DEFAULT_SCAN_EVERY_MILLIS = 10_000;
const FEEDBACK_ENTRY_SUMMARY_LIMIT = 160;

/**
 * Traversal over harness map facts: adopts goals into maps on their first turn,
 * records completion feedback into the workbench task context once a map clears,
 * silently clears trivial maps, and — once review is enabled — posts exactly one
 * review input per completed result layer. Never calls an LLM and never
 * dispatches: progression is delegated to joi reasoning turns via PENDING rows
 * in joi_inbox_messages (single scheduling authority stays with the task slot).
 */
export class JoiHarnessComponent implements ActorComponent {
  readonly componentName = "joi-harness";
  #lastScanAt = 0;

  constructor(private readonly dependencies: {
    reviewEnabled?: boolean;
    scan: JoiHarnessScan;
    scanEveryMillis?: number;
    writer: JoiHarnessWriter;
  }) {}

  async update(ctx: ActorTickContext): Promise<void> {
    const everyMillis = this.dependencies.scanEveryMillis ?? DEFAULT_SCAN_EVERY_MILLIS;
    if (ctx.now.getTime() - this.#lastScanAt < everyMillis) return;
    this.#lastScanAt = ctx.now.getTime();
    await this.#step(ctx, "adopt", () => this.#adoptNewGoals(ctx));
    await this.#step(ctx, "feedback", () => this.#recordCompletionFeedback(ctx));
    await this.#step(ctx, "trivial_clear", () => this.#clearTrivialMaps(ctx));
    if (this.dependencies.reviewEnabled === true) {
      await this.#step(ctx, "review", () => this.#enqueueReviews(ctx));
    }
  }

  async #step(ctx: ActorTickContext, step: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.harness.scan_failed", {
        errorCode: runtimeDiagnosticErrorCode(error),
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
      const entry = `[${ctx.now.toISOString().slice(0, 10)}] 「${heading}」达成：${summary}`;
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
}
