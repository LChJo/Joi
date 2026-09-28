import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
} from "../../ports/runtime-diagnostics.js";
import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";
import type {
  DispatchRunOutput,
  PartnerDispatchClaims,
  PartnerDispatchDelivery,
  PreparedDispatch,
  WorkspaceLeaseRenewal,
} from "../../ports/partner-dispatch-delivery.js";
import type { RuntimeStore } from "../../ports/runtime-store.js";
import type { PartnerRunFailure } from "../../partners/partner-run-failure.js";
import { partnerRunArtifactsFromError, partnerRunFailureFromError, safePartnerRunFailureBody } from "../../partners/partner-run-failure.js";
import { DISPATCH_POLICY_REASONS } from "../../work/dispatch-policy.js";
import type { LocalDispatchCapacityController } from "../../work/local-dispatch-capacity.js";

const CLAIM_LEASE_MILLIS = 120_000;
const DEFAULT_ORPHAN_SCAN_EVERY_MILLIS = 30_000;
const DEFAULT_WAITING_RETRY_EVERY_MILLIS = 30_000;
/**
 * How often an in-flight run's liveness reaches the database. A tick is two seconds, and the
 * readers only need to tell "a live process owns this" from "nothing does", so beating faster
 * than this buys nothing and costs a write per run per tick.
 */
const DEFAULT_RUN_HEARTBEAT_EVERY_MILLIS = 30_000;
/** Scheduling contention is expected while another Work owns a write lease. */
const WORKSPACE_CONTENTION_RETRY_MILLIS = 5_000;
/** Renew the workspace lease once its remaining lifetime drops below this margin. */
const LEASE_RENEW_MARGIN_MILLIS = 60_000;
/** Backstop for stalled delivery. Pi progress renews it; native engines retain their own total deadlines. */
const DEFAULT_WATCHDOG_MILLIS = 32 * 60_000;
/** A converge that keeps failing to persist is eventually force-cleared instead of jamming the slot. */
const MAX_COMPLETE_FAILURES = 10;
/** After this many failed preparation attempts the dispatch is abandoned with a terminal FAILED result. */
const MAX_PREPARE_ATTEMPTS = 6;

interface InFlightRun {
  abortController: AbortController;
  dispatchAttemptId: string;
  outboxId: string;
  prepared: PreparedDispatch;
  settled: DispatchRunOutput | undefined;
  lastProgressAt: number;
  /** Last time this run's liveness was written to the database; 0 beats on the first tick. */
  lastHeartbeatAt: number;
  completeFailures: number;
  nextWaitingRetryAt: number;
  capacityReserved: boolean;
}

function failedOutput(error: unknown): DispatchRunOutput & { kind: "terminal" } {
  const failure = partnerRunFailureFromError(error);
  return {
    artifacts: partnerRunArtifactsFromError(error), body: safePartnerRunFailureBody(failure), failure, kind: "terminal",
    status: failure.sideEffectState === "NONE" ? "FAILED" : "UNKNOWN",
  };
}

/**
 * Leaf-actor dispatch state machine for one (workbench, partner):
 * claim → prepare → ack outbox → fire run → converge terminal result on later ticks.
 * Orphaned runs (acked before a crash) are finalized before new claims.
 */
export class AgentDispatchComponent implements ActorComponent {
  readonly componentName = "agent-dispatch";
  readonly #inFlight = new Map<string, InFlightRun>();
  #lastOrphanScanAt = 0;
  readonly #orphanInFlight = new Set<string>();

  constructor(private readonly dependencies: {
    workbenchId: string;
    claims: PartnerDispatchClaims;
    capacity?: LocalDispatchCapacityController;
    delivery: PartnerDispatchDelivery;
    heartbeatEveryMillis?: number;
    leases?: WorkspaceLeaseRenewal;
    orphanScanEveryMillis?: number;
    outbox: Pick<RuntimeStore, "claimOutboxById" | "completeOutbox" | "releaseOutbox">;
    owner: string;
    partnerId: string;
    waitingRetryEveryMillis?: number;
    /** True when the in-flight run's goal was canceled; the run must then abort. */
    workCanceled?: (workId: string) => Promise<boolean>;
    watchdogMillis?: number;
  }) {}

