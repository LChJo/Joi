import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
} from "../../ports/runtime-diagnostics.js";
import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";
import type { JoiTaskInbox, JoiTaskPendingInput, JoiTurnDriver, ModelSourceGate } from "../../ports/joi-task.js";
import { isSynthesisOutputFailure, isTerminalTurnFailure, JOI_TURN_FAILURE_LIMIT, JOI_TURN_RETRY_BASE_MILLIS, JOI_TURN_RETRY_MAX_MILLIS } from "../../../domain/work/joi-turn-recovery.js";

const DEFAULT_ORPHAN_SCAN_EVERY_MILLIS = 30_000;
// The stale-turn orphan sweep must run strictly after the in-memory stall abort so a
// Turn that is still being driven is never failed out from under the stall watchdog
// (orphan detection 20 min > stall abort 15 min).
const DEFAULT_STALE_TURN_OLDER_THAN_MILLIS = 20 * 60_000;
const DEFAULT_STALLED_TURN_AFTER_MILLIS = 15 * 60_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = JOI_TURN_FAILURE_LIMIT;
// A deterministic failure re-claimed the very next tick would burn the whole crash-loop
// budget in seconds while reproducing itself. Back each retry off exponentially so the
// breaker measures patience in minutes, not milliseconds.
const DEFAULT_RETRY_BACKOFF_BASE_MILLIS = JOI_TURN_RETRY_BASE_MILLIS;
const DEFAULT_RETRY_BACKOFF_MAX_MILLIS = JOI_TURN_RETRY_MAX_MILLIS;
const MAX_CONCURRENT_SYNTHESES = 4;

interface InFlightTurn {
  abortController: AbortController;
  cancelRequested: boolean;
  errorCode?: string;
  goalInputId: string;
  inputId: string;
  settled: "failed" | "ok" | undefined;
  startedAt: number;
  synthesis: boolean;
  userCanceled?: boolean;
  retryEpoch?: number;
}

/**
 * Schedules PENDING rows and reserves each goal until its driver settles.
 * Independent syntheses share bounded capacity alongside the ordinary serial slot.
 */
export class JoiTaskComponent implements ActorComponent {
  readonly componentName = "joi-task";
  #backoffUntil = new Map<string, number>();
  #failures = new Map<string, number>();
  #inFlight = new Map<string, InFlightTurn>();
  #lastOrphanScanAt = 0;

  constructor(private readonly dependencies: {
    driver: JoiTurnDriver;
    gate: ModelSourceGate;
    inbox: JoiTaskInbox;
    maxConsecutiveFailures?: number;
    orphanScanEveryMillis?: number;
    retryBackoffBaseMillis?: number;
    retryBackoffMaxMillis?: number;
    staleTurnOlderThanMillis?: number;
    stalledTurnAfterMillis?: number;
  }) {}

