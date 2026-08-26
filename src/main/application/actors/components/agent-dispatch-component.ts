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
} from "../../ports/partner-dispatch-delivery.js";
import type { RuntimeStore } from "../../ports/runtime-store.js";
import { partnerRunFailureFromError, safePartnerRunFailureBody } from "../../partners/partner-run-failure.js";

const CLAIM_LEASE_MILLIS = 30_000;
const DEFAULT_ORPHAN_SCAN_EVERY_MILLIS = 30_000;
const DEFAULT_WAITING_RETRY_EVERY_MILLIS = 30_000;

interface InFlightRun {
  dispatchAttemptId: string;
  outboxId: string;
  prepared: PreparedDispatch;
  settled: DispatchRunOutput | undefined;
  startedAt: number;
}

function failedOutput(error: unknown): DispatchRunOutput & { kind: "terminal" } {
  const failure = partnerRunFailureFromError(error);
  return {
    artifacts: [], body: safePartnerRunFailureBody(failure), failure, kind: "terminal",
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
  #inFlight: InFlightRun | null = null;
  #lastOrphanScanAt = 0;
  #nextWaitingRetryAt = 0;
  readonly #orphanInFlight = new Set<string>();
  #retryAvailableAt = 0;

  constructor(private readonly dependencies: {
    workbenchId: string;
    claims: PartnerDispatchClaims;
    delivery: PartnerDispatchDelivery;
    orphanScanEveryMillis?: number;
    outbox: Pick<RuntimeStore, "claimOutboxById" | "completeOutbox" | "releaseOutbox">;
    owner: string;
    partnerId: string;
    waitingRetryEveryMillis?: number;
  }) {}

  get inFlightAttemptId(): string | undefined {
    return this.#inFlight?.dispatchAttemptId;
  }

  async update(ctx: ActorTickContext): Promise<void> {
    await this.#converge(ctx);
    await this.#scanOrphans(ctx);
    if (this.#inFlight !== null || this.#orphanInFlight.size > 0 || ctx.now.getTime() < this.#retryAvailableAt) return;
    await this.#claimAndStart(ctx);
  }

  async #converge(ctx: ActorTickContext): Promise<void> {
    const run = this.#inFlight;
    if (run?.settled === undefined) return;
    const output = run.settled;
    if (output.kind === "waiting_remote") {
      if (ctx.now.getTime() < this.#nextWaitingRetryAt) return;
      this.#nextWaitingRetryAt = ctx.now.getTime() + (this.dependencies.waitingRetryEveryMillis ?? DEFAULT_WAITING_RETRY_EVERY_MILLIS);
      run.settled = undefined;
      const attemptId = run.dispatchAttemptId;
      void this.dependencies.delivery.run(run.prepared).then((next) => {
        if (this.#inFlight?.dispatchAttemptId === attemptId) this.#inFlight.settled = next;
      }).catch((error: unknown) => {
        if (this.#inFlight?.dispatchAttemptId === attemptId) this.#inFlight.settled = failedOutput(error);
      });
      return;
    }
    await this.dependencies.delivery.complete({ output, prepared: run.prepared });
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
        const delayMinutes = Math.min(60, 2 ** Math.min(claim.attemptCount, 6));
        await this.dependencies.outbox.releaseOutbox({
          availableAt: new Date(ctx.now.getTime() + delayMinutes * 60_000).toISOString(),
          outboxId: claim.outboxId,
          owner: this.dependencies.owner,
        });
        this.#retryAvailableAt = ctx.now.getTime() + 5_000;
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.agent.prepare_failed", {
          workbenchId: this.dependencies.workbenchId,
          errorCode: runtimeDiagnosticErrorCode(error),
          outboxId: claim.outboxId,
          partnerId: this.dependencies.partnerId,
        });
        return;
      }
      // Delivery is fully persisted after prepare; the outbox duty ends at this ack.
      await this.dependencies.outbox.completeOutbox(claim.outboxId, this.dependencies.owner);
      if (prepared === "skipped_terminal") continue;
      this.#inFlight = {
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
      void this.dependencies.delivery.run(prepared).then((output) => {
        if (this.#inFlight?.dispatchAttemptId === attemptId) this.#inFlight.settled = output;
      }).catch((error: unknown) => {
        if (this.#inFlight?.dispatchAttemptId === attemptId) this.#inFlight.settled = failedOutput(error);
      });
      return;
    }
  }
}
