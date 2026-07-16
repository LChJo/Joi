const AUTONOMOUS_EXEMPT = new Set([
  "human.auth_resolved",
  "human.input_answered",
  "human.message",
  "system.recovery",
]);

export class RhythmPolicy {
  isQuiet(now: Date, timezone: string, quietHours = { end: "07:00", start: "23:00" }): boolean {
    const minute = localMinute(now, timezone);
    const start = parseMinute(quietHours.start);
    const end = parseMinute(quietHours.end);
    return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
  }

  nextQuietEnd(now: Date, timezone: string, quietHours = { end: "07:00", start: "23:00" }): Date {
    if (!this.isQuiet(now, timezone, quietHours)) return now;
    const firstMinute = new Date(now.getTime() + 60_000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds());
    for (let offset = 0; offset <= 24 * 60; offset += 1) {
      const candidate = new Date(firstMinute.getTime() + offset * 60_000);
      if (!this.isQuiet(candidate, timezone, quietHours)) return candidate;
    }
    throw new Error("Quiet hours must leave a delivery window within 24 hours.");
  }

  localDate(now: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit", month: "2-digit", timeZone: timezone, year: "numeric",
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  localTime(now: Date, timezone: string): string {
    const minute = localMinute(now, timezone);
    return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  }

  nextOccurrence(now: Date, timezone: string, localTime: string): Date {
    const match = /^(\d{2}):(\d{2})$/.exec(localTime);
    if (match === null) throw new Error("Schedule time must use HH:mm.");
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) throw new Error("Schedule time is invalid.");

    const localDate = this.localDate(now, timezone);
    for (let offset = 0; offset <= 3; offset += 1) {
      const date = addIsoDays(localDate, offset);
      const candidate = zonedDateTime(date, hour, minute, timezone);
      if (candidate !== null && candidate.getTime() > now.getTime()) return candidate;
    }
    throw new Error("Could not resolve the next schedule occurrence.");
  }

  nextCalendarAlarm(previous: Date, timezone: string, rule: "DAILY" | "WEEKDAYS" | "WEEKENDS" | "WEEKLY"): Date {
    const localDate = this.localDate(previous, timezone);
    const [hourText, minuteText] = this.localTime(previous, timezone).split(":");
    const hour = Number(hourText);
    const minute = Number(minuteText);
    for (let offset = 1; offset <= 14; offset += 1) {
      if (rule === "WEEKLY" && offset !== 7) continue;
      const date = addIsoDays(localDate, offset);
      const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      if (rule === "WEEKDAYS" && (day === 0 || day === 6)) continue;
      if (rule === "WEEKENDS" && day !== 0 && day !== 6) continue;
      const candidate = zonedDateTime(date, hour, minute, timezone);
      if (candidate !== null) return candidate;
    }
    throw new Error("Could not resolve the next calendar alarm occurrence.");
  }

  consumesAutonomousWake(eventTypes: string[]): boolean {
    return !eventTypes.some((type) => AUTONOMOUS_EXEMPT.has(type));
  }

  authorize(input: {
    autonomousLimit: number;
    autonomousUsed: number;
    eventTypes: string[];
    invocationLimit: number;
    invocationsUsed: number;
  }): { allowed: boolean; consumesAutonomous: boolean; reason?: "AUTONOMOUS_LIMIT" | "INVOCATION_LIMIT" } {
    const consumesAutonomous = this.consumesAutonomousWake(input.eventTypes);
    if (input.invocationsUsed >= input.invocationLimit) return { allowed: false, consumesAutonomous, reason: "INVOCATION_LIMIT" };
    if (consumesAutonomous && input.autonomousUsed >= input.autonomousLimit) {
      return { allowed: false, consumesAutonomous, reason: "AUTONOMOUS_LIMIT" };
    }
    return { allowed: true, consumesAutonomous };
  }
}

function parseMinute(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) throw new Error("Quiet hour must use HH:mm.");
  return Number(match[1]) * 60 + Number(match[2]);
}

function localMinute(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", hourCycle: "h23", minute: "2-digit", timeZone: timezone,
  }).formatToParts(now);
  const value = (type: "hour" | "minute") => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return value("hour") * 60 + value("minute");
}

function addIsoDays(value: string, days: number): string {
  const { day, month, year } = parseIsoDate(value);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function zonedDateTime(localDate: string, hour: number, minute: number, timezone: string): Date | null {
  const { day, month, year } = parseIsoDate(localDate);
  const intendedUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(intendedUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate, timezone);
    const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    candidate = new Date(candidate.getTime() + intendedUtc - representedUtc);
  }
  const resolved = zonedParts(candidate, timezone);
  return resolved.year === year && resolved.month === month && resolved.day === day
    && resolved.hour === hour && resolved.minute === minute ? candidate : null;
}

function parseIsoDate(value: string): { day: number; month: number; year: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) throw new Error("Local date must use YYYY-MM-DD.");
  return { day: Number(match[3]), month: Number(match[2]), year: Number(match[1]) };
}

function zonedParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", timeZone: timezone, year: "numeric",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { day: get("day"), hour: get("hour"), minute: get("minute"), month: get("month"), year: get("year") };
}
