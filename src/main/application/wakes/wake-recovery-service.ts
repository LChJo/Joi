import { WakeLiveness } from "../../domain/wakes/wake-liveness.js";
import type { Clock, RuntimeStore, SsePublisher } from "../ports/runtime-store.js";

export class WakeRecoveryService {
  constructor(private readonly dependencies: {
    clock: Clock;
    liveness?: WakeLiveness;
    publisher: SsePublisher;
    store: RuntimeStore;
  }) {}

  async recover(inProcessWakeIds: ReadonlySet<string> = new Set()): Promise<string[]> {
    const liveness = this.dependencies.liveness ?? new WakeLiveness({
      staleThresholdMs: 30 * 60_000,
      startupGraceMs: 60_000,
    });
    const now = this.dependencies.clock.now();
    const recovered: string[] = [];
    for (const wake of await this.dependencies.store.listActiveWakes()) {
      const turns = await this.dependencies.store.listWakeTurns(wake.wakeId);
      const latest = turns.at(-1);
      if (!liveness.isStale({
        createdAt: wake.createdAt,
        inProcess: inProcessWakeIds.has(wake.wakeId),
        ...(latest === undefined ? {} : { lastTurnActivityAt: latest.lastActivityAt }),
        now,
      })) continue;
      const result = await this.dependencies.store.recoverStaleWake(wake.wakeId, now.toISOString());
      if (!result.recovered) continue;
      recovered.push(wake.wakeId);
      for (const event of result.sse) await this.dependencies.publisher.publish(event);
    }
    return recovered;
  }
}
