import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/main/domain/errors";
import {
  createRoutine,
  nextRoutineOccurrence,
  routineLifecycle,
  type RoutineFrequency,
} from "../../src/main/domain/automation/routine";

describe("routine domain", () => {
  it("supports daily, weekly, monthly, interval and once frequencies", () => {
    const base = {
      routineId: "routine_1",
      name: "Morning review",
      prompt: "Review the open work.",
      workbenchId: "workbench_1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    for (const frequency of [
      { kind: "cycle", unit: "day", localTime: "09:00" },
      { kind: "cycle", unit: "week", localTime: "09:00", daysOfWeek: [0, 6] },
      { kind: "cycle", unit: "month", localTime: "09:00", daysOfMonth: [1, 15] },
      { kind: "interval", hours: 0.5 },
      { kind: "once", at: "2026-02-01T09:00:00.000Z" },
      { kind: "rrule", rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" },
    ] as RoutineFrequency[]) {
      expect(createRoutine({ ...base, frequency })).toMatchObject({ routineId: "routine_1", enabled: true });
    }
  });

  it("rejects intervals below five minutes and invalid calendar values", () => {
    expect(() => createRoutine({
      createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "interval", hours: 0.01 },
      name: "x", prompt: "do x", routineId: "r", workbenchId: "w",
    })).toThrow(new DomainError("routine_interval_too_short", "Routine interval must be at least five minutes."));
    expect(() => createRoutine({
      createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "cycle", unit: "week", localTime: "09:00", daysOfWeek: [7] },
      name: "x", prompt: "do x", routineId: "r", workbenchId: "w",
    })).toThrow(/day/i);
    expect(() => createRoutine({
      createdAt: "2026-02-31T00:00:00.000Z", frequency: { kind: "once", at: "2026-03-01T00:00:00.000Z" },
      name: "x", prompt: "do x", routineId: "r", workbenchId: "w",
    })).toThrow(/instant/i);
    expect(() => createRoutine({
      createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "cycle", unit: "quarter", localTime: "09:00" } as unknown as RoutineFrequency,
      name: "x", prompt: "do x", routineId: "r", workbenchId: "w",
    })).toThrow(/unit/i);
  });

  it("uses the current system timezone and includes the end date", () => {
    const routine = createRoutine({
      createdAt: "2026-01-01T00:00:00.000Z", from: "2026-01-10", to: "2026-01-10",
      frequency: { kind: "cycle", unit: "day", localTime: "09:00" },
      name: "x", prompt: "do x", routineId: "r", workbenchId: "w",
    });
    expect(nextRoutineOccurrence(routine, new Date("2026-01-10T00:00:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-10T09:00:00.000Z");
    expect(nextRoutineOccurrence(routine, new Date("2026-01-10T10:00:00.000Z"), "UTC")).toBeUndefined();
  });

  it("anchors hourly RRULE intervals even when DTSTART is omitted", () => {
    const routine = createRoutine({
      createdAt: "2026-01-01T00:15:00.000Z", frequency: { kind: "rrule", rule: "FREQ=HOURLY;INTERVAL=2" },
      name: "x", prompt: "do x", routineId: "r", workbenchId: "w",
    });
    expect(nextRoutineOccurrence(routine, new Date("2026-01-01T00:20:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-01T02:15:00.000Z");
  });

  it("uses a future interval anchor as the first occurrence", () => {
    const routine = createRoutine({
      createdAt: "2026-01-01T00:00:00.000Z", frequency: { anchorAt: "2026-01-01T03:00:00.000Z", hours: 1, kind: "interval" },
      name: "x", prompt: "do x", routineId: "r", workbenchId: "w",
    });
    expect(nextRoutineOccurrence(routine, new Date("2026-01-01T02:00:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-01T03:00:00.000Z");
  });

  it("rejects RRULEs without FREQ or with invalid UNTIL", () => {
    expect(() => createRoutine({ createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "rrule", rule: "BYHOUR=9" }, name: "x", prompt: "do x", routineId: "r", workbenchId: "w" })).toThrow(/RRULE/i);
    expect(() => createRoutine({ createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "rrule", rule: "FREQ=DAILY;UNTIL=bad" }, name: "x", prompt: "do x", routineId: "r", workbenchId: "w" })).toThrow(/RRULE/i);
    expect(() => createRoutine({ createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "rrule", rule: "FREQ=MINUTELY;INTERVAL=4" }, name: "x", prompt: "do x", routineId: "r", workbenchId: "w" })).toThrow(/five minutes/i);
    expect(createRoutine({ createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "rrule", rule: "RRULE:FREQ=DAILY;UNTIL=20260103" }, name: "x", prompt: "do x", routineId: "r", workbenchId: "w" }).frequency).toMatchObject({ kind: "rrule", rule: "FREQ=DAILY;UNTIL=20260103" });
  });

  it("skips nonexistent DST local times and chooses the earlier repeated time", () => {
    const spring = createRoutine({
      createdAt: "2026-03-07T00:00:00.000Z", frequency: { kind: "cycle", unit: "day", localTime: "02:30" },
      name: "spring", prompt: "x", routineId: "spring", workbenchId: "w",
    });
    expect(nextRoutineOccurrence(spring, new Date("2026-03-07T00:00:00.000Z"), "America/New_York")?.toISOString()).toBe("2026-03-07T07:30:00.000Z");
    expect(nextRoutineOccurrence(spring, new Date("2026-03-08T00:00:00.000Z"), "America/New_York")?.toISOString()).toBe("2026-03-09T06:30:00.000Z");
    const fall = createRoutine({
      createdAt: "2026-10-31T00:00:00.000Z", frequency: { kind: "cycle", unit: "day", localTime: "01:30" },
      name: "fall", prompt: "x", routineId: "fall", workbenchId: "w",
    });
    expect(nextRoutineOccurrence(fall, new Date("2026-10-31T00:00:00.000Z"), "America/New_York")?.toISOString()).toBe("2026-10-31T05:30:00.000Z");
    expect(nextRoutineOccurrence(fall, new Date("2026-11-01T00:00:00.000Z"), "America/New_York")?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("validates optional routine fields and RRULE components", () => {
    const base = { createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "cycle", unit: "day", localTime: "09:00" } as RoutineFrequency, name: "x", prompt: "p", routineId: "r", workbenchId: "w" };
    expect(createRoutine({ ...base, deletedAt: "2026-01-02T00:00:00.000Z", from: "2026-01-01", lastRunAt: "2026-01-01T01:00:00.000Z", pendingTriggerAt: "2026-01-01T02:00:00.000Z", preferredPartnerId: "partner", to: "2026-01-03" })).toMatchObject({ deletedAt: "2026-01-02T00:00:00.000Z" });
    expect(() => createRoutine({ ...base, from: "2026-01-03", to: "2026-01-01" })).toThrow(/range/i);
    expect(() => createRoutine({ ...base, frequency: null as unknown as RoutineFrequency })).toThrow(/frequency/i);
    expect(() => createRoutine({ ...base, frequency: { kind: "cycle", unit: "day", localTime: "24:00" } })).toThrow(/time/i);
    expect(() => createRoutine({ ...base, frequency: { kind: "cycle", unit: "day", localTime: "09:00", daysOfMonth: [1] } })).toThrow(/month/i);
    expect(() => createRoutine({ ...base, frequency: { kind: "cycle", unit: "week", localTime: "09:00", daysOfWeek: [] } })).toThrow(/week/i);

    const validRule = "FREQ=YEARLY;INTERVAL=2;BYMONTH=1,6;BYMONTHDAY=2;BYDAY=MO;BYHOUR=9;BYMINUTE=30;COUNT=3;UNTIL=20280101";
    expect(createRoutine({ ...base, frequency: { kind: "rrule", rule: validRule } })).toMatchObject({ frequency: { kind: "rrule", rule: validRule } });
    const invalidRules = [
      "FREQ=DAILY;FREQ=WEEKLY", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;BYHOUR=24", "FREQ=DAILY;BYMINUTE=60", "FREQ=DAILY;BYMONTH=13",
      "FREQ=DAILY;BYMONTHDAY=0", "FREQ=DAILY;BYDAY=XX", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;UNSUPPORTED=1", "FREQ=DAILY;UNTIL=20260231",
    ];
    for (const rule of invalidRules) expect(() => createRoutine({ ...base, frequency: { kind: "rrule", rule } })).toThrow(/RRULE/i);
  });

  it("matches weekly, monthly, yearly and bounded RRULE defaults", () => {
    const make = (frequency: RoutineFrequency) => createRoutine({ createdAt: "2026-01-05T09:30:00.000Z", frequency, name: "x", prompt: "p", routineId: "r", workbenchId: "w" });
    const weekly = make({ kind: "rrule", rule: "FREQ=WEEKLY" });
    expect(nextRoutineOccurrence(weekly, new Date("2026-01-05T10:00:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-12T00:00:00.000Z");
    const monthly = make({ kind: "rrule", rule: "FREQ=MONTHLY" });
    expect(nextRoutineOccurrence(monthly, new Date("2026-01-05T10:00:00.000Z"), "UTC")?.toISOString()).toBe("2026-02-05T00:00:00.000Z");
    const yearly = make({ kind: "rrule", rule: "FREQ=YEARLY" });
    expect(nextRoutineOccurrence(yearly, new Date("2026-01-05T10:00:00.000Z"), "UTC")?.toISOString()).toBe("2027-01-05T00:00:00.000Z");
    const bounded = createRoutine({ createdAt: "2026-01-01T00:00:00.000Z", from: "2026-01-10", to: "2026-01-10", frequency: { kind: "rrule", rule: "FREQ=DAILY;COUNT=1" }, name: "x", prompt: "p", routineId: "r", workbenchId: "w" });
    expect(nextRoutineOccurrence(bounded, new Date("2026-01-01T00:00:00.000Z"), "UTC")).toBeUndefined();
    expect(() => nextRoutineOccurrence(weekly, new Date("2026-01-01T00:00:00.000Z"), "Not/A/Zone")).toThrow(/timezone/i);
  });

  it("supports hourly and minutely RRULE occurrences and lifecycle states", () => {
    const make = (frequency: RoutineFrequency, options: { enabled?: boolean; to?: string; deletedAt?: string } = {}) => createRoutine({ createdAt: "2026-01-01T00:00:00.000Z", ...options, frequency, name: "x", prompt: "p", routineId: "r", workbenchId: "w" });
    const hourly = make({ kind: "rrule", rule: "FREQ=HOURLY;INTERVAL=2" });
    expect(nextRoutineOccurrence(hourly, new Date("2026-01-01T00:01:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-01T02:00:00.000Z");
    const minutely = make({ kind: "rrule", rule: "FREQ=MINUTELY;INTERVAL=5" });
    expect(nextRoutineOccurrence(minutely, new Date("2026-01-01T00:01:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-01T00:05:00.000Z");
    expect(nextRoutineOccurrence(make({ kind: "once", at: "2026-01-01T00:00:00.000Z" }), new Date("2026-01-01T00:01:00.000Z"), "UTC")).toBeUndefined();
    expect(createRoutine({ createdAt: "2026-01-01T00:00:00.000Z", to: "2026-01-01", frequency: { kind: "cycle", unit: "day", localTime: "00:00" }, name: "x", prompt: "p", routineId: "r", workbenchId: "w" })).toBeTruthy();
    expect(make({ kind: "once", at: "2026-01-01T00:00:00.000Z" }, { enabled: false })).toBeTruthy();
    expect(make({ kind: "once", at: "2026-01-01T00:00:00.000Z" }, { deletedAt: "2026-01-01T01:00:00.000Z" })).toBeTruthy();
  });

  it("covers validation failures, calendar matching and lifecycle projections", () => {
    const base = { createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "cycle", unit: "day", localTime: "09:00" } as RoutineFrequency, name: "x", prompt: "p", routineId: "r", workbenchId: "w" };
    const failures: Parameters<typeof createRoutine>[0][] = [
      { ...base, name: " " }, { ...base, name: "x".repeat(121) }, { ...base, prompt: " " }, { ...base, routineId: " " }, { ...base, workbenchId: " " },
      { ...base, from: "2026/01/01" }, { ...base, to: "2026-02-31" },
      { ...base, frequency: { kind: "cycle", unit: "day", localTime: "9:00" } },
      { ...base, frequency: { kind: "interval", hours: 0 } }, { ...base, frequency: { kind: "interval", hours: Number.NaN } },
      { ...base, frequency: { kind: "interval", hours: 1, anchorAt: "tomorrow" } }, { ...base, frequency: { kind: "once", at: "tomorrow" } },
      { ...base, frequency: { kind: "rrule", rule: " " } }, { ...base, frequency: { kind: "rrule", rule: "FREQ=DAILY", dtStart: "tomorrow" } },
    ];
    for (const value of failures) expect(() => createRoutine(value)).toThrow();
    expect(createRoutine({ ...base, frequency: { kind: "cycle", unit: "day", localTime: "09:00" } })).toMatchObject({ frequency: { unit: "day" } });
    expect(() => createRoutine({ ...base, frequency: { kind: "cycle", unit: "week", localTime: "09:00", daysOfWeek: [0.5] } })).toThrow();
    expect(() => createRoutine({ ...base, frequency: { kind: "cycle", unit: "week", localTime: "09:00", daysOfWeek: Array.from({ length: 32 }, (_, index) => index % 7) } })).toThrow();

    const weeklyDefault = createRoutine({ ...base, frequency: { kind: "cycle", unit: "week", localTime: "09:00" } });
    expect(nextRoutineOccurrence(weeklyDefault, new Date("2026-01-01T00:00:00.000Z"), "UTC")).toBeDefined();
    const monthlyDefault = createRoutine({ ...base, frequency: { kind: "cycle", unit: "month", localTime: "09:00" } });
    expect(nextRoutineOccurrence(monthlyDefault, new Date("2026-01-01T00:00:00.000Z"), "UTC")).toBeDefined();
    const monthlySelected = createRoutine({ ...base, frequency: { kind: "cycle", unit: "month", localTime: "09:00", daysOfMonth: [15] } });
    expect(nextRoutineOccurrence(monthlySelected, new Date("2026-01-01T00:00:00.000Z"), "UTC")).toBeDefined();
    const rrule = createRoutine({ ...base, frequency: { kind: "rrule", rule: "FREQ=DAILY;UNTIL=2026-01-02T00:00:00.000Z" } });
    expect(nextRoutineOccurrence(rrule, new Date("2026-01-01T00:00:00.000Z"), "UTC")).toBeDefined();
    expect(() => createRoutine({ ...base, frequency: { kind: "rrule", rule: "FREQ=DAILY;UNTIL=20260101T250000Z" } })).toThrow(/RRULE/i);

    const at = new Date("2026-01-01T12:00:00.000Z");
    expect(routineLifecycle(createRoutine({ ...base, enabled: false }), at)).toBe("PAUSED");
    expect(routineLifecycle(createRoutine({ ...base, to: "2025-12-31" }), at)).toBe("EXPIRED");
    expect(routineLifecycle(createRoutine({ ...base, deletedAt: "2026-01-01T01:00:00.000Z" }), at)).toBe("DELETED");
    expect(routineLifecycle(createRoutine({ ...base, frequency: { kind: "once", at: "2026-01-01T00:00:00.000Z" } }), at)).toBe("EXPIRED");
    expect(routineLifecycle(createRoutine({ ...base }), at, true)).toBe("BLOCKED");
  });

  it("covers RRULE filters, counts, date encodings and occurrence bounds", () => {
    const make = (frequency: RoutineFrequency, options: Partial<Parameters<typeof createRoutine>[0]> = {}) => createRoutine({
      createdAt: "2026-01-05T09:30:00.000Z", frequency, name: "x", prompt: "p", routineId: "r", workbenchId: "w", ...options,
    });
    const filtered = make({ kind: "rrule", rule: "FREQ=DAILY;BYDAY=MO;BYMONTH=1;BYMONTHDAY=12;BYHOUR=9;BYMINUTE=30;COUNT=10" });
    expect(nextRoutineOccurrence(filtered, new Date("2026-01-05T00:00:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-12T09:30:00.000Z");
    expect(nextRoutineOccurrence(filtered, new Date("2026-01-12T10:00:00.000Z"), "UTC")).toBeUndefined();

    const monthly = make({ kind: "rrule", rule: "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=5;COUNT=2" });
    expect(nextRoutineOccurrence(monthly, new Date("2026-01-05T10:00:00.000Z"), "UTC")?.toISOString()).toBe("2026-03-05T00:00:00.000Z");
    const yearly = make({ kind: "rrule", rule: "FREQ=YEARLY;INTERVAL=2;BYMONTH=6;BYMONTHDAY=5;COUNT=2" });
    expect(nextRoutineOccurrence(yearly, new Date("2026-01-05T10:00:00.000Z"), "UTC")?.toISOString()).toBe("2026-06-05T00:00:00.000Z");
    const hourly = make({ kind: "rrule", rule: "FREQ=HOURLY;INTERVAL=2;COUNT=2" });
    expect(nextRoutineOccurrence(hourly, new Date("2026-01-05T09:31:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-05T11:30:00.000Z");
    const minutely = make({ kind: "rrule", rule: "FREQ=MINUTELY;INTERVAL=5;COUNT=2" });
    expect(nextRoutineOccurrence(minutely, new Date("2026-01-05T09:31:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-05T09:35:00.000Z");

    const once = make({ kind: "once", at: "2026-01-06T09:30:00.000Z" }, { from: "2026-01-06", to: "2026-01-06" });
    expect(nextRoutineOccurrence(once, new Date("2026-01-05T00:00:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-06T09:30:00.000Z");
    expect(nextRoutineOccurrence(once, new Date("2026-01-07T00:00:00.000Z"), "UTC")).toBeUndefined();
    const boundedInterval = make({ kind: "interval", hours: 1 }, { to: "2026-01-05" });
    expect(nextRoutineOccurrence(boundedInterval, new Date("2026-01-05T23:31:00.000Z"), "UTC")).toBeUndefined();
    const basicDateTime = make({ kind: "rrule", rule: "FREQ=DAILY;UNTIL=20260106T093000Z" });
    expect(nextRoutineOccurrence(basicDateTime, new Date("2026-01-05T09:30:00.000Z"), "UTC")?.toISOString()).toBe("2026-01-06T00:00:00.000Z");
    expect(() => make({ kind: "rrule", rule: "FREQ=DAILY;UNTIL=20260106T246000Z" })).toThrow(/RRULE/i);
    expect(() => make({ kind: "rrule", rule: "FREQ=DAILY;BYDAY=MO;BYDAY=TU" })).toThrow(/RRULE/i);
  });

  it("rejects malformed frequency shapes and unit-specific selectors", () => {
    const base = { createdAt: "2026-01-01T00:00:00.000Z", frequency: { kind: "cycle", unit: "day", localTime: "09:00" } as RoutineFrequency, name: "x", prompt: "p", routineId: "r", workbenchId: "w" };
    for (const frequency of [undefined, [], "cycle", { kind: "unknown" }, { kind: "cycle", unit: "day", localTime: "09:00", daysOfWeek: [1] }, { kind: "cycle", unit: "week", localTime: "09:00", daysOfMonth: [1] }, { kind: "cycle", unit: "month", localTime: "09:00", daysOfWeek: [1] }, { kind: "cycle", unit: "day", localTime: "09:00", daysOfMonth: [1] }]) {
      expect(() => createRoutine({ ...base, frequency: frequency as unknown as RoutineFrequency })).toThrow();
    }
    expect(() => createRoutine({ ...base, frequency: { kind: "interval", hours: "1" } as unknown as RoutineFrequency })).toThrow(/interval/i);
    expect(() => createRoutine({ ...base, frequency: { kind: "interval", hours: -1 } })).toThrow(/interval/i);
    expect(() => createRoutine({ ...base, frequency: { kind: "once" } as unknown as RoutineFrequency })).toThrow();
    expect(createRoutine({ ...base, enabled: false }).enabled).toBe(false);
  });
});
