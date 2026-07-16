import { EventRetryPolicy } from "../../src/main/domain/events/event-retry-policy";
import { WakeLiveness } from "../../src/main/domain/wakes/wake-liveness";

describe("Wake liveness", () => {
  const liveness = new WakeLiveness({ staleThresholdMs: 30 * 60_000, startupGraceMs: 60_000 });
  const now = new Date("2026-07-15T12:00:00.000Z");

  it("keeps a Wake live for each allowed evidence path", () => {
    expect(liveness.isStale({ createdAt: "2026-07-15T10:00:00.000Z", inProcess: true, now })).toBe(false);
    expect(liveness.isStale({
      createdAt: "2026-07-15T10:00:00.000Z", inProcess: false, lastTurnActivityAt: "2026-07-15T11:45:00.000Z", now,
    })).toBe(false);
    expect(liveness.isStale({ createdAt: "2026-07-15T11:59:30.000Z", inProcess: false, now })).toBe(false);
  });

  it("only marks stale when marker, heartbeat and startup grace all fail", () => {
    expect(liveness.isStale({
      createdAt: "2026-07-15T10:00:00.000Z", inProcess: false, lastTurnActivityAt: "2026-07-15T11:00:00.000Z", now,
    })).toBe(true);
    expect(liveness.isStale({ createdAt: "2026-07-15T10:00:00.000Z", inProcess: false, now })).toBe(true);
  });
});

describe("event failure retry", () => {
  const policy = new EventRetryPolicy();

  it("uses the fixed 2/4/8/16/32/60 minute schedule", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    expect([1, 2, 3, 4, 5, 6, 7].map((attemptCount) => {
      const result = policy.afterFailure({ attemptCount, maxAttempts: 10, now });
      return result.status === "PENDING" ? result.delayMinutes : -1;
    }))
      .toEqual([2, 4, 8, 16, 32, 60, 60]);
    expect(policy.afterFailure({ attemptCount: 0, maxAttempts: 10, now })).toMatchObject({ delayMinutes: 2, status: "PENDING" });
  });

  it("dead-letters at max attempts without creating a replacement event", () => {
    expect(policy.afterFailure({ attemptCount: 8, maxAttempts: 8, now: new Date("2026-07-15T12:00:00.000Z") }))
      .toEqual({ attemptCount: 8, status: "DEAD_LETTER" });
  });
});