  get inFlightAttemptId(): string | undefined {
    return this.#inFlight.keys().next().value;
  }

  async update(ctx: ActorTickContext): Promise<void> {
    await this.#renewLease(ctx);
    await this.#heartbeatRuns(ctx);
    await this.#converge(ctx);
    await this.#scanOrphans(ctx);
    if (this.#orphanInFlight.size > 0) return;
    await this.#claimAndStart(ctx);
  }

  /**
   * Tells the database that this process still owns its in-flight runs.
   *
   * `updated_at` on a run means "when did its state last change" and nothing writes it while a
   * partner works, so a long run is indistinguishable from an abandoned one. This is the only
   * runtime evidence that separates them, and a goal's recovery path waits on it: without a
   * live heartbeat the recovery cannot tell "still working" from "died", and the safe reading
   * of an unknown is to keep waiting forever.
   */
  async #heartbeatRuns(ctx: ActorTickContext): Promise<void> {
    if (this.dependencies.delivery.heartbeatRun === undefined) return;
    const everyMillis = this.dependencies.heartbeatEveryMillis ?? DEFAULT_RUN_HEARTBEAT_EVERY_MILLIS;
    const now = ctx.now.getTime();
    const stamp = ctx.now.toISOString();
    for (const run of this.#inFlight.values()) {
      if (run.settled !== undefined || now - run.lastHeartbeatAt < everyMillis) continue;
      run.lastHeartbeatAt = now;
      await this.dependencies.delivery.heartbeatRun({ dispatchAttemptId: run.dispatchAttemptId, now: stamp });
    }
  }

  /**
   * Heartbeats the workspace lease of the in-flight run so a live process keeps
   * exclusivity indefinitely while a dead process's lease expires and is swept.
   * A lost lease converges the run to a non-replayable UNKNOWN terminal result.
   */
  async #renewLease(ctx: ActorTickContext): Promise<void> {
    for (const run of this.#inFlight.values()) await this.#renewRunLease(ctx, run);
  }