  async update(ctx: ActorTickContext): Promise<void> {
    for (const turn of this.#inFlight.values()) await this.#converge(ctx, turn);
    await this.#startPending(ctx);
    await this.#recoverOrphanTurns(ctx);
  }

  async #converge(ctx: ActorTickContext, turn: InFlightTurn): Promise<void> {
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
      // Keep the goal reserved until the driver promise settles.
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
      // A retry must wait for the aborted provider request to settle.
      return;
    }
    this.#inFlight.delete(turn.inputId);
    const outcome = turn.settled ?? "failed";
    const errorCode = outcome === "failed" ? turn.errorCode ?? "joi_task_turn_stalled" : undefined;
    if (turn.userCanceled === true) {
      // A canceled goal is a user decision, not a scheduler fault: never count it toward
      // the crash-loop breaker and never park the (already terminal) input.
      this.#failures.delete(turn.inputId);
      this.#backoffUntil.delete(turn.inputId);
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
      await this.dependencies.inbox.recordSchedulingFailure?.(turn.inputId, {
        startedAt: new Date(turn.startedAt).toISOString(), failedAt: ctx.now.toISOString(), reasonCode: errorCode ?? "joi_task_turn_failed",
        ...(turn.retryEpoch === undefined ? {} : { epoch: turn.retryEpoch }),
      });
      const retryState = await this.dependencies.inbox.getRetryState?.(turn.inputId);
      const failures = retryState?.failureCount ?? (this.#failures.get(turn.inputId) ?? 0) + 1;
      const terminalFailure = isTerminalTurnFailure(errorCode ?? "")
        || turn.inputId.startsWith("joi_result_input:") && isSynthesisOutputFailure(errorCode ?? "");
      const superseded = turn.retryEpoch !== undefined && retryState !== undefined && turn.retryEpoch !== retryState.epoch;
      if (superseded || retryState?.failureCount === 0 || !terminalFailure && retryState?.queued === false) {
        this.#failures.delete(turn.inputId);
        this.#backoffUntil.delete(turn.inputId);
      } else if (terminalFailure || failures >= (this.dependencies.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES)) {
        this.#failures.delete(turn.inputId);
        this.#backoffUntil.delete(turn.inputId);
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
        const backoff = this.#retryBackoff(failures);
        const retryAt = new Date((retryState?.failedAt === undefined ? ctx.now.getTime() : Date.parse(retryState.failedAt)) + backoff);
        const deferred = await this.dependencies.inbox.deferRetry?.(turn.inputId, {
          failureCount: failures, retryAt: retryAt.toISOString(),
          ...(turn.retryEpoch === undefined ? {} : { epoch: turn.retryEpoch }),
        }) ?? true;
        if (deferred) {
          this.#backoffUntil.set(turn.inputId, retryAt.getTime());
          emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.input_backoff", {
            backoffMillis: backoff,
            consecutiveFailures: failures,
            inputId: turn.inputId,
          });
        }
      }
    } else {
      this.#failures.delete(turn.inputId);
      this.#backoffUntil.delete(turn.inputId);
    }
    emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.turn_settled", {
      durationMs: Math.max(0, ctx.now.getTime() - turn.startedAt),
      inputId: turn.inputId,
      outcome,
    });
  }

  async #startPending(ctx: ActorTickContext): Promise<void> {
    const activeGoals = new Set<string>();
    let ordinaryRunning = false;
    let synthesisCount = 0;
    for (const turn of this.#inFlight.values()) {
      activeGoals.add(turn.goalInputId);
      if (turn.synthesis) synthesisCount += 1;
      else ordinaryRunning = true;
    }
    if (ordinaryRunning && synthesisCount >= MAX_CONCURRENT_SYNTHESES) return;

    const pending = await this.dependencies.inbox.listPendingInputs();
    const now = ctx.now.getTime();
    // Cooldowns belong to the queued attempt; explicit continuation starts a fresh retry epoch.
    const queued = new Set(pending.map((candidate) => candidate.inputId));
    for (const inputId of [...this.#backoffUntil.keys()]) {
      if (!queued.has(inputId)) this.#backoffUntil.delete(inputId);
    }
    for (const candidate of pending) {
      if (activeGoals.has(candidate.goalInputId ?? candidate.inputId)) continue;
      const state = candidate.retryState;
      if (state === undefined) continue;
      if (state.failureCount === 0) {
        this.#backoffUntil.delete(candidate.inputId);
        this.#failures.delete(candidate.inputId);
        continue;
      }
      if (isTerminalTurnFailure(state.reasonCode ?? "")
        || candidate.inputId.startsWith("joi_result_input:") && isSynthesisOutputFailure(state.reasonCode ?? "")
        || state.failureCount >= (this.dependencies.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES)) {
        await this.dependencies.inbox.park(candidate.inputId, { failureCount: state.failureCount, reasonCode: state.reasonCode ?? "joi_task_turn_failed" });
        this.#backoffUntil.set(candidate.inputId, Number.POSITIVE_INFINITY);
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.input_parked", {
          inputId: candidate.inputId, consecutiveFailures: state.failureCount, errorCode: state.reasonCode ?? "joi_task_turn_failed",
        });
        continue;
      }
      const retryAt = state.retryAt ?? (state.failedAt === undefined ? undefined : new Date(Date.parse(state.failedAt) + this.#retryBackoff(state.failureCount)).toISOString());
      if (retryAt !== undefined) {
        if (state.retryAt === undefined) {
          const deferred = await this.dependencies.inbox.deferRetry?.(candidate.inputId, { failureCount: state.failureCount, retryAt, epoch: state.epoch });
          if (deferred === false) {
            this.#backoffUntil.set(candidate.inputId, Number.POSITIVE_INFINITY);
            continue;
          }
        }
        this.#backoffUntil.set(candidate.inputId, Date.parse(retryAt));
      }
    }
    let ready: boolean | undefined;
    for (const candidate of pending) {
      const goalInputId = candidate.goalInputId ?? candidate.inputId;
      if (activeGoals.has(goalInputId)) continue;
      const until = this.#backoffUntil.get(candidate.inputId);
      if (until !== undefined && until > now) continue;
      const synthesis = candidate.synthesis === true;
      if (synthesis ? synthesisCount >= MAX_CONCURRENT_SYNTHESES : ordinaryRunning) continue;
      if (candidate.inputId.startsWith("evolution:") && this.#inFlight.size > 0) continue;
      if (candidate.requiresModelSource !== false && !(ready ??= await this.dependencies.gate.hasReadySource())) continue;
      this.#startTurn(ctx, candidate, goalInputId, synthesis);
      activeGoals.add(goalInputId);
      if (synthesis) synthesisCount += 1;
      else ordinaryRunning = true;
    }
  }

  #startTurn(ctx: ActorTickContext, candidate: JoiTaskPendingInput, goalInputId: string, synthesis: boolean): void {
    const { inputId, retryState } = candidate;
    const startedAt = ctx.now.getTime();
    const abortController = new AbortController();
    const turn: InFlightTurn = { abortController, cancelRequested: false, goalInputId, inputId, settled: undefined, startedAt, synthesis,
      ...(retryState === undefined ? {} : { retryEpoch: retryState.epoch }) };
    this.#inFlight.set(inputId, turn);
    emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.input_started", { inputId });
    void this.dependencies.driver.handle(inputId, abortController.signal).then(() => {
      turn.settled = abortController.signal.aborted ? "failed" : "ok";
      if (abortController.signal.aborted) turn.errorCode = "joi_task_turn_canceled";
    }).catch((error: unknown) => {
      turn.settled = "failed";
      turn.errorCode = runtimeDiagnosticErrorCode(error);
    });
  }

  #retryBackoff(failures: number): number {
    const base = this.dependencies.retryBackoffBaseMillis ?? DEFAULT_RETRY_BACKOFF_BASE_MILLIS;
    const max = this.dependencies.retryBackoffMaxMillis ?? DEFAULT_RETRY_BACKOFF_MAX_MILLIS;
    return Math.min(max, base * 2 ** (failures - 1));
  }

  async #recoverOrphanTurns(ctx: ActorTickContext): Promise<void> {
    if (ctx.now.getTime() - this.#lastOrphanScanAt < (this.dependencies.orphanScanEveryMillis ?? DEFAULT_ORPHAN_SCAN_EVERY_MILLIS)) return;
    this.#lastOrphanScanAt = ctx.now.getTime();
    const olderThan = new Date(ctx.now.getTime() - (this.dependencies.staleTurnOlderThanMillis ?? DEFAULT_STALE_TURN_OLDER_THAN_MILLIS)).toISOString();
    for (const stale of await this.dependencies.inbox.listStaleRunningTurns(olderThan)) {
      if (this.#inFlight.has(stale.inputId)) continue;
      await this.dependencies.inbox.failTurn(stale.inputId, stale.turnId);
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.orphan_turn_recovered", {
        inputId: stale.inputId,
        turnId: stale.turnId,
      });
    }
    try {
      await this.dependencies.inbox.recoverInterruptedGoalReviews?.();
    } catch (error: unknown) {
      // Background repair is best-effort: never take down the traversal loop. The next
      // scheduled scan retries, and the underlying facts are still guarded on write.
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.task.review_recovery_failed", {
        errorCode: runtimeDiagnosticErrorCode(error),
      });
    }
  }
}
