import { RhythmPolicy } from "../../domain/rhythm/rhythm-policy.js";
import type { Clock, IdGenerator, RuntimeStore, SsePublisher } from "../ports/runtime-store.js";

export class ScheduleScheduler {
  private readonly rhythm = new RhythmPolicy();

  constructor(private readonly dependencies: {
    clock: Clock;
    ids: IdGenerator;
    notify?: (lifeId: string) => void;
    publisher: SsePublisher;
    store: RuntimeStore;
  }) {}

  async tick(): Promise<string[]> {
    const now = this.dependencies.clock.now();
    const created: string[] = [];
    for (const schedule of await this.dependencies.store.listEnabledSchedules()) {
      const localDate = this.rhythm.localDate(now, schedule.timezone);
      if (schedule.lastFiredLocalDate === localDate || this.rhythm.localTime(now, schedule.timezone) < schedule.localTime) continue;
      const type = `schedule.${schedule.kind}`;
      const result = await this.dependencies.store.fireSchedule({
        event: {
          attemptCount: 0,
          availableAt: now.toISOString(),
          createdAt: now.toISOString(),
          dedupeKey: `${schedule.scheduleId}:${localDate}`,
          eventId: this.dependencies.ids.next("event"),
          lifeId: schedule.lifeId,
          occurredAt: now.toISOString(),
          payload: { localDate, scheduleId: schedule.scheduleId },
          priority: schedule.kind === "memory_metabolism" ? 3 : 2,
          source: "schedule",
          status: "PENDING",
          type,
        },
        localDate,
        now: now.toISOString(),
        scheduleId: schedule.scheduleId,
      });
      if (result.created && result.event !== null) {
        created.push(result.event.eventId);
        this.dependencies.notify?.(schedule.lifeId);
      }
      for (const event of result.sse) await this.dependencies.publisher.publish(event);
    }
    return created;
  }
}
