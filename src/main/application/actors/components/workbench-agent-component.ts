import { emitRuntimeDiagnostic } from "../../ports/runtime-diagnostics.js";
import { AgentActor } from "../agent-actor.js";
import { AgentDispatchComponent } from "./agent-dispatch-component.js";
import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";
import type { WorkbenchAgentScan } from "../../ports/workbench-agent-scan.js";
import type {
  PartnerDispatchClaims,
  PartnerDispatchDelivery,
  WorkspaceLeaseRenewal,
} from "../../ports/partner-dispatch-delivery.js";
import type { PartnerRunStatus } from "../../ports/partner-execution.js";
import type { RuntimeStore } from "../../ports/runtime-store.js";
import type { PartnerWorkMemoryService } from "../../partners/partner-work-memory-service.js";
import type { PartnerInstanceManager } from "../../partners/partner-instance-manager.js";
import type { WorkbenchAttentionReconciler } from "../../ports/workbench-attention.js";

const DEFAULT_SWEEP_EVERY_MILLIS = 60_000;
const WAITING_RECOVERY_REASON = "partner_waiting_recovery_required";
const WAITING_RECOVERY_PROMPT = "一项搭档工作仍在等待，但原来的提问卡已经失去关联。点击“继续原工作”可从已保存的上下文恢复；如果不希望继续，可以取消这条任务。";

/**
 * Per-Workbench traversal over agent facts: reconciles leaf AgentActors, aggregates
 * repairs actionable attention, sweeps idle instances and folds authoritative terminal
 * results into the joi goal synthesis (replacing the onResult callback).
 */
export class WorkbenchAgentComponent implements ActorComponent {
  readonly componentName = "workbench-agent";
  readonly #agentActors = new Map<string, AgentActor>();
  #lastSweepAt = 0;

  constructor(private readonly dependencies: {
    attention: WorkbenchAttentionReconciler;
    workbenchId: string;
    dispatch?: {
      claims: PartnerDispatchClaims;
      delivery: PartnerDispatchDelivery;
      leases?: WorkspaceLeaseRenewal;
      outbox: Pick<RuntimeStore, "claimOutboxById" | "completeOutbox" | "releaseOutbox">;
      owner: string;
      workCanceled?: (workId: string) => Promise<boolean>;
    };
    instances: Pick<PartnerInstanceManager, "sweepIdleFor">;
    memory: Pick<PartnerWorkMemoryService, "recordResult">;
    scan: WorkbenchAgentScan;
    sweepEveryMillis?: number;
    synthesis: {
      enqueuePartnerResult(event: { workbenchId: string; eventId: string; resultId: string; status: string; summary: string; workId: string }): Promise<string | null>;
    };
  }) {}

  get agentActors(): readonly AgentActor[] {
    return [...this.#agentActors.values()];
  }

  async update(ctx: ActorTickContext): Promise<void> {
    const repaired = await this.dependencies.attention.reconcile({
      prompt: WAITING_RECOVERY_PROMPT,
      reasonCode: WAITING_RECOVERY_REASON,
      workbenchId: this.dependencies.workbenchId,
    });
    if (repaired > 0) emitRuntimeDiagnostic(ctx.diagnostics, "joi.workbench.attention_repaired", {
      repaired,
      workbenchId: this.dependencies.workbenchId,
    });
    await this.#synthesize(ctx);
    await this.#sweep(ctx);
    await this.#reconcile();
  }

  async #synthesize(ctx: ActorTickContext): Promise<void> {
    const results = await this.dependencies.scan.listUnsynthesizedResults(this.dependencies.workbenchId);
    for (const result of results) {
      await this.dependencies.synthesis.enqueuePartnerResult({
        workbenchId: result.workbenchId,
        eventId: result.eventId,
        resultId: result.resultId,
        status: result.status,
        summary: result.summary,
        workId: result.workId,
      });
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.workbench.synthesis_enqueued", {
        workbenchId: result.workbenchId,
        eventId: result.eventId,
        workId: result.workId,
      });
      // Best-effort side memory, exactly once per discovered result (member row dedupes future ticks).
      await this.dependencies.memory.recordResult({
        at: ctx.now.toISOString(),
        workbenchId: result.workbenchId,
        outcome: result.status as PartnerRunStatus,
        partnerId: result.partnerId,
        sessionDataSource: result.sessionDataSource,
        title: result.title,
        workId: result.workId,
      }).catch(() => undefined);
    }
  }

  async #sweep(ctx: ActorTickContext): Promise<void> {
    if (ctx.now.getTime() - this.#lastSweepAt < (this.dependencies.sweepEveryMillis ?? DEFAULT_SWEEP_EVERY_MILLIS)) return;
    this.#lastSweepAt = ctx.now.getTime();
    await this.dependencies.instances.sweepIdleFor(this.dependencies.workbenchId, ctx.now);
  }

  async #reconcile(): Promise<void> {
    const keys = await this.dependencies.scan.listPartnerKeys(this.dependencies.workbenchId);
    const live = new Set<string>();
    for (const key of keys) {
      live.add(key.partnerId);
      if (!this.#agentActors.has(key.partnerId)) {
        const components: ActorComponent[] = this.dependencies.dispatch === undefined ? [] : [new AgentDispatchComponent({
          workbenchId: this.dependencies.workbenchId,
          claims: this.dependencies.dispatch.claims,
          delivery: this.dependencies.dispatch.delivery,
          ...(this.dependencies.dispatch.leases === undefined ? {} : { leases: this.dependencies.dispatch.leases }),
          outbox: this.dependencies.dispatch.outbox,
          owner: this.dependencies.dispatch.owner,
          partnerId: key.partnerId,
          ...(this.dependencies.dispatch.workCanceled === undefined ? {} : { workCanceled: this.dependencies.dispatch.workCanceled }),
        })];
        this.#agentActors.set(key.partnerId, new AgentActor({
          workbenchId: this.dependencies.workbenchId,
          components,
          partnerId: key.partnerId,
        }));
      }
    }
    for (const partnerId of [...this.#agentActors.keys()]) {
      if (!live.has(partnerId)) this.#agentActors.delete(partnerId);
    }
  }
}
