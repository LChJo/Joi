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

const CLAIM_LEASE_MILLIS = 120_000;
const DEFAULT_ORPHAN_SCAN_EVERY_MILLIS = 30_000;
const DEFAULT_WAITING_RETRY_EVERY_MILLIS = 30_000;
/** Scheduling contention is expected while another Work owns a write lease. */
const WORKSPACE_CONTENTION_RETRY_MILLIS = 5_000;
/** Renew the workspace lease once its remaining lifetime drops below this margin. */
const LEASE_RENEW_MARGIN_MILLIS = 60_000;
/** Backstop above the engine deadlines (30 min total): a run past this age is converged as hung. */
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
  startedAt: number;
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
  #completeFailures = 0;
  #inFlight: InFlightRun | null = null;
  #lastOrphanScanAt = 0;
  #nextWaitingRetryAt = 0;
  readonly #orphanInFlight = new Set<string>();
  #retryAvailableAt = 0;

  constructor(private readonly dependencies: {
    workbenchId: string;
    claims: PartnerDispatchClaims;
    delivery: PartnerDispatchDelivery;
    leases?: WorkspaceLeaseRenewal;
    orphanScanEveryMillis?: number;
    outbox: Pick<RuntimeStore, "claimOutboxById" | "completeOutbox" | "releaseOutbox">;
    owner: string;
    partnerId: string;
    waitingRetryEveryMillis?: number;
    watchdogMillis?: number;
  }) {}

  get inFlightAttemptId(): string | undefined {
    return this.#inFlight?.dispatchAttemptId;
  }

  async update(ctx: ActorTickContext): Promise<void> {
    await this.#renewLease(ctx);
    await this.#converge(ctx);
    await this.#scanOrphans(ctx);
    if (this.#inFlight !== null || this.#orphanInFlight.size > 0 || ctx.now.getTime() < this.#retryAvailableAt) return;
    await this.#claimAndStart(ctx);
  }

  /**
   * Heartbeats the workspace lease of the in-flight run so a live process keeps
   * exclusivity indefinitely while a dead process's lease expires and is swept.
   * A lost lease converges the run to a non-replayable UNKNOWN terminal result.
   */
  async #renewLease(ctx: ActorTickContext): Promise<void> {
    const run = this.#inFlight;
    if (run === null || run.settled !== undefined) return;
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
    const run = this.#inFlight;
    if (run === null) return;
    if (run.settled === undefined) {
      const watchdogMillis = this.dependencies.watchdogMillis ?? DEFAULT_WATCHDOG_MILLIS;
      if (ctx.now.getTime() - run.startedAt > watchdogMillis) {
        // The engine's own deadlines fire first; reaching this point means the run is
        // hung outside any bounded path. Abort it and converge a non-replayable UNKNOWN.
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
      if (ctx.now.getTime() < this.#nextWaitingRetryAt) return;
      this.#nextWaitingRetryAt = ctx.now.getTime() + (this.dependencies.waitingRetryEveryMillis ?? DEFAULT_WAITING_RETRY_EVERY_MILLIS);
      run.settled = undefined;
      const attemptId = run.dispatchAttemptId;
      void this.dependencies.delivery.run(run.prepared, { signal: run.abortController.signal }).then((next) => {
        if (this.#inFlight?.dispatchAttemptId === attemptId) this.#inFlight.settled = next;
      }).catch((error: unknown) => {
        if (this.#inFlight?.dispatchAttemptId === attemptId) this.#inFlight.settled = failedOutput(error);
      });
      return;
    }
    try {
      await this.dependencies.delivery.complete({ output, prepared: run.prepared });
    } catch (error) {
      this.#completeFailures += 1;
      if (this.#completeFailures >= MAX_COMPLETE_FAILURES) {
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.converge_stuck_cleared", {
          workbenchId: this.dependencies.workbenchId,
          dispatchAttemptId: run.dispatchAttemptId,
          errorCode: runtimeDiagnosticErrorCode(error),
          partnerId: this.dependencies.partnerId,
        });
        this.#inFlight = null;
        this.#completeFailures = 0;
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
    this.#completeFailures = 0;
    emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.run_converged", {
      workbenchId: this.dependencies.workbenchId,
      dispatchAttemptId: run.dispatchAttemptId,
      partnerId: this.dependencies.partnerId,
      status: output.status,
    });
    this.#inFlight = null;
  }

  async #scanOrphans(ctx: ActorTickContext): Promise<void> {
    if (ctx.now.getTime() - this.#lastOrphanScanAt < (this.dependencies.orphanScanEveryMillis ?? DEFAULT_ORPHAN_SCAN_EVERY_MILLIS)) return;
    this.#lastOrphanScanAt = ctx.now.getTime();
    const orphans = await this.dependencies.claims.listOrphanRuns({
      workbenchId: this.dependencies.workbenchId,
      partnerId: this.dependencies.partnerId,
    });
    for (const orphan of orphans) {
      if (orphan.dispatchAttemptId === this.#inFlight?.dispatchAttemptId) continue;
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
      const now = ctx.now.toISOString();
      const claimed = await this.dependencies.outbox.claimOutboxById({
        claimUntil: new Date(ctx.now.getTime() + CLAIM_LEASE_MILLIS).toISOString(),
        now,
        outboxId: claim.outboxId,
        owner: this.dependencies.owner,
      });
      if (claimed === null) continue;
      let prepared: PreparedDispatch | "skipped_terminal";
      try {
        prepared = await this.dependencies.delivery.prepare(claim);
      } catch (error) {
        const errorCode = runtimeDiagnosticErrorCode(error);
        if (errorCode === DISPATCH_POLICY_REASONS.workspaceLeaseConflict) {
          // A live Work legitimately owns this workspace. Keep this Work queued and
          // check again promptly after the owner completes; contention is not a broken
          // dispatch and must never consume the terminal preparation-failure budget.
          const availableAt = new Date(ctx.now.getTime() + WORKSPACE_CONTENTION_RETRY_MILLIS).toISOString();
          await this.dependencies.outbox.releaseOutbox({
            availableAt,
            outboxId: claim.outboxId,
            owner: this.dependencies.owner,
          });
          this.#retryAvailableAt = ctx.now.getTime() + WORKSPACE_CONTENTION_RETRY_MILLIS;
          emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.workspace_contended", {
            workbenchId: this.dependencies.workbenchId,
            dispatchAttemptId: claim.dispatchAttemptId,
            outboxId: claim.outboxId,
            partnerId: this.dependencies.partnerId,
          });
          return;
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
            this.#retryAvailableAt = ctx.now.getTime() + 5_000;
            return;
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
        this.#retryAvailableAt = ctx.now.getTime() + 5_000;
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.prepare_failed", {
          workbenchId: this.dependencies.workbenchId,
          errorCode,
          outboxId: claim.outboxId,
          partnerId: this.dependencies.partnerId,
        });
        return;
      }
      // Delivery is fully persisted after prepare; the outbox duty ends at this ack.
      await this.dependencies.outbox.completeOutbox(claim.outboxId, this.dependencies.owner);
      if (prepared === "skipped_terminal") continue;
      const abortController = new AbortController();
      this.#inFlight = {
        abortController,
        dispatchAttemptId: prepared.dispatchAttemptId,
        outboxId: claim.outboxId,
        prepared,
        settled: undefined,
        startedAt: ctx.now.getTime(),
      };
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.run_started", {
        workbenchId: this.dependencies.workbenchId,
        dispatchAttemptId: prepared.dispatchAttemptId,
        kind: prepared.kind,
        partnerId: this.dependencies.partnerId,
      });
      const attemptId = prepared.dispatchAttemptId;
      void this.dependencies.delivery.run(prepared, { signal: abortController.signal }).then((output) => {
        if (this.#inFlight?.dispatchAttemptId === attemptId) this.#inFlight.settled = output;
      }).catch((error: unknown) => {
        if (this.#inFlight?.dispatchAttemptId === attemptId) this.#inFlight.settled = failedOutput(error);
      });
      return;
    }
  }
}
