import { DomainError } from "../errors.js";

export type RoutineCycleUnit = "day" | "week" | "month";

export type RoutineFrequency =
  | { kind: "cycle"; unit: RoutineCycleUnit; localTime: string; daysOfMonth?: number[]; daysOfWeek?: number[] }
  | { anchorAt?: string; hours: number; kind: "interval" }
  | { at: string; kind: "once" }
  | { dtStart?: string; kind: "rrule"; rule: string };

export type RoutineLifecycle = "ACTIVE" | "PAUSED" | "EXPIRED" | "BLOCKED" | "DELETED";
export type RoutineTarget =
  | { kind: "NEW_GOAL" }
  | { goalId: string; kind: "GOAL_CONTINUATION" };

export interface Routine {
  createdAt: string;
  deletedAt?: string;
  enabled: boolean;
  from?: string;
  frequency: RoutineFrequency;
  lastRunAt?: string;
  name: string;
  pendingTriggerAt?: string;
  preferredPartnerId?: string;
  prompt: string;
  routineId: string;
  target: RoutineTarget;
  to?: string;
  workbenchId: string;
}

export interface RoutineOccurrence {
  at: Date;
  key: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

function text(value: unknown, max: number, code: string): string {
  if (typeof value !== "string") throw new DomainError(code, "Routine value is invalid.");
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) throw new DomainError(code, "Routine value is invalid.");
  return normalized;
}

