import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";
import { emitRuntimeDiagnostic } from "../../ports/runtime-diagnostics.js";

const DEFAULT_SLOW_SCAN_MILLIS = 50;
const SLOW_SCAN_REPORT_EVERY_MILLIS = 5 * 60_000;

/** Bounded fact traversal; all inference stays in the existing Joi task slot. */
export class EvolutionComponent implements ActorComponent {
  readonly componentName = "joi-evolution";
  #lastScanAt = Number.NEGATIVE_INFINITY;
  #lastSlowReportAt = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly evolution: { scan(): void },
    private readonly options?: { monotonicNow?: () => number; slowScanMillis?: number },
  ) {}
  update(ctx: ActorTickContext): Promise<void> {
    if (ctx.now.getTime() - this.#lastScanAt >= 10_000) {
      this.#lastScanAt = ctx.now.getTime();
      const monotonicNow = this.options?.monotonicNow ?? (() => performance.now());
      const startedAt = monotonicNow();
      this.evolution.scan();
      const durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
      if (durationMs >= (this.options?.slowScanMillis ?? DEFAULT_SLOW_SCAN_MILLIS)
        && ctx.now.getTime() - this.#lastSlowReportAt >= SLOW_SCAN_REPORT_EVERY_MILLIS) {
        this.#lastSlowReportAt = ctx.now.getTime();
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.actor.scan_slow", {
          componentName: this.componentName,
          durationMs,
          step: "scan",
        });
      }
    }
    return Promise.resolve();
  }
}
