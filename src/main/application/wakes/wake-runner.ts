import { DomainError } from "../../domain/errors.js";
import { LIFE_ACTION_KINDS } from "../../domain/a2a/digital-life-envelope.js";
import { EVENT_TYPE_REGISTRY } from "../../domain/events/event-type-registry.js";
import type { Clock, IdGenerator, RuntimeStore } from "../ports/runtime-store.js";
import type { LifeEvent, WakeRecord } from "../ports/runtime-core-ports.js";
import type { ActionProcessor } from "./action-processor.js";
import type { WakeArbiter } from "./wake-arbiter.js";
import type { WakeAuditService } from "./wake-audit-service.js";
import type { WakeContextAssembler } from "./wake-context-assembler.js";
import type { WakeRepairService } from "./wake-repair-service.js";

const DEFAULT_ALLOWED_ACTIONS = [...LIFE_ACTION_KINDS];

export interface WakeAgentExecutor {
  execute(input: {
    agentConnectionId: string;
    kind: "repair" | "wake";
    messageId: string;
    payload: Record<string, unknown>;
    signal: AbortSignal;
    turnId: string;
    wakeId: string;
  }): Promise<{ invocationId?: string; output: unknown }>;
}

export interface WakeRunResult {
  status: "COMPLETED" | "FAILED_PROTOCOL";
  turns: number;
  wakeId: string;
}

export class WakeRunner {
  private readonly allowedActions: string[];
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly dependencies: {
    actions: ActionProcessor;
    arbiter: WakeArbiter;
    audit: WakeAuditService;
    clock: Clock;
    context: WakeContextAssembler;
    executor: WakeAgentExecutor;
    ids: IdGenerator;
    repair: WakeRepairService;
    store: RuntimeStore;
    allowedActions?: string[];
  }) {
    this.allowedActions = dependencies.allowedActions ?? DEFAULT_ALLOWED_ACTIONS;
  }

  async runLife(lifeId: string, leaseOwner: string): Promise<WakeRunResult | null> {
    const bundle = await this.dependencies.arbiter.claim(lifeId, leaseOwner);
    if (bundle === null) return null;
    const controller = new AbortController();
    this.controllers.set(lifeId, controller);
    try {
      return await this.runClaimed(bundle.wake, bundle.events, controller.signal);
    } finally {
      if (this.controllers.get(lifeId) === controller) this.controllers.delete(lifeId);
    }
  }

  cancelLife(lifeId: string): boolean {
    const controller = this.controllers.get(lifeId);
    if (controller === undefined) return false;
    controller.abort(new Error("joi Wake was stopped by the user."));
    return true;
  }

  private async runClaimed(wake: WakeRecord, initialEvents: LifeEvent[], signal: AbortSignal): Promise<WakeRunResult> {
    const life = await this.dependencies.store.getLife(wake.lifeId);
    if (life === null) throw new DomainError("life_not_found", "Life was not found.");
    let events = initialEvents;
    let repairPayload: Record<string, unknown> | null = null;

    for (let turnIndex = 0; turnIndex < 4; turnIndex += 1) {
      const messageId = this.dependencies.ids.next("message");
      const turn = await this.dependencies.audit.beginTurn({ messageId, wakeId: wake.wakeId });
      const kind = repairPayload === null ? "wake" : "repair";
      const payload = repairPayload ?? await this.dependencies.context.assemble({
        allowedActions: this.allowedActions,
        events,
        turn,
        wake,
      });
      if (repairPayload === null) {
        const memorySources = Array.isArray(payload.memories)
          ? payload.memories.flatMap((memory) => {
            if (memory === null || Array.isArray(memory) || typeof memory !== "object") return [];
            const memoryId = (memory as Record<string, unknown>).memoryId;
            return typeof memoryId === "string" ? [{ sourceId: memoryId, sourceType: "memory" as const }] : [];
          })
          : [];
        await this.dependencies.audit.recordInjections({
          sources: [
            ...events.map((event) => ({ sourceId: event.eventId, sourceType: "event" as const })),
            ...memorySources,
          ],
          turnId: turn.turnId,
          wakeId: wake.wakeId,
        });
      }
      const executed = await this.dependencies.executor.execute({
        agentConnectionId: life.mainAgentConnectionId,
        kind,
        messageId,
        payload,
        signal,
        turnId: turn.turnId,
        wakeId: wake.wakeId,
      });
      if (executed.invocationId !== undefined) {
        await this.dependencies.store.linkWakeTurnInvocation(turn.turnId, executed.invocationId, this.dependencies.clock.now().toISOString());
      }
      await this.dependencies.audit.completeTurn(turn.turnId);

      try {
        const forceSleep = turnIndex === 3;
        const committed = await this.dependencies.actions.commit(executed.output, {
          allowedActions: this.allowedActions,
          ...(forceSleep ? { forceSleep: true } : {}),
          turnId: turn.turnId,
          wakeId: wake.wakeId,
        });
        if (!committed.envelope.continueWake || forceSleep) {
          return { status: "COMPLETED", turns: turnIndex + 1, wakeId: wake.wakeId };
        }
        repairPayload = null;
        events = await this.dependencies.store.claimWakeInjections({
          allowedEventTypes: EVENT_TYPE_REGISTRY.types().filter((type) => EVENT_TYPE_REGISTRY.definition(type)?.autoWake === true),
          maxBytes: 64 * 1024,
          maxEvents: 50,
          now: this.dependencies.clock.now().toISOString(),
          wakeId: wake.wakeId,
        });
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "action_schema_invalid") throw error;
        const repair = await this.dependencies.repair.handleInvalid({
          errors: [error.message],
          output: executed.output,
          turnId: turn.turnId,
          wakeId: wake.wakeId,
        });
        if (!repair.repair) return { status: "FAILED_PROTOCOL", turns: turnIndex + 1, wakeId: wake.wakeId };
        if (turnIndex === 3) {
          await this.dependencies.repair.handleInvalid({
            errors: ["Wake reached the four Turn limit before repair could run."],
            output: executed.output,
            turnId: turn.turnId,
            wakeId: wake.wakeId,
          });
          return { status: "FAILED_PROTOCOL", turns: 4, wakeId: wake.wakeId };
        }
        repairPayload = repair.payload;
      }
    }
    throw new Error("Wake Runner exhausted its Turn loop without a terminal state.");
  }
}