function optionalDate(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!ISO_DATE.test(normalized) || !validCalendarDate(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00.000Z`))) {
    throw new DomainError(code, "Routine date is invalid.");
  }
  return normalized;
}

function instant(value: string, code: string): string {
  const normalized = text(value, 80, code);
  const datePart = normalized.slice(0, 10);
  if (!ISO_INSTANT.test(normalized) || !validCalendarDate(datePart) || Number.isNaN(Date.parse(normalized))) throw new DomainError(code, "Routine instant is invalid.");
  return new Date(normalized).toISOString();
}

function localTime(value: string): string {
  const normalized = text(value, 5, "routine_time_invalid");
  const match = /^(\d{2}):(\d{2})$/u.exec(normalized);
  if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59) throw new DomainError("routine_time_invalid", "Routine time is invalid.");
  return normalized;
}

function list(values: number[] | undefined, min: number, max: number, code: string): number[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0 || values.length > 31 || values.some((value) => !Number.isInteger(value) || value < min || value > max)) {
    throw new DomainError(code, code === "routine_days_of_week_invalid" ? "Routine day of week list is invalid." : "Routine day of month list is invalid.");
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function normalizeFrequency(frequency: unknown, createdAt: string): RoutineFrequency {
  if (frequency === null || typeof frequency !== "object" || Array.isArray(frequency)) {
    throw new DomainError("routine_frequency_invalid", "Routine frequency is invalid.");
  }
  const value = frequency as RoutineFrequency;
  if (value.kind === "cycle") {
    const unit = (value as { unit?: unknown }).unit;
    if (unit !== "day" && unit !== "week" && unit !== "month") {
      throw new DomainError("routine_frequency_invalid", "Routine cycle unit is invalid.");
    }
    const cycleUnit = unit;
    const daysOfWeek = list(value.daysOfWeek, 0, 6, "routine_days_of_week_invalid")
      ?? (cycleUnit === "week" ? [localParts(new Date(createdAt), Intl.DateTimeFormat().resolvedOptions().timeZone).weekday] : undefined);
    const daysOfMonth = list(value.daysOfMonth, 1, 31, "routine_days_of_month_invalid")
      ?? (cycleUnit === "month" ? [localParts(new Date(createdAt), Intl.DateTimeFormat().resolvedOptions().timeZone).day] : undefined);
    const normalized: RoutineFrequency = {
      kind: "cycle", localTime: localTime(value.localTime), unit: cycleUnit,
      ...(daysOfWeek === undefined ? {} : { daysOfWeek }),
      ...(daysOfMonth === undefined ? {} : { daysOfMonth }),
    };
    if (cycleUnit !== "week" && value.daysOfWeek !== undefined) throw new DomainError("routine_days_of_week_invalid", "Days of week are only valid for weekly routines.");
    if (cycleUnit !== "month" && value.daysOfMonth !== undefined) throw new DomainError("routine_days_of_month_invalid", "Days of month are only valid for monthly routines.");
    return normalized;
  }
  if (value.kind === "interval") {
    if (typeof value.hours !== "number" || !Number.isFinite(value.hours) || value.hours <= 0) throw new DomainError("routine_interval_invalid", "Routine interval is invalid.");
    if (value.hours * 60 < 5) throw new DomainError("routine_interval_too_short", "Routine interval must be at least five minutes.");
    return { kind: "interval", hours: value.hours, ...(value.anchorAt === undefined ? {} : { anchorAt: instant(value.anchorAt, "routine_anchor_invalid") }) };
  }
  if (value.kind === "once") return { kind: "once", at: instant(value.at, "routine_at_invalid") };
  {
    const rawRule = text(value.rule, 1_000, "routine_rrule_invalid");
    const rule = rawRule.toUpperCase().startsWith("RRULE:") ? rawRule.slice(6).trim() : rawRule;
    parseRRule(rule);
    return { kind: "rrule", rule: rule.toUpperCase(), ...(value.dtStart === undefined ? {} : { dtStart: instant(value.dtStart, "routine_dtstart_invalid") }) };
  }
  throw new DomainError("routine_frequency_invalid", "Routine frequency is invalid.");
}

export function createRoutine(input: {
  createdAt: string; deletedAt?: string; enabled?: boolean; from?: string; frequency: RoutineFrequency; lastRunAt?: string;
  name: string; pendingTriggerAt?: string; preferredPartnerId?: string; prompt: string; routineId: string; target?: RoutineTarget; to?: string; workbenchId: string;
}): Routine {
  const createdAt = instant(input.createdAt, "routine_created_at_invalid");
  const from = optionalDate(input.from, "routine_from_invalid");
  const to = optionalDate(input.to, "routine_to_invalid");
  if (from !== undefined && to !== undefined && from > to) throw new DomainError("routine_date_range_invalid", "Routine date range is invalid.");
  const target: RoutineTarget = input.target?.kind === "GOAL_CONTINUATION"
    ? { goalId: text(input.target.goalId, 160, "routine_goal_invalid"), kind: "GOAL_CONTINUATION" }
    : { kind: "NEW_GOAL" };
  const result: Routine = {
    createdAt, enabled: input.enabled ?? true, frequency: normalizeFrequency(input.frequency, createdAt),
    name: text(input.name, 120, "routine_name_invalid"), prompt: text(input.prompt, 32_000, "routine_prompt_invalid"),
    routineId: text(input.routineId, 160, "routine_id_invalid"), target, workbenchId: text(input.workbenchId, 160, "routine_workbench_invalid"),
    ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
    ...(input.deletedAt === undefined ? {} : { deletedAt: instant(input.deletedAt, "routine_deleted_at_invalid") }),
    ...(input.lastRunAt === undefined ? {} : { lastRunAt: instant(input.lastRunAt, "routine_last_run_invalid") }),
    ...(input.pendingTriggerAt === undefined ? {} : { pendingTriggerAt: instant(input.pendingTriggerAt, "routine_pending_invalid") }),
    ...(input.preferredPartnerId === undefined ? {} : { preferredPartnerId: text(input.preferredPartnerId, 160, "routine_partner_invalid") }),
  };
  return result;
}

export function routineLifecycle(routine: Routine, now = new Date(), blocked = false): RoutineLifecycle {
  if (routine.deletedAt !== undefined) return "DELETED";
  if (!routine.enabled) return "PAUSED";
  if (blocked) return "BLOCKED";
  if (routine.to !== undefined && localDate(now, Intl.DateTimeFormat().resolvedOptions().timeZone) > routine.to) return "EXPIRED";
  if (routine.frequency.kind === "once" && now.getTime() > new Date(routine.frequency.at).getTime()) return "EXPIRED";
  return "ACTIVE";
}

export function nextRoutineOccurrence(routine: Routine, after: Date, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): Date | undefined {
  const occurrence = findOccurrence(routine, after, timezone);
  return occurrence?.at;
}

export function routineOccurrence(routine: Routine, after: Date, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): RoutineOccurrence | undefined {
  const occurrence = findOccurrence(routine, after, timezone);
  return occurrence === undefined ? undefined : { at: occurrence.at, key: occurrence.at.toISOString() };
}

function findOccurrence(routine: Routine, after: Date, timezone: string): RoutineOccurrence | undefined {
  assertTimezone(timezone);
  const lowerBound = after.getTime();
  if (routine.from !== undefined && localDate(after, timezone) < routine.from) {
    after = zonedDateTime(routine.from, 0, 0, timezone) ?? after;
  }
  if (routine.frequency.kind === "once") {
    const at = new Date(routine.frequency.at);
    return isWithinBounds(routine, at, timezone) && at.getTime() > lowerBound ? { at, key: at.toISOString() } : undefined;
  }
  if (routine.frequency.kind === "interval") {
    const anchor = new Date(routine.frequency.anchorAt ?? routine.createdAt).getTime();
    const interval = routine.frequency.hours * 60 * 60 * 1_000;
    const count = lowerBound < anchor ? 0 : Math.floor((lowerBound - anchor) / interval) + 1;
    const at = new Date(anchor + count * interval);
    return isWithinBounds(routine, at, timezone) ? { at, key: at.toISOString() } : undefined;
  }
  if (routine.frequency.kind === "cycle") {
    const [hourText, minuteText] = routine.frequency.localTime.split(":");
    const hour = Number(hourText ?? "0");
    const minute = Number(minuteText ?? "0");
    const startDate = localDate(after, timezone);
    for (let offset = 0; offset <= 366 * 2; offset += 1) {
      const date = addIsoDays(startDate, offset);
      if (routine.to !== undefined && date > routine.to) break;
      const candidate = zonedDateTime(date, hour, minute, timezone);
      if (candidate === null || candidate.getTime() <= lowerBound || !matchesCycle(routine.frequency, localParts(candidate, timezone))) continue;
      if (isWithinBounds(routine, candidate, timezone)) return { at: candidate, key: candidate.toISOString() };
    }
    return undefined;
  }
  const rule = parseRRule(routine.frequency.rule);
  const anchor = routine.frequency.dtStart ?? routine.createdAt;
  const useStartTime = routine.frequency.dtStart !== undefined;
  if (rule.freq === "DAILY" || rule.freq === "WEEKLY" || rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
    const anchorParts = localParts(new Date(anchor), timezone);
    const hour = rule.byHour ?? (useStartTime ? anchorParts.hour : 0);
    const minute = rule.byMinute ?? (useStartTime ? anchorParts.minute : 0);
    const startDate = localDate(after, timezone);
    for (let offset = 0; offset <= 366 * 2; offset += 1) {
      const date = addIsoDays(startDate, offset);
      const candidate = zonedDateTime(date, hour, minute, timezone);
      if (candidate === null || candidate.getTime() <= lowerBound) continue;
      const parts = localParts(candidate, timezone);
      if (matchesRRule(rule, parts, candidate, anchor, useStartTime, timezone) && isWithinBounds(routine, candidate, timezone)) {
        return { at: candidate, key: candidate.toISOString() };
      }
    }
    return undefined;
  }
  const start = new Date(after);
  start.setSeconds(0, 0);
  if (start.getTime() <= after.getTime()) start.setTime(start.getTime() + 60_000);
  const maxMinutes = 366 * 24 * 60 * 2;
  for (let offset = 0; offset <= maxMinutes; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    const parts = localParts(candidate, timezone);
    if (matchesRRule(rule, parts, candidate, anchor, useStartTime, timezone) && isWithinBounds(routine, candidate, timezone)) {
      return { at: candidate, key: candidate.toISOString() };
    }
  }
  return undefined;
}

function matchesCycle(frequency: Extract<RoutineFrequency, { kind: "cycle" }>, parts: LocalParts): boolean {
  if (frequency.unit === "week") return (frequency.daysOfWeek ?? [parts.weekday]).includes(parts.weekday);
  if (frequency.unit === "month") return (frequency.daysOfMonth ?? [parts.day]).includes(parts.day);
  return true;
}

interface ParsedRRule { byDay?: number[]; byHour?: number; byMinute?: number; byMonth?: number[]; byMonthDay?: number[]; count?: number; freq: "DAILY" | "HOURLY" | "MINUTELY" | "MONTHLY" | "WEEKLY" | "YEARLY"; interval: number; until?: Date }

function parseRRule(value: string): ParsedRRule {
  const result: ParsedRRule = { freq: "DAILY", interval: 1 };
  const seen = new Set<string>();
  let hasFrequency = false;
  for (const part of value.split(";")) {
    const [key, rawValue] = part.split("=", 2);
    const normalized = key?.trim().toUpperCase();
    const raw = rawValue?.trim();
    if (normalized === undefined || raw === undefined || seen.has(normalized)) throw new DomainError("routine_rrule_invalid", "Routine RRULE is invalid.");
    seen.add(normalized);
    if (normalized === "FREQ" && ["DAILY", "HOURLY", "MINUTELY", "MONTHLY", "WEEKLY", "YEARLY"].includes(raw.toUpperCase())) { result.freq = raw.toUpperCase() as ParsedRRule["freq"]; hasFrequency = true; }
    else if (normalized === "INTERVAL") result.interval = positiveInt(raw, "routine_rrule_invalid");
    else if (normalized === "BYHOUR") result.byHour = boundedInt(raw, 0, 23, "routine_rrule_invalid");
    else if (normalized === "BYMINUTE") result.byMinute = boundedInt(raw, 0, 59, "routine_rrule_invalid");
    else if (normalized === "BYMONTH") result.byMonth = raw.split(",").map((partValue) => boundedInt(partValue.trim(), 1, 12, "routine_rrule_invalid"));
    else if (normalized === "BYMONTHDAY") result.byMonthDay = raw.split(",").map((partValue) => boundedInt(partValue.trim(), 1, 31, "routine_rrule_invalid"));
    else if (normalized === "BYDAY") result.byDay = raw.split(",").map((partValue) => {
      const day = partValue.trim().toUpperCase();
      const found = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].indexOf(day);
      if (found < 0) throw new DomainError("routine_rrule_invalid", "Routine RRULE is invalid.");
      return found;
    });
    else if (normalized === "COUNT") result.count = positiveInt(raw, "routine_rrule_invalid");
    else if (normalized === "UNTIL") {
      const until = parseRRuleDate(raw);
      if (until === null) throw new DomainError("routine_rrule_invalid", "Routine RRULE is invalid.");
      result.until = until;
    }
    else throw new DomainError("routine_rrule_invalid", "Routine RRULE contains an unsupported part.");
  }
  if (!hasFrequency) throw new DomainError("routine_rrule_invalid", "Routine RRULE must declare FREQ.");
  if (result.freq === "MINUTELY" && result.interval < 5) throw new DomainError("routine_rrule_invalid", "Routine RRULE interval must be at least five minutes.");
  return result;
}

function parseRRuleDate(value: string): Date | null {
  const normalized = value.trim();
  if (/^\d{8}$/u.test(normalized)) {
    const year = Number(normalized.slice(0, 4));
    const month = Number(normalized.slice(4, 6));
    const day = Number(normalized.slice(6, 8));
    const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
  }
  const basic = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(normalized);
  if (basic !== null) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = basic;
    if (yearText === undefined || monthText === undefined || dayText === undefined || hourText === undefined || minuteText === undefined || secondText === undefined
      || !validCalendarDate(`${yearText}-${monthText}-${dayText}`)
      || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return null;
    const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText), Number(secondText)));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function matchesRRule(rule: ParsedRRule, parts: LocalParts, candidate: Date, anchorAt: string, useStartTime: boolean, timezone: string): boolean {
  const start = new Date(anchorAt);
  start.setSeconds(0, 0);
  if (Number.isNaN(start.getTime()) || candidate.getTime() < start.getTime()) return false;
  if (rule.until !== undefined && (Number.isNaN(rule.until.getTime()) || candidate > rule.until)) return false;
  const startParts = localParts(start, timezone);
  const hour = rule.byHour ?? (useStartTime ? startParts.hour : (rule.freq === "HOURLY" || rule.freq === "MINUTELY" ? undefined : 0));
  const minute = rule.byMinute ?? (useStartTime ? startParts.minute : (rule.freq === "HOURLY" ? startParts.minute : rule.freq === "MINUTELY" ? undefined : 0));
  if (hour !== undefined && parts.hour !== hour) return false;
  if (minute !== undefined && parts.minute !== minute) return false;
  if (rule.byDay !== undefined && !rule.byDay.includes(parts.weekday)) return false;
  if (rule.byMonthDay !== undefined && !rule.byMonthDay.includes(parts.day)) return false;
  if (rule.freq === "DAILY" && calendarDays(startParts, parts) % rule.interval !== 0) return false;
  if (rule.freq === "WEEKLY" && Math.floor(calendarDays(startParts, parts) / 7) % rule.interval !== 0) return false;
  if (rule.freq === "MONTHLY" && ((parts.year - startParts.year) * 12 + parts.month - startParts.month) % rule.interval !== 0) return false;
  if (rule.freq === "YEARLY" && (parts.year - startParts.year) % rule.interval !== 0) return false;
  if (rule.freq === "HOURLY" && (candidate.getTime() - start.getTime()) % (rule.interval * 3_600_000) !== 0) return false;
  if (rule.freq === "MINUTELY" && (candidate.getTime() - start.getTime()) % (rule.interval * 60_000) !== 0) return false;
  const effectiveByDay = rule.byDay ?? (rule.freq === "WEEKLY" ? [startParts.weekday] : undefined);
  if (effectiveByDay !== undefined && !effectiveByDay.includes(parts.weekday)) return false;
  if (rule.byMonth !== undefined && !rule.byMonth.includes(parts.month)) return false;
  if (rule.byMonth === undefined && rule.freq === "YEARLY" && parts.month !== startParts.month) return false;
  if (rule.byMonthDay === undefined && (rule.freq === "MONTHLY" || rule.freq === "YEARLY") && parts.day !== startParts.day) return false;
  if (rule.count !== undefined) {
    const ordinal = rule.freq === "DAILY" ? Math.floor(calendarDays(startParts, parts) / rule.interval) + 1
      : rule.freq === "WEEKLY" ? Math.floor(calendarDays(startParts, parts) / (7 * rule.interval)) + 1
        : rule.freq === "MONTHLY" ? Math.floor(((parts.year - startParts.year) * 12 + parts.month - startParts.month) / rule.interval) + 1
          : rule.freq === "YEARLY" ? Math.floor((parts.year - startParts.year) / rule.interval) + 1
          : rule.freq === "HOURLY" ? Math.floor((candidate.getTime() - start.getTime()) / (rule.interval * 3_600_000)) + 1
            : Math.floor((candidate.getTime() - start.getTime()) / (rule.interval * 60_000)) + 1;
    if (ordinal > rule.count) return false;
  }
  return true;
}

function calendarDays(start: LocalParts, end: LocalParts): number {
  return Math.round((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000);
}

function isWithinBounds(routine: Routine, candidate: Date, timezone: string): boolean {
  const date = localDate(candidate, timezone);
  return (routine.from === undefined || date >= routine.from) && (routine.to === undefined || date <= routine.to);
}

function addIsoDays(value: string, days: number): string {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText ?? "0");
  const month = Number(monthText ?? "1");
  const day = Number(dayText ?? "1");
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

interface LocalParts { day: number; hour: number; minute: number; month: number; weekday: number; year: number }

function localParts(value: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", { day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", timeZone: timezone, weekday: "short", year: "numeric" }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "0";
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return { day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), month: Number(get("month")), weekday: days.indexOf(get("weekday")), year: Number(get("year")) };
}

function localDate(value: Date, timezone: string): string {
  const parts = localParts(value, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function zonedDateTime(date: string, hour: number, minute: number, timezone: string): Date | null {
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText ?? "0");
  const month = Number(monthText ?? "1");
  const day = Number(dayText ?? "1");
  const intended = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(intended);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localParts(candidate, timezone);
    candidate = new Date(candidate.getTime() + intended - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  }
  const resolved = localParts(candidate, timezone);
  return resolved.year === year && resolved.month === month && resolved.day === day && resolved.hour === hour && resolved.minute === minute ? candidate : null;
}

function assertTimezone(timezone: string): void {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { throw new DomainError("routine_timezone_invalid", "Routine timezone is invalid."); }
}

function positiveInt(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new DomainError(code, "Routine RRULE is invalid.");
  return parsed;
}

function boundedInt(value: string, min: number, max: number, code: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new DomainError(code, "Routine RRULE is invalid.");
  return parsed;
}
