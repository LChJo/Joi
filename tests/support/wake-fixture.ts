import { validateLifeActionEnvelope } from "../../src/main/domain/a2a/digital-life-envelope";
import { EVENT_TYPE_REGISTRY } from "../../src/main/domain/events/event-type-registry";
import { RhythmPolicy } from "../../src/main/domain/rhythm/rhythm-policy";
import type { Clock, IdGenerator, RuntimeStore, SsePublisher } from "../../src/main/application/ports/runtime-store";

/**
 * Reassembles the parameters the retired WakeArbiter used for `store.claimWake`.
 * Deliberately omits the QUEUED→SLEEPING fallback and SSE fan-out (the fixture
 * publisher is a no-op anyway).
 */
export async function claimTestWake(input: {
  clock: Clock;
  ids: IdGenerator;
  leaseOwner: string;
  lifeId: string;
  store: RuntimeStore;
}) {
  const now = input.clock.now();
  const life = await input.store.getLife(input.lifeId);
  if (life === null) return null;
  return input.store.claimWake({
    allowedEventTypes: EVENT_TYPE_REGISTRY.types().filter((type) => EVENT_TYPE_REGISTRY.definition(type)?.autoWake === true),
    autonomousExemptEventTypes: ["human.auth_resolved", "human.input_answered", "human.message", "system.recovery"],
    budgetLocalDate: new RhythmPolicy().localDate(now, life.timezone),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    leaseOwner: input.leaseOwner,
    lifeId: input.lifeId,
    maxBytes: 64 * 1024,
    maxEvents: 50,
    now: now.toISOString(),
    wakeId: input.ids.next("wake"),
  });
}

/**
 * Mirrors the retired ActionProcessor: validates the envelope, computes the
 * quiet-hour delivery window for expressions, then commits through the store.
 */
export async function commitTestWakeActions(input: {
  clock: Clock;
  envelope: unknown;
  expected: { allowedActions: string[]; forceSleep?: boolean; turnId: string; wakeId: string };
  publisher?: SsePublisher;
  store: RuntimeStore;
}) {
  const envelope = validateLifeActionEnvelope(input.envelope, input.expected);
  const now = input.clock.now();
  let expressionDeliverAfter: string | undefined;
  if (envelope.actions.some((action) => action.kind === "express")) {
    const wake = await input.store.getWake(input.expected.wakeId);
    const life = wake === null ? null : await input.store.getLife(wake.lifeId);
    const rhythm = new RhythmPolicy();
    if (life !== null && rhythm.isQuiet(now, life.timezone, { end: life.quietEnd, start: life.quietStart })) {
      expressionDeliverAfter = rhythm.nextQuietEnd(now, life.timezone, { end: life.quietEnd, start: life.quietStart }).toISOString();
    }
  }
  const result = await input.store.commitWakeActions({
    envelope,
    ...(expressionDeliverAfter === undefined ? {} : { expressionDeliverAfter }),
    ...(input.expected.forceSleep === undefined ? {} : { forceSleep: input.expected.forceSleep }),
    now: now.toISOString(),
    wakeId: input.expected.wakeId,
  });
  if (input.publisher !== undefined) {
    for (const event of result.sse) await input.publisher.publish(event);
  }
  return { ...result, envelope };
}
