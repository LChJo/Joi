import { DomainError } from "../../domain/errors.js";
import type { Clock, RuntimeStore, SsePublisher } from "../ports/runtime-store.js";

export class ContinuityService {
  constructor(private readonly dependencies: { clock: Clock; publisher?: SsePublisher; store: RuntimeStore }) {}

  async snapshot(lifeId: string) {
    const life = await this.dependencies.store.getLife(lifeId);
    if (life === null) throw new DomainError("life_not_found", "Life was not found.");
    const now = this.dependencies.clock.now();
    const localDate = localDateInTimezone(now, life.timezone);
    const [affairs, alarms, budget, collaborators, delegations, memories, schedules, todos] = await Promise.all([
      this.dependencies.store.listAffairs(lifeId),
      this.dependencies.store.listAlarms(lifeId),
      this.dependencies.store.getDailyBudget(lifeId, localDate, now.toISOString()),
      this.dependencies.store.listLifeCollaborators(lifeId),
      this.dependencies.store.listDelegations(lifeId),
      this.dependencies.store.listMemories(lifeId),
      this.dependencies.store.listSchedules(lifeId),
      this.dependencies.store.listTodos(lifeId),
    ]);
    return { affairs, alarms, budget, collaborators, delegations, memories, schedules, todos };
  }

  async bindCollaborator(lifeId: string, agentConnectionId: string) {
    await this.dependencies.store.bindCollaborator(lifeId, agentConnectionId, this.dependencies.clock.now().toISOString());
    return this.dependencies.store.listLifeCollaborators(lifeId);
  }

  async unbindCollaborator(lifeId: string, agentConnectionId: string) {
    if (!await this.dependencies.store.unbindCollaborator(lifeId, agentConnectionId)) {
      throw new DomainError("collaborator_binding_not_found", "Collaborator binding was not found.");
    }
    return this.dependencies.store.listLifeCollaborators(lifeId);
  }

  async expressions(lifeId: string) {
    if (await this.dependencies.store.getLife(lifeId) === null) {
      throw new DomainError("life_not_found", "Life was not found.");
    }
    return this.dependencies.store.listExpressions(lifeId);
  }

  async updateSchedule(lifeId: string, scheduleId: string, input: { enabled: boolean; localTime: string }) {
    if (!validLocalTime(input.localTime)) throw new DomainError("schedule_time_invalid", "Schedule time must use a valid HH:mm value.");
    const result = await this.dependencies.store.updateSchedule({
      ...input, lifeId, now: this.dependencies.clock.now().toISOString(), scheduleId,
    });
    if (result === null) throw new DomainError("schedule_not_found", "Schedule was not found for this Life.");
    await this.dependencies.publisher?.publish(result.event);
    return result.schedule;
  }

  async updateRhythm(lifeId: string, input: {
    autonomousWakesDefault: number;
    idleExplorationsDefault: number;
    invocationsDefault: number;
    quietEnd: string;
    quietStart: string;
  }) {
    if (!validLocalTime(input.quietStart) || !validLocalTime(input.quietEnd)) {
      throw new DomainError("quiet_hours_invalid", "Quiet hours must use valid HH:mm values.");
    }
    if (!validLimit(input.autonomousWakesDefault, 1000) || !validLimit(input.invocationsDefault, 10_000)
      || !validLimit(input.idleExplorationsDefault, 100)) {
      throw new DomainError("budget_defaults_invalid", "Default budgets are outside supported limits.");
    }
    const result = await this.dependencies.store.updateLifeRhythm({
      ...input, lifeId, now: this.dependencies.clock.now().toISOString(),
    });
    if (result === null) throw new DomainError("life_not_found", "Life was not found.");
    await this.dependencies.publisher?.publish(result.event);
    return result.life;
  }
}

function validLocalTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function validLimit(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

function localDateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit", month: "2-digit", timeZone: timezone, year: "numeric",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
