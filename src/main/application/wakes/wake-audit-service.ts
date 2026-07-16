import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { RuntimeCoreStore, RuntimeInjectionRecord } from "../ports/runtime-core-ports.js";

export class WakeAuditService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; store: RuntimeCoreStore }) {}

  beginTurn(input: { messageId: string; wakeId: string }) {
    return this.dependencies.store.createWakeTurn({
      messageId: input.messageId,
      now: this.dependencies.clock.now().toISOString(),
      turnId: this.dependencies.ids.next("turn"),
      wakeId: input.wakeId,
    });
  }

  recordInjections(input: {
    sources: { sourceId: string; sourceType: RuntimeInjectionRecord["sourceType"] }[];
    turnId: string;
    wakeId: string;
  }) {
    return this.dependencies.store.createRuntimeInjections({
      now: this.dependencies.clock.now().toISOString(),
      sources: input.sources.map((source) => ({ ...source, injectionId: this.dependencies.ids.next("injection") })),
      turnId: input.turnId,
      wakeId: input.wakeId,
    });
  }

  heartbeat(turnId: string) {
    return this.dependencies.store.heartbeatWakeTurn(turnId, this.dependencies.clock.now().toISOString());
  }

  completeTurn(turnId: string) {
    return this.dependencies.store.completeWakeTurn(turnId, this.dependencies.clock.now().toISOString());
  }
}
