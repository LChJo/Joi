import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
} from "../../ports/runtime-diagnostics.js";
import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";
import type { JoiTaskInbox, JoiTurnDriver, ModelSourceGate } from "../../ports/joi-task.js";

const DEFAULT_ORPHAN_SCAN_EVERY_MILLIS = 30_000;
// The stale-turn orphan sweep must run strictly after the in-memory stall abort so a
// Turn that is still being driven is never failed out from under the stall watchdog
// (orphan detection 20 min > stall abort 15 min).
const DEFAULT_STALE_TURN_OLDER_THAN_MILLIS = 20 * 60_000;
const DEFAULT_STALLED_TURN_AFTER_MILLIS = 15 * 60_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 8;

interface InFlightTurn {
  abortController: AbortController;
  cancelRequested: boolean;
  errorCode?: string;
  inputId: string;
  settled: "failed" | "ok" | undefined;
  startedAt: number;
  userCanceled?: boolean;
}

/**
 * Traversal-driven replacement for the notify-based input scheduler.
 * PENDING inbox rows are the scheduling truth (AC-10 single serial slot; AC-39 rerun
 * equivalence falls out of failTurn/clarify moving inputs back to PENDING).
 */
export class JoiTaskComponent implements ActorComponent {
  readonly componentName = "joi-task";
  #failures = new Map<string, number>();
  #inFlight: InFlightTurn | null = null;
  #lastOrphanScanAt = 0;

  constructor(private readonly dependencies: {
    driver: JoiTurnDriver;
    gate: ModelSourceGate;
    inbox: JoiTaskInbox;
    maxConsecutiveFailures?: number;
    orphanScanEveryMillis?: number;
    staleTurnOlderThanMillis?: number;
    stalledTurnAfterMillis?: number;
  }) {}

  get activeInputId(): string | undefined {
    return this.#inFlight?.inputId;
  }

  async update(ctx: ActorTickContext): Promise<void> {
    await this.#converge(ctx);
    if (this.#inFlight === null) await this.#startNext(ctx);
    await this.#recoverOrphanTurns(ctx);
  }

  async #converge(ctx: ActorTickContext): Promise<void> {
    const turn = this.#inFlight;
    if (turn === null) return;
    // A user cancel is a DB fact (canceled_at); abort the live reasoning session instead
    // of letting it run to completion. Checked every tick so the abort lands within one
    // actor cycle of the cancel request.
    if (turn.settled === undefined && !turn.cancelRequested && await this.dependencies.inbox.isCanceled(turn.inputId)) {
      turn.cancelRequested = true;
      turn.userCanceled = true;
      turn.abortController.abort();
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.turn_cancel_requested", {
        inputId: turn.inputId,
        reason: "user_canceled",
      });
      // Keep the serial slot occupied until the driver promise settles.
      return;
    }
    const stalled = turn.settled === undefined
      && ctx.now.getTime() - turn.startedAt >= (this.dependencies.stalledTurnAfterMillis ?? DEFAULT_STALLED_TURN_AFTER_MILLIS);
    if (turn.settled === undefined && !stalled) return;
    if (turn.settled === undefined && stalled) {
      if (!turn.cancelRequested) {
        turn.cancelRequested = true;
        turn.abortController.abort();
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.turn_cancel_requested", {
          inputId: turn.inputId,
          reason: "stalled",
        });
      }
      // Keep the serial slot occupied until the driver promise settles. Releasing it
      // here would let a retry overlap the still-running provider request.
      return;
    }
    this.#inFlight = null;
    const outcome = turn.settled ?? "failed";
    const errorCode = outcome === "failed" ? turn.errorCode ?? "joi_task_turn_stalled" : undefined;
    if (turn.userCanceled === true) {
      // A canceled goal is a user decision, not a scheduler fault: never count it toward
      // the crash-loop breaker and never park the (already terminal) input.
      this.#failures.delete(turn.inputId);
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.turn_canceled", {
        durationMs: Math.max(0, ctx.now.getTime() - turn.startedAt),
        inputId: turn.inputId,
      });
    } else if (outcome === "failed") {
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.input.scheduler_failed", {
        errorCode: errorCode ?? "joi_task_turn_failed",
        inputId: turn.inputId,
      });
      // Crash-loop breaker: a poisoned session or deterministic failure would otherwise
      // re-PEND and retry every tick forever. After N consecutive failures the input is
      // parked as an explicit system failure; user cancellation remains a separate fact.
      const failures = (this.#failures.get(turn.inputId) ?? 0) + 1;
      if (failures >= (this.dependencies.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES)) {
        this.#failures.delete(turn.inputId);
        await this.dependencies.inbox.park(turn.inputId, {
          failureCount: failures,
          reasonCode: errorCode ?? "joi_task_turn_failed",
        });
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.input_parked", {
          consecutiveFailures: failures,
          errorCode: errorCode ?? "joi_task_turn_failed",
          inputId: turn.inputId,
        });
      } else {
        this.#failures.set(turn.inputId, failures);
      }
    } else {
      this.#failures.delete(turn.inputId);
    }
    emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.turn_settled", {
      durationMs: Math.max(0, ctx.now.getTime() - turn.startedAt),
      inputId: turn.inputId,
      outcome,
    });
  }

  async #startNext(ctx: ActorTickContext): Promise<void> {
    const [next] = await this.dependencies.inbox.listPendingInputs();
    if (next === undefined) return;
    if (next.requiresModelSource !== false && !(await this.dependencies.gate.hasReadySource())) return;
    const inputId = next.inputId;
    const startedAt = ctx.now.getTime();
    const abortController = new AbortController();
    this.#inFlight = { abortController, cancelRequested: false, inputId, settled: undefined, startedAt };
    emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.input_started", { inputId });
    void this.dependencies.driver.handle(inputId, abortController.signal).then(() => {
      if (this.#inFlight?.inputId !== inputId) return;
      this.#inFlight.settled = abortController.signal.aborted ? "failed" : "ok";
      if (abortController.signal.aborted) this.#inFlight.errorCode = "joi_task_turn_canceled";
    }).catch((error: unknown) => {
      if (this.#inFlight?.inputId !== inputId) return;
      this.#inFlight.settled = "failed";
      this.#inFlight.errorCode = runtimeDiagnosticErrorCode(error);
    });
  }

  async #recoverOrphanTurns(ctx: ActorTickContext): Promise<void> {
    if (ctx.now.getTime() - this.#lastOrphanScanAt < (this.dependencies.orphanScanEveryMillis ?? DEFAULT_ORPHAN_SCAN_EVERY_MILLIS)) return;
    this.#lastOrphanScanAt = ctx.now.getTime();
    const olderThan = new Date(ctx.now.getTime() - (this.dependencies.staleTurnOlderThanMillis ?? DEFAULT_STALE_TURN_OLDER_THAN_MILLIS)).toISOString();
    for (const stale of await this.dependencies.inbox.listStaleRunningTurns(olderThan)) {
      await this.dependencies.inbox.failTurn(stale.inputId, stale.turnId);
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.orphan_turn_recovered", {
        inputId: stale.inputId,
        turnId: stale.turnId,
      });
    }
  }
}
