import { OutboxDispatcher } from "../../src/main/application/operations/outbox-dispatcher";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("runtime lease and outbox", () => {
  it("keeps one lease owner and increments generation after expiry", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const first = await fixture.database.store.acquireLease({
        expiresAt: "2026-07-15T12:01:00.000Z",
        owner: "runtime-a",
        resourceId: "life_1",
        resourceType: "life",
        now: "2026-07-15T12:00:00.000Z",
      });
      const blocked = await fixture.database.store.acquireLease({
        expiresAt: "2026-07-15T12:01:30.000Z",
        owner: "runtime-b",
        resourceId: "life_1",
        resourceType: "life",
        now: "2026-07-15T12:00:30.000Z",
      });
      const recovered = await fixture.database.store.acquireLease({
        expiresAt: "2026-07-15T12:03:00.000Z",
        owner: "runtime-b",
        resourceId: "life_1",
        resourceType: "life",
        now: "2026-07-15T12:02:00.000Z",
      });

      expect(first).toMatchObject({ generation: 1, owner: "runtime-a" });
      expect(blocked).toBeNull();
      expect(recovered).toMatchObject({ generation: 2, owner: "runtime-b" });
    } finally {
      await fixture.close();
    }
  });

  it("claims committed outbox rows once within the claim lease", async () => {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.database.store.enqueueOutbox({
        availableAt: "2026-07-15T12:00:00.000Z",
        kind: "sse.publish",
        outboxId: "outbox_1",
        payload: { sequence: 1 },
      });
      const first = await fixture.database.store.claimOutbox({
        claimUntil: "2026-07-15T12:01:00.000Z",
        limit: 10,
        now: "2026-07-15T12:00:00.000Z",
        owner: "dispatcher-a",
      });
      const second = await fixture.database.store.claimOutbox({
        claimUntil: "2026-07-15T12:01:30.000Z",
        limit: 10,
        now: "2026-07-15T12:00:30.000Z",
        owner: "dispatcher-b",
      });

      expect(first).toEqual([expect.objectContaining({ outboxId: "outbox_1", status: "CLAIMED" })]);
      expect(second).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("dispatches known records once and releases failures with bounded backoff", async () => {
    const fixture = await createRuntimeFixture();
    try {
      for (const outboxId of ["outbox_ok", "outbox_retry"]) {
        await fixture.database.store.enqueueOutbox({
          availableAt: fixture.clock.now().toISOString(),
          kind: "test.send",
          outboxId,
          payload: { outboxId },
        });
      }
      const handled: string[] = [];
      const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
      const onError = vi.fn();
      const dispatcher = new OutboxDispatcher({
        clock: fixture.clock,
        diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
        handlers: {
          "test.send": (record) => {
            handled.push(record.outboxId);
            return record.outboxId === "outbox_retry" ? Promise.reject(new Error("offline")) : Promise.resolve();
          },
        },
        onError,
        owner: "dispatcher-a",
        store: fixture.database.store,
      });
      expect(await dispatcher.dispatchOnce()).toBe(2);
      expect(handled).toEqual(["outbox_ok", "outbox_retry"]);
      expect((await fixture.database.store.getRuntimeStats()).pendingOutbox).toBe(1);
      expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ outboxId: "outbox_retry" }));
      expect(await dispatcher.dispatchOnce()).toBe(0);
      expect(diagnostics.map((entry) => entry.event)).toEqual(expect.arrayContaining([
        "joi.outbox.claimed",
        "joi.outbox.delivery_started",
        "joi.outbox.delivery_completed",
        "joi.outbox.delivery_released",
      ]));
      expect(diagnostics.filter((entry) => entry.event === "joi.outbox.claimed")).toHaveLength(1);
      expect(diagnostics.find((entry) => entry.event === "joi.outbox.delivery_released")?.fields).toMatchObject({
        attemptCount: 1,
        errorCode: "Error",
        kind: "test.send",
        outboxId: "outbox_retry",
      });
      expect(JSON.stringify(diagnostics)).not.toContain("offline");
    } finally {
      await fixture.close();
    }
  });

  it("shares one in-flight dispatch pass after a long handler outlives its claim lease", async () => {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.database.store.enqueueOutbox({
        availableAt: fixture.clock.now().toISOString(), kind: "test.long", outboxId: "outbox_long", payload: {},
      });
      let finish!: () => void;
      let started!: () => void;
      const blocker = new Promise<void>((resolve) => { finish = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const handled: string[] = [];
      const dispatcher = new OutboxDispatcher({
        clock: fixture.clock,
        handlers: { "test.long": async (record) => { handled.push(record.outboxId); started(); await blocker; } },
        owner: "dispatcher-long",
        store: fixture.database.store,
      });

      const first = dispatcher.dispatchOnce();
      await entered;
      fixture.clock.advance(31_000);
      const overlapping = dispatcher.dispatchOnce();
      await Promise.resolve();
      await Promise.resolve();

      expect(handled).toEqual(["outbox_long"]);
      finish();
      await expect(Promise.all([first, overlapping])).resolves.toEqual([1, 1]);
      expect(handled).toEqual(["outbox_long"]);
    } finally {
      await fixture.close();
    }
  });

  it("releases an outbox kind that has no registered handler", async () => {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.database.store.enqueueOutbox({
        availableAt: fixture.clock.now().toISOString(), kind: "unknown.send", outboxId: "outbox_unknown", payload: {},
      });
      const dispatcher = new OutboxDispatcher({
        clock: fixture.clock, handlers: {}, owner: "dispatcher-no-handler", store: fixture.database.store,
      });
      await expect(dispatcher.dispatchOnce(1)).resolves.toBe(1);
      expect((await fixture.database.store.getRuntimeStats()).pendingOutbox).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
