import { OutboxDispatcher } from "../../src/main/application/operations/outbox-dispatcher.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise,resolve };
}

describe("AC-43/48 background memory delivery",() => {
  it("drains every independent delivery when a later batch finishes before an earlier batch",async () => {
    const fixture = await createRuntimeFixture(),first = deferred(),second = deferred();
    const entered: string[] = [];
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock,owner: "concurrent",store: fixture.database.store,concurrent: true,
      handlers: { "test.concurrent": async record => { entered.push(record.outboxId);await (record.outboxId === "first" ? first.promise : second.promise); } } });
    try {
      await fixture.database.store.enqueueOutbox({ outboxId: "first",kind: "test.concurrent",payload: {},availableAt: fixture.clock.now().toISOString() });
      dispatcher.startOnce();await vi.waitFor(() => expect(entered).toEqual(["first"]));
      await fixture.database.store.enqueueOutbox({ outboxId: "second",kind: "test.concurrent",payload: {},availableAt: fixture.clock.now().toISOString() });
      dispatcher.startOnce();await vi.waitFor(() => expect(entered).toEqual(["first","second"]));
      second.resolve();
      await vi.waitFor(() => expect(fixture.database.transaction(db => db.prepare("SELECT status FROM outbox WHERE outbox_id='second'").get()?.status)).toBe("DONE"));
      expect(dispatcher.isRunning).toBe(true);
      let closed = false;const closing = dispatcher.close().then(() => { closed = true; });
      await Promise.resolve();expect(closed).toBe(false);expect(dispatcher.startOnce()).toBe(false);
      first.resolve();await closing;
      expect(dispatcher.isRunning).toBe(false);
      expect(fixture.database.transaction(db => db.prepare("SELECT status FROM outbox WHERE outbox_id='first'").get()?.status)).toBe("DONE");
    } finally { first.resolve();second.resolve();await dispatcher.close();await fixture.close(); }
  });

  it("does not renew a lease for handlers that finish before the first heartbeat",async () => {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.database.store.enqueueOutbox({ outboxId: "fast",kind: "test.fast",payload: {},availableAt: fixture.clock.now().toISOString() });
      const renewed = vi.spyOn(fixture.database.store,"renewOutboxClaim");
      const dispatcher = new OutboxDispatcher({ clock: fixture.clock,owner: "dispatcher",store: fixture.database.store,handlers: { "test.fast": () => Promise.resolve() } });
      expect(await dispatcher.dispatchOnce()).toBe(1);
      expect(renewed).not.toHaveBeenCalled();
      await dispatcher.close();
    } finally { await fixture.close(); }
  });

  it("returns immediately, starts one handler, yields to USER work and drains on close",async () => {
    const fixture = await createRuntimeFixture();
    const entered = deferred(); const finish = deferred();
    let busy = true;
    const handler = vi.fn(async () => { entered.resolve(); await finish.promise; });
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock,owner: "memory",store: fixture.database.store,
      includeKinds: ["partner.memory.refresh"],canStart: () => !busy,handlers: { "partner.memory.refresh": handler } });
    try {
      await fixture.database.store.enqueueOutbox({ outboxId: "memory",kind: "partner.memory.refresh",payload: {},availableAt: fixture.clock.now().toISOString() });
      expect(dispatcher.startOnce()).toBe(false);
      busy = false;
      expect(dispatcher.startOnce()).toBe(true);
      await entered.promise;
      expect(dispatcher.isRunning).toBe(true);
      expect(dispatcher.startOnce()).toBe(false);
      expect(handler).toHaveBeenCalledTimes(1);
      let closed = false;
      const closing = dispatcher.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      finish.resolve(); await closing;
      expect(dispatcher.isRunning).toBe(false);
      expect(dispatcher.startOnce()).toBe(false);
      expect(fixture.database.transaction(db => db.prepare("SELECT status FROM outbox WHERE outbox_id='memory'").get()?.status)).toBe("DONE");
    } finally { finish.resolve(); await dispatcher.close(); await fixture.close(); }
  });

  it("renews a suspended handler's lease so a different owner cannot start a second summary",async () => {
    const fixture = await createRuntimeFixture();
    const entered = deferred(); const finish = deferred();
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock,owner: "memory",store: fixture.database.store,
      includeKinds: ["partner.memory.refresh"],handlers: { "partner.memory.refresh": async () => { entered.resolve(); await finish.promise; } } });
    try {
      await fixture.database.store.enqueueOutbox({ outboxId: "memory",kind: "partner.memory.refresh",payload: {},availableAt: fixture.clock.now().toISOString() });
      vi.useFakeTimers();
      expect(dispatcher.startOnce()).toBe(true); await entered.promise;
      for (let n = 0; n < 5; n++) {
        fixture.clock.advance(10_000); await vi.advanceTimersByTimeAsync(10_000);
        expect(await fixture.database.store.claimOutbox({ includeKinds: ["partner.memory.refresh"],owner: "another-owner",limit: 1,
          now: fixture.clock.now().toISOString(),claimUntil: new Date(fixture.clock.now().getTime() + 30_000).toISOString() })).toEqual([]);
      }
      finish.resolve(); await dispatcher.drain();
      expect(fixture.database.transaction(db => db.prepare("SELECT attempt_count FROM outbox WHERE outbox_id='memory'").get()?.attempt_count)).toBe(1);
    } finally { finish.resolve(); await dispatcher.close(); vi.useRealTimers(); await fixture.close(); }
  });

  it("filters kinds without claiming foreground rows, backs failures off and recovers on a new dispatcher",async () => {
    const fixture = await createRuntimeFixture();
    try {
      for (const [outboxId,kind] of [["memory","partner.memory.refresh"],["foreground","test.foreground"]]) await fixture.database.store.enqueueOutbox({ outboxId: outboxId ?? "",kind: kind ?? "",payload: {},availableAt: fixture.clock.now().toISOString() });
      const onError = vi.fn();
      const first = new OutboxDispatcher({ clock: fixture.clock,owner: "memory",store: fixture.database.store,includeKinds: ["partner.memory.refresh"],
        handlers: { "partner.memory.refresh": () => Promise.reject(new Error("failure")) },onError });
      expect(first.startOnce()).toBe(true); await first.drain(); await first.close();
      const rows = fixture.database.transaction(db => db.prepare("SELECT outbox_id,status,attempt_count,available_at FROM outbox ORDER BY outbox_id").all());
      expect(rows[0]).toMatchObject({ outbox_id: "foreground",status: "PENDING",attempt_count: 0 });
      expect(rows[1]).toMatchObject({ outbox_id: "memory",status: "PENDING",attempt_count: 1,available_at: new Date(fixture.clock.now().getTime() + 120_000).toISOString() });
      expect(onError).toHaveBeenCalledOnce();
      const handler = vi.fn(() => Promise.resolve());
      const restarted = new OutboxDispatcher({ clock: fixture.clock,owner: "restarted",store: fixture.database.store,includeKinds: ["partner.memory.refresh"],handlers: { "partner.memory.refresh": handler } });
      expect(await restarted.dispatchOnce()).toBe(0);
      fixture.clock.advance(120_000);
      expect(restarted.startOnce()).toBe(true); await restarted.drain(); await restarted.close();
      expect(handler).toHaveBeenCalledOnce();
      expect(await fixture.database.store.claimOutbox({ includeKinds: [],owner: "empty",limit: 1,now: fixture.clock.now().toISOString(),claimUntil: fixture.clock.now().toISOString() })).toEqual([]);
      expect(await fixture.database.store.renewOutboxClaim?.({ outboxId: "memory",owner: "wrong",claimUntil: fixture.clock.now().toISOString() })).toBe(false);
    } finally { await fixture.close(); }
  });

  it("releases a claim without consuming its retry budget when USER work arrives before delivery",async () => {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.database.store.enqueueOutbox({ outboxId: "memory",kind: "partner.memory.refresh",payload: {},availableAt: fixture.clock.now().toISOString() });
      let busy = false;
      const original = fixture.database.store.claimOutbox.bind(fixture.database.store);
      vi.spyOn(fixture.database.store,"claimOutbox").mockImplementation(async query => { const records = await original(query); busy = true; return records; });
      const handler = vi.fn(() => Promise.resolve());
      const dispatcher = new OutboxDispatcher({ clock: fixture.clock,owner: "memory",store: fixture.database.store,canStart: () => !busy,
        includeKinds: ["partner.memory.refresh"],handlers: { "partner.memory.refresh": handler } });
      expect(dispatcher.startOnce()).toBe(true); await dispatcher.drain(); await dispatcher.close();
      expect(handler).not.toHaveBeenCalled();
      expect(fixture.database.transaction(db => db.prepare("SELECT status,attempt_count FROM outbox WHERE outbox_id='memory'").get())).toMatchObject({ status: "PENDING",attempt_count: 0 });
    } finally { await fixture.close(); }
  });

  it("surfaces background infrastructure failures through drain even when an observer throws",async () => {
    const fixture = await createRuntimeFixture();
    try {
      const failure = new Error("claim unavailable");
      vi.spyOn(fixture.database.store,"claimOutbox").mockRejectedValue(failure);
      const onBackgroundError = vi.fn(() => { throw new Error("observer unavailable"); });
      const dispatcher = new OutboxDispatcher({ clock: fixture.clock,owner: "memory",store: fixture.database.store,handlers: {},onBackgroundError });
      expect(dispatcher.startOnce()).toBe(true);
      await expect(dispatcher.drain()).rejects.toBe(failure);
      expect(onBackgroundError).toHaveBeenCalledWith(failure);
      expect(dispatcher.isRunning).toBe(false);
      await expect(dispatcher.close()).resolves.toBeUndefined();
    } finally { await fixture.close(); }
  });

  it("clears a recovered background claim failure after a later successful pass",async () => {
    const fixture = await createRuntimeFixture();
    const onBackgroundError = vi.fn();
    const handler = vi.fn(() => Promise.resolve());
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock,owner: "memory",store: fixture.database.store,handlers: { "test.recovery": handler },onBackgroundError });
    try {
      await fixture.database.store.enqueueOutbox({ outboxId: "recovery",kind: "test.recovery",payload: {},availableAt: fixture.clock.now().toISOString() });
      vi.spyOn(fixture.database.store,"claimOutbox").mockRejectedValueOnce(new Error("claim unavailable"));
      expect(dispatcher.startOnce()).toBe(true);
      await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledOnce());
      expect(dispatcher.startOnce()).toBe(true);
      await expect(dispatcher.drain()).resolves.toBeUndefined();
      expect(handler).toHaveBeenCalledOnce();
      await expect(dispatcher.close()).resolves.toBeUndefined();
    } finally { await dispatcher.close(); await fixture.close(); }
  });

  it("never acknowledges or releases a claim after another owner has recovered it",async () => {
    const fixture = await createRuntimeFixture();
    const entered = deferred(); const finish = deferred();
    const onBackgroundError = vi.fn();
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock,owner: "memory",store: fixture.database.store,includeKinds: ["partner.memory.refresh"],onBackgroundError,
      handlers: { "partner.memory.refresh": async () => { entered.resolve(); await finish.promise; } } });
    try {
      await fixture.database.store.enqueueOutbox({ outboxId: "memory",kind: "partner.memory.refresh",payload: {},availableAt: fixture.clock.now().toISOString() });
      expect(dispatcher.startOnce()).toBe(true); await entered.promise;
      fixture.clock.advance(31_000);
      expect(await fixture.database.store.claimOutbox({ owner: "recovery",includeKinds: ["partner.memory.refresh"],limit: 1,
        now: fixture.clock.now().toISOString(),claimUntil: new Date(fixture.clock.now().getTime() + 30_000).toISOString() })).toHaveLength(1);
      finish.resolve();
      await expect(dispatcher.drain()).rejects.toMatchObject({ code: "outbox_claim_lost" });
      expect(onBackgroundError).toHaveBeenCalledOnce();
      expect(fixture.database.transaction(db => db.prepare("SELECT status,claim_owner FROM outbox WHERE outbox_id='memory'").get())).toMatchObject({ status: "CLAIMED",claim_owner: "recovery" });
    } finally { finish.resolve(); await dispatcher.close(); await fixture.close(); }
  });
});
