import { PersistentConnectionBreaker } from "../../src/main/application/a2a/connection-breaker";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("shared Agent connection breaker", () => {
  it("shares cooldown across Lives, parses Retry-After formats and preserves the longer window", async () => {
    const fixture = await createRuntimeFixture();
    const breaker = new PersistentConnectionBreaker({ clock: fixture.clock, store: fixture.database.store });
    try {
      const key = breaker.keyFor({ agentConnectionId: "agent_1", credentialVersion: 2, origin: "http://192.168.1.20:43120" });
      expect(key).toMatch(/^[a-f0-9]{64}$/);
      expect(key).not.toContain("192.168.1.20");
      await breaker.recordRetryableResponse({ key, retryAfter: "120", status: 429 });
      await expect(breaker.assertAvailable(key)).rejects.toMatchObject({ code: "agent_rate_limited" });

      fixture.clock.advance(10_000);
      await breaker.recordRetryableResponse({
        key,
        retryAfter: new Date(fixture.clock.now().getTime() + 20_000).toUTCString(),
        status: 503,
      });
      const state = await fixture.database.store.getConnectionBreaker(key);
      expect(state?.openUntil).toBe("2026-07-15T12:02:00.000Z");

      fixture.clock.advance(111_000);
      await expect(breaker.assertAvailable(key)).resolves.toBeUndefined();
      await breaker.recordRetryableResponse({ key, retryAfter: "1", status: 429 });
      expect((await fixture.database.store.getConnectionBreaker(key))?.openUntil).toBe("2026-07-15T12:02:11.000Z");
    } finally {
      await fixture.close();
    }
  });

  it("reaps lapsed breaker rows so the table does not grow unbounded", async () => {
    const fixture = await createRuntimeFixture();
    const breaker = new PersistentConnectionBreaker({ clock: fixture.clock, store: fixture.database.store });
    try {
      const key = breaker.keyFor({ agentConnectionId: "agent_reap", credentialVersion: 1, origin: "http://192.168.1.30:43120" });
      await breaker.recordRetryableResponse({ key, retryAfter: "1", status: 429 });
      expect(await fixture.database.store.getConnectionBreaker(key)).not.toBeNull();

      // Past the cooldown the next availability check removes the lapsed row entirely.
      fixture.clock.advance(60_000);
      await expect(breaker.assertAvailable(key)).resolves.toBeUndefined();
      expect(await fixture.database.store.getConnectionBreaker(key)).toBeNull();
      await expect(fixture.database.store.deleteExpiredConnectionBreakers(fixture.clock.now().toISOString())).resolves.toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
