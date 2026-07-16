import { RhythmPolicy } from "../../src/main/domain/rhythm/rhythm-policy";

describe("Rhythm Policy", () => {
  const policy = new RhythmPolicy();

  it("uses the Life timezone and wraparound quiet hours", () => {
    expect(policy.localDate(new Date("2026-07-15T16:30:00Z"), "Asia/Shanghai")).toBe("2026-07-16");
    expect(policy.isQuiet(new Date("2026-07-15T16:30:00Z"), "Asia/Shanghai")).toBe(true);
    expect(policy.isQuiet(new Date("2026-07-15T02:00:00Z"), "Asia/Shanghai")).toBe(false);
    expect(policy.isQuiet(new Date("2026-07-15T12:30:00Z"), "UTC", { start: "09:00", end: "17:00" })).toBe(true);
    expect(policy.isQuiet(new Date("2026-07-15T18:30:00Z"), "UTC", { start: "09:00", end: "17:00" })).toBe(false);
    expect(policy.nextQuietEnd(new Date("2026-07-15T23:30:15.250Z"), "UTC").toISOString()).toBe("2026-07-16T07:00:00.000Z");
    const daytime = new Date("2026-07-15T12:00:00.000Z");
    expect(policy.nextQuietEnd(daytime, "UTC")).toBe(daytime);
  });

  it("exempts human/recovery Wakes from autonomy but never from invocation limits", () => {
    expect(policy.authorize({
      autonomousLimit: 0, autonomousUsed: 0, eventTypes: ["human.message"], invocationLimit: 1, invocationsUsed: 0,
    })).toEqual({ allowed: true, consumesAutonomous: false });
    expect(policy.authorize({
      autonomousLimit: 0, autonomousUsed: 0, eventTypes: ["alarm.fired"], invocationLimit: 1, invocationsUsed: 0,
    })).toMatchObject({ allowed: false, reason: "AUTONOMOUS_LIMIT" });
    expect(policy.authorize({
      autonomousLimit: 24, autonomousUsed: 0, eventTypes: ["system.recovery"], invocationLimit: 1, invocationsUsed: 1,
    })).toMatchObject({ allowed: false, reason: "INVOCATION_LIMIT" });
  });

  it("rejects malformed quiet-hour configuration", () => {
    expect(() => policy.isQuiet(new Date(), "UTC", { start: "bad", end: "07:00" })).toThrow(/HH:mm/);
    expect(() => policy.isQuiet(new Date(), "UTC", { start: "07:00", end: "bad" })).toThrow(/HH:mm/);
  });

  it("resolves local schedules across day boundaries and DST gaps", () => {
    expect(policy.localTime(new Date("2026-07-15T12:34:00Z"), "UTC")).toBe("12:34");
    expect(policy.nextOccurrence(new Date("2026-07-15T12:00:00Z"), "UTC", "13:30").toISOString())
      .toBe("2026-07-15T13:30:00.000Z");
    expect(policy.nextOccurrence(new Date("2026-07-15T12:00:00Z"), "UTC", "11:00").toISOString())
      .toBe("2026-07-16T11:00:00.000Z");
    expect(policy.nextOccurrence(new Date("2026-03-08T06:30:00Z"), "America/New_York", "02:30").toISOString())
      .toBe("2026-03-09T06:30:00.000Z");
    expect(() => policy.nextOccurrence(new Date(), "UTC", "tomorrow")).toThrow(/HH:mm/);
    expect(() => policy.nextOccurrence(new Date(), "UTC", "24:00")).toThrow(/invalid/);
  });

  it("keeps calendar recurrence aligned to local weekdays and weekends", () => {
    const friday = new Date("2026-07-17T15:30:00Z");
    expect(policy.nextCalendarAlarm(friday, "UTC", "DAILY").toISOString()).toBe("2026-07-18T15:30:00.000Z");
    expect(policy.nextCalendarAlarm(friday, "UTC", "WEEKDAYS").toISOString()).toBe("2026-07-20T15:30:00.000Z");
    expect(policy.nextCalendarAlarm(friday, "UTC", "WEEKENDS").toISOString()).toBe("2026-07-18T15:30:00.000Z");
    expect(policy.nextCalendarAlarm(friday, "UTC", "WEEKLY").toISOString()).toBe("2026-07-24T15:30:00.000Z");
  });
});
