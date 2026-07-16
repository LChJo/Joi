import type { Clock, IdGenerator, RuntimeStore, SsePublisher } from "../ports/runtime-store.js";
import { RhythmPolicy } from "../../domain/rhythm/rhythm-policy.js";

export class AlarmScheduler {
  private readonly rhythm = new RhythmPolicy();
  constructor(private readonly dependencies: {
    clock: Clock;
    ids: IdGenerator;
    notify?: (lifeId: string) => void;
    publisher: SsePublisher;
    store: RuntimeStore;
  }) {}

  async tick(limit = 100): Promise<string[]> {
    const now = this.dependencies.clock.now().toISOString();
    const created: string[] = [];
    for (const alarm of await this.dependencies.store.listDueAlarms(now, limit)) {
      const life = await this.dependencies.store.getLife(alarm.lifeId);
      if (life === null) continue;
      if (!alarm.allowQuietHours && this.rhythm.isQuiet(this.dependencies.clock.now(), life.timezone, { end: life.quietEnd, start: life.quietStart })) {
        await this.dependencies.store.deferAlarmForQuietHours({
          alarmId: alarm.alarmId,
          expectedNextAt: alarm.nextAt,
          nextAt: this.rhythm.nextQuietEnd(this.dependencies.clock.now(), life.timezone, { end: life.quietEnd, start: life.quietStart }).toISOString(),
          now,
        });
        continue;
      }
      const result = await this.dependencies.store.fireAlarmOccurrence({
        alarmId: alarm.alarmId,
        event: {
          ...(alarm.affairId === undefined ? {} : { affairId: alarm.affairId }),
          attemptCount: 0,
          availableAt: alarm.nextAt,
          createdAt: now,
          dedupeKey: `${alarm.alarmId}:${alarm.nextAt}`,
          eventId: this.dependencies.ids.next("event"),
          lifeId: alarm.lifeId,
          occurredAt: alarm.nextAt,
          payload: { alarmId: alarm.alarmId, occurrenceAt: alarm.nextAt, reason: alarm.reason },
          priority: 2,
          source: "schedule",
          status: "PENDING",
          type: "alarm.fired",
        },
        now,
        occurrenceAt: alarm.nextAt,
        occurrenceId: this.dependencies.ids.next("occurrence"),
      });
      if (result.created && result.event !== null) {
        created.push(result.event.eventId);
        this.dependencies.notify?.(alarm.lifeId);
      }
      for (const event of result.sse) await this.dependencies.publisher.publish(event);
    }
    return created;
  }
}