  async #renewRunLease(ctx: ActorTickContext, run: InFlightRun): Promise<void> {
    if (run.settled !== undefined) return;
    const lease = run.prepared.workspaceLease;
    if (lease === undefined || this.dependencies.leases === undefined) return;
    if (Date.parse(lease.expiresAt) - ctx.now.getTime() > LEASE_RENEW_MARGIN_MILLIS) return;
    const renewed = await this.dependencies.leases.renew({ workId: lease.workId, workspaceRef: lease.workspaceRef });
    if (renewed === null) {
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.lease_lost", {
        workbenchId: this.dependencies.workbenchId,
        dispatchAttemptId: run.dispatchAttemptId,
        partnerId: this.dependencies.partnerId,
        workId: lease.workId,
      });
      const { workspaceLease: _lost, ...prepared } = run.prepared;
      void _lost;
      run.prepared = prepared;
      run.abortController.abort();
      const failure: PartnerRunFailure = {
        phase: "EXECUTION",
        reasonCode: "workspace_lease_lost",
        retryable: false,
        sideEffectState: "UNKNOWN",
      };
      run.settled = {
        artifacts: [],
        body: safePartnerRunFailureBody(failure),
        failure,
        kind: "terminal",
        status: "UNKNOWN",
      };
      return;
    }
    run.prepared = { ...run.prepared, workspaceLease: { ...lease, expiresAt: renewed.expiresAt } };
  }

  async #converge(ctx: ActorTickContext): Promise<void> {
    for (const run of [...this.#inFlight.values()]) await this.#convergeRun(ctx, run);
  }

  async #convergeRun(ctx: ActorTickContext, run: InFlightRun): Promise<void> {
    // A user cancel revokes the Work in DB (work_items CANCELED, attempt FAILED); abort the
    // live engine session instead of letting it run to completion. The terminal rows make
    // the later complete() a no-op, so converging here only releases the actor slot.
    if (run.settled === undefined && this.dependencies.workCanceled !== undefined
      && await this.dependencies.workCanceled(run.prepared.workId)) {
      run.abortController.abort();
      const failure: PartnerRunFailure = {
        phase: "EXECUTION",
        reasonCode: "goal_canceled",
        retryable: false,
        sideEffectState: "UNKNOWN",
      };
      run.settled = { artifacts: [], body: safePartnerRunFailureBody(failure), failure, kind: "terminal", status: "UNKNOWN" };
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.run_canceled", {
        workbenchId: this.dependencies.workbenchId,
        dispatchAttemptId: run.dispatchAttemptId,
        partnerId: this.dependencies.partnerId,
        workId: run.prepared.workId,
      });
    }
    if (run.settled === undefined) {
      const watchdogMillis = this.dependencies.watchdogMillis ?? DEFAULT_WATCHDOG_MILLIS;
      if (ctx.now.getTime() - run.lastProgressAt > watchdogMillis) {
        // Engine idle/total deadlines normally fire first. No progress within this
        // backstop indicates a stalled delivery or cleanup path. Abort it and converge a non-replayable UNKNOWN.
        run.abortController.abort();
        const failure: PartnerRunFailure = {
          phase: "EXECUTION",
          reasonCode: "dispatch_watchdog_timed_out",
          retryable: false,
          sideEffectState: "UNKNOWN",
        };
        run.settled = { artifacts: [], body: safePartnerRunFailureBody(failure), failure, kind: "terminal", status: "UNKNOWN" };
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.watchdog_abort", {
          workbenchId: this.dependencies.workbenchId,
          dispatchAttemptId: run.dispatchAttemptId,
          partnerId: this.dependencies.partnerId,
        });
      } else {
        return;
      }
    }
    const output = run.settled;
    if (output.kind === "waiting_remote") {
      if (ctx.now.getTime() < run.nextWaitingRetryAt) return;
      run.nextWaitingRetryAt = ctx.now.getTime() + (this.dependencies.waitingRetryEveryMillis ?? DEFAULT_WAITING_RETRY_EVERY_MILLIS);
      run.settled = undefined;
      const attemptId = run.dispatchAttemptId;
      void this.dependencies.delivery.run(run.prepared, { signal: run.abortController.signal }).then((next) => {
        const current = this.#inFlight.get(attemptId);
        if (current !== undefined) current.settled = next;
      }).catch((error: unknown) => {
        const current = this.#inFlight.get(attemptId);
        if (current !== undefined) current.settled = failedOutput(error);
      });
      return;
    }
    try {
      await this.dependencies.delivery.complete({ output, prepared: run.prepared });
    } catch (error) {
      run.completeFailures += 1;
      if (run.completeFailures >= MAX_COMPLETE_FAILURES) {
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.converge_stuck_cleared", {
          workbenchId: this.dependencies.workbenchId,
          dispatchAttemptId: run.dispatchAttemptId,
          errorCode: runtimeDiagnosticErrorCode(error),
          partnerId: this.dependencies.partnerId,
        });
        this.#releaseSlot(run);
      } else {
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.complete_failed", {
          workbenchId: this.dependencies.workbenchId,
          dispatchAttemptId: run.dispatchAttemptId,
          errorCode: runtimeDiagnosticErrorCode(error),
          partnerId: this.dependencies.partnerId,
        });
      }
      return;
    }
    emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.run_converged", {
      workbenchId: this.dependencies.workbenchId,
      dispatchAttemptId: run.dispatchAttemptId,
      partnerId: this.dependencies.partnerId,
      status: output.status,
    });
    this.#releaseSlot(run);
  }

  #releaseSlot(run: InFlightRun): void {
    this.#inFlight.delete(run.dispatchAttemptId);
    if (run.capacityReserved) this.dependencies.capacity?.release(run.dispatchAttemptId);
  }

  async #scanOrphans(ctx: ActorTickContext): Promise<void> {
    if (ctx.now.getTime() - this.#lastOrphanScanAt < (this.dependencies.orphanScanEveryMillis ?? DEFAULT_ORPHAN_SCAN_EVERY_MILLIS)) return;
    this.#lastOrphanScanAt = ctx.now.getTime();
    const orphans = await this.dependencies.claims.listOrphanRuns({
      workbenchId: this.dependencies.workbenchId,
      partnerId: this.dependencies.partnerId,
    });
    for (const orphan of orphans) {
      if (this.#inFlight.has(orphan.dispatchAttemptId)) continue;
      if (this.#orphanInFlight.has(orphan.dispatchAttemptId)) continue;
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.partner.orphan_found", {
        workbenchId: this.dependencies.workbenchId,
        dispatchAttemptId: orphan.dispatchAttemptId,
        kind: orphan.kind,
        partnerId: this.dependencies.partnerId,
        runId: orphan.runId,
      });
      this.#orphanInFlight.add(orphan.dispatchAttemptId);
      void this.dependencies.delivery.finalizeOrphan(orphan).catch((error: unknown) => {
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.partner.orphan_finalize_failed", {
          workbenchId: this.dependencies.workbenchId,
          dispatchAttemptId: orphan.dispatchAttemptId,
          errorCode: runtimeDiagnosticErrorCode(error),
          partnerId: this.dependencies.partnerId,
          runId: orphan.runId,
        });
      }).finally(() => {
        this.#orphanInFlight.delete(orphan.dispatchAttemptId);
      });
    }
  }

  async #claimAndStart(ctx: ActorTickContext): Promise<void> {
    const claims = await this.dependencies.claims.listClaimable({
      workbenchId: this.dependencies.workbenchId,
      now: ctx.now.toISOString(),
      partnerId: this.dependencies.partnerId,
    });
    for (const claim of claims) {
      if (claim.kind === "A2A" && [...this.#inFlight.values()].some((run) => run.prepared.kind === "A2A")) continue;
      let capacityReserved = false;
      if (claim.kind === "LOCAL_PI" && this.dependencies.capacity !== undefined) {
        const reservation = this.dependencies.capacity.reserve({
          dispatchAttemptId: claim.dispatchAttemptId,
          partnerId: this.dependencies.partnerId,
        });
        if (!reservation.acquired) {
          emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.capacity_queued", {
            workbenchId: this.dependencies.workbenchId,
            dispatchAttemptId: claim.dispatchAttemptId,
            partnerId: this.dependencies.partnerId,
            reasonCode: reservation.reasonCode,
          });
          break;
        }
        capacityReserved = true;
      }
      const now = ctx.now.toISOString();
      const claimed = await this.dependencies.outbox.claimOutboxById({
        claimUntil: new Date(ctx.now.getTime() + CLAIM_LEASE_MILLIS).toISOString(),
        now,
        outboxId: claim.outboxId,
        owner: this.dependencies.owner,
      });
      if (claimed === null) {
        if (capacityReserved) this.dependencies.capacity?.release(claim.dispatchAttemptId);
        continue;
      }
      let prepared: PreparedDispatch | "skipped_terminal";
      try {
        prepared = await this.dependencies.delivery.prepare(claim);
      } catch (error) {
        if (capacityReserved) this.dependencies.capacity?.release(claim.dispatchAttemptId);
        const errorCode = runtimeDiagnosticErrorCode(error);
        if (errorCode === DISPATCH_POLICY_REASONS.workspaceLeaseConflict || errorCode === "goal_execution_paused"
          || errorCode === "partner_instance_busy") {
          // A live Work legitimately owns this workspace. Keep this Work queued and
          // check again promptly after the owner completes; contention is not a broken
          // dispatch and must never consume the terminal preparation-failure budget.
          const availableAt = new Date(ctx.now.getTime() + WORKSPACE_CONTENTION_RETRY_MILLIS).toISOString();
          await this.dependencies.outbox.releaseOutbox({
            availableAt,
            outboxId: claim.outboxId,
            owner: this.dependencies.owner,
          });
          emitRuntimeDiagnostic(ctx.diagnostics, errorCode === DISPATCH_POLICY_REASONS.workspaceLeaseConflict
            ? "joi.agent.workspace_contended" : "joi.agent.resource_queued", {
            workbenchId: this.dependencies.workbenchId,
            dispatchAttemptId: claim.dispatchAttemptId,
            outboxId: claim.outboxId,
            partnerId: this.dependencies.partnerId,
            reasonCode: errorCode,
          });
          continue;
        }
        if (claim.attemptCount >= MAX_PREPARE_ATTEMPTS && this.dependencies.delivery.abandon !== undefined) {
          // Preparation keeps failing; end the dispatch with a visible terminal result
          // instead of retrying forever and silently jamming the goal. An abandon failure
          // falls through to the normal backoff so the claim is never leaked.
          try {
            await this.dependencies.delivery.abandon({ claim, reasonCode: errorCode });
            await this.dependencies.outbox.completeOutbox(claim.outboxId, this.dependencies.owner);
            emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.prepare_exhausted", {
              workbenchId: this.dependencies.workbenchId,
              dispatchAttemptId: claim.dispatchAttemptId,
              errorCode,
              outboxId: claim.outboxId,
              partnerId: this.dependencies.partnerId,
            });
            continue;
          } catch {
            // Fall through: the release below restores the claim for a later retry.
          }
        }
        const delayMinutes = Math.min(60, 2 ** Math.min(claim.attemptCount, 6));
        await this.dependencies.outbox.releaseOutbox({
          availableAt: new Date(ctx.now.getTime() + delayMinutes * 60_000).toISOString(),
          outboxId: claim.outboxId,
          owner: this.dependencies.owner,
        });
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.prepare_failed", {
          workbenchId: this.dependencies.workbenchId,
          errorCode,
          outboxId: claim.outboxId,
          partnerId: this.dependencies.partnerId,
        });
        continue;
      }
      // Delivery is fully persisted after prepare; the outbox duty ends at this ack.
      await this.dependencies.outbox.completeOutbox(claim.outboxId, this.dependencies.owner);
      if (prepared === "skipped_terminal") {
        if (capacityReserved) this.dependencies.capacity?.release(claim.dispatchAttemptId);
        continue;
      }
      const abortController = new AbortController();
      const run: InFlightRun = {
        abortController,
        capacityReserved,
        completeFailures: 0,
        dispatchAttemptId: prepared.dispatchAttemptId,
        outboxId: claim.outboxId,
        prepared,
        settled: undefined,
        // Not the dispatch moment: zero makes the next tick write this run's first beat instead
        // of waiting out a whole interval with no liveness on record.
        lastHeartbeatAt: 0,
        lastProgressAt: ctx.clock.now().getTime(),
        nextWaitingRetryAt: 0,
      };
      this.#inFlight.set(prepared.dispatchAttemptId, run);
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.run_started", {
        workbenchId: this.dependencies.workbenchId,
        dispatchAttemptId: prepared.dispatchAttemptId,
        kind: prepared.kind,
        partnerId: this.dependencies.partnerId,
      });
      const attemptId = prepared.dispatchAttemptId;
      void this.dependencies.delivery.run(prepared, {
        signal: abortController.signal,
        onProgress: () => {
          const active = this.#inFlight.get(attemptId);
          if (active !== undefined && !abortController.signal.aborted && active.settled === undefined) {
            active.lastProgressAt = ctx.clock.now().getTime();
          }
        },
      }).then((output) => {
        const active = this.#inFlight.get(attemptId);
        if (active !== undefined) active.settled = output;
      }).catch((error: unknown) => {
        const active = this.#inFlight.get(attemptId);
        if (active !== undefined) active.settled = failedOutput(error);
      });
    }
  }
}
