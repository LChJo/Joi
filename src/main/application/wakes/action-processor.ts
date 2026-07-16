import { validateLifeActionEnvelope } from "../../domain/a2a/digital-life-envelope.js";
import { RhythmPolicy } from "../../domain/rhythm/rhythm-policy.js";
import type { Clock, RuntimeStore, SsePublisher } from "../ports/runtime-store.js";

export class ActionProcessor {
  private readonly rhythm = new RhythmPolicy();

  constructor(private readonly dependencies: { clock: Clock; publisher: SsePublisher; store: RuntimeStore }) {}

  async commit(value: unknown, expected: { allowedActions: string[]; forceSleep?: boolean; turnId: string; wakeId: string }) {
    const envelope = validateLifeActionEnvelope(value, expected);
    const now = this.dependencies.clock.now();
    let expressionDeliverAfter: string | undefined;
    if (envelope.actions.some((action) => action.kind === "express")) {
      const wake = await this.dependencies.store.getWake(expected.wakeId);
      const life = wake === null ? null : await this.dependencies.store.getLife(wake.lifeId);
      if (life !== null && this.rhythm.isQuiet(now, life.timezone, { end: life.quietEnd, start: life.quietStart })) {
        expressionDeliverAfter = this.rhythm.nextQuietEnd(now, life.timezone, { end: life.quietEnd, start: life.quietStart }).toISOString();
      }
    }
    const result = await this.dependencies.store.commitWakeActions({
      envelope,
      ...(expressionDeliverAfter === undefined ? {} : { expressionDeliverAfter }),
      ...(expected.forceSleep === undefined ? {} : { forceSleep: expected.forceSleep }),
      now: now.toISOString(),
      wakeId: expected.wakeId,
    });
    for (const event of result.sse) await this.dependencies.publisher.publish(event);
    return { ...result, envelope };
  }
}
