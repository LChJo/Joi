import { InvocationCapacityGate } from "../../src/main/application/a2a/invocation-capacity-gate";

describe("A2A invocation capacity gate", () => {
  it("admits at most four global invocations and two per endpoint", async () => {
    const gate = new InvocationCapacityGate();
    const releases = await Promise.all([
      gate.acquire({ endpointKey: "http://a" }),
      gate.acquire({ endpointKey: "http://a" }),
      gate.acquire({ endpointKey: "http://b" }),
      gate.acquire({ endpointKey: "http://c" }),
    ]);
    let globalFifthEntered = false;
    const globalFifth = gate.acquire({ endpointKey: "http://d" }).then((release) => {
      globalFifthEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(gate.snapshot()).toMatchObject({ global: 4, queued: 1 });
    expect(globalFifthEntered).toBe(false);
    releases[2]();
    const releaseFifth = await globalFifth;
    expect(globalFifthEntered).toBe(true);

    let endpointThirdEntered = false;
    const endpointThird = gate.acquire({ endpointKey: "http://a" }).then((release) => {
      endpointThirdEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(endpointThirdEntered).toBe(false);
    releases[0]();
    const releaseEndpointThird = await endpointThird;
    expect(endpointThirdEntered).toBe(true);

    releases[1](); releases[3](); releaseFifth(); releaseEndpointThird();
    expect(gate.snapshot()).toMatchObject({ global: 0, queued: 0 });
  });

  it("limits collaborators to four per Life without blocking another Life", async () => {
    const gate = new InvocationCapacityGate({ collaboratorPerLife: 4, endpoint: 2, global: 10 });
    const releases = await Promise.all(Array.from({ length: 4 }, (_, index) => gate.acquire({
      endpointKey: `http://agent-${String(index)}`,
      lane: "collaborator",
      lifeId: "life_a",
    })));
    let fifthEntered = false;
    const fifth = gate.acquire({ endpointKey: "http://agent-4", lane: "collaborator", lifeId: "life_a" }).then((release) => {
      fifthEntered = true;
      return release;
    });
    const otherLife = await gate.acquire({ endpointKey: "http://agent-5", lane: "collaborator", lifeId: "life_b" });
    await Promise.resolve();
    expect(fifthEntered).toBe(false);
    expect(gate.snapshot()).toMatchObject({ collaboratorLives: { life_a: 4, life_b: 1 }, queued: 1 });

    releases[0]?.();
    const releaseFifth = await fifth;
    expect(fifthEntered).toBe(true);
    releases.slice(1).forEach((release) => release());
    releaseFifth(); otherLife();
    expect(gate.snapshot()).toMatchObject({ global: 0, queued: 0 });
  });

  it("removes an aborted queued invocation", async () => {
    const gate = new InvocationCapacityGate({ collaboratorPerLife: 1, endpoint: 1, global: 1 });
    const release = await gate.acquire({ endpointKey: "http://agent" });
    const controller = new AbortController();
    const queued = gate.acquire({ endpointKey: "http://agent" }, controller.signal);
    controller.abort(new Error("canceled"));
    await expect(queued).rejects.toThrow("canceled");
    expect(gate.snapshot().queued).toBe(0);
    release();
  });

  it("rejects pre-aborted work, permits unscoped collaborator lanes, and makes release idempotent", async () => {
    const gate = new InvocationCapacityGate({ collaboratorPerLife: 1, endpoint: 2, global: 2 });
    const aborted = new AbortController();
    aborted.abort("not-an-error");
    await expect(gate.acquire({ endpointKey: "http://agent" }, aborted.signal)).rejects.toThrow("Invocation was canceled.");
    const first = await gate.acquire({ endpointKey: "http://agent", lane: "collaborator" });
    const second = await gate.acquire({ endpointKey: "http://agent", lane: "primary", lifeId: "life_1" });
    expect(gate.snapshot()).toMatchObject({ collaboratorLives: {}, endpoints: { "http://agent": 2 }, global: 2 });
    first(); first(); second();
    expect(gate.snapshot()).toMatchObject({ endpoints: {}, global: 0 });
  });

  it("drops a silently aborted waiter while draining capacity", async () => {
    const gate = new InvocationCapacityGate({ collaboratorPerLife: 1, endpoint: 1, global: 1 });
    const release = await gate.acquire({ endpointKey: "http://busy" });
    let aborted = false;
    const signal = {
      addEventListener: vi.fn(),
      get aborted() { return aborted; },
      reason: "silent cancel",
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const queued = gate.acquire({ endpointKey: "http://waiting" }, signal);
    aborted = true;
    release();
    await expect(queued).rejects.toBe("silent cancel");
    expect(gate.snapshot()).toMatchObject({ global: 0, queued: 0 });

    const fallbackGate = new InvocationCapacityGate({ collaboratorPerLife: 1, endpoint: 1, global: 1 });
    const fallbackRelease = await fallbackGate.acquire({ endpointKey: "http://busy" });
    let fallbackAborted = false;
    const fallbackSignal = {
      addEventListener: vi.fn(),
      get aborted() { return fallbackAborted; },
      reason: undefined,
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const fallbackQueued = fallbackGate.acquire({ endpointKey: "http://waiting" }, fallbackSignal);
    fallbackAborted = true;
    fallbackRelease();
    await expect(fallbackQueued).rejects.toThrow("Invocation was canceled.");
  });

  it("skips a blocked endpoint waiter and admits the next eligible endpoint", async () => {
    const gate = new InvocationCapacityGate({ collaboratorPerLife: 1, endpoint: 1, global: 2 });
    const releaseA = await gate.acquire({ endpointKey: "http://a" });
    const releaseB = await gate.acquire({ endpointKey: "http://b" });
    const waitingA = gate.acquire({ endpointKey: "http://a" });
    const waitingC = gate.acquire({ endpointKey: "http://c" });
    releaseB();
    const releaseC = await waitingC;
    expect(gate.snapshot()).toMatchObject({ endpoints: { "http://a": 1, "http://c": 1 }, queued: 1 });
    releaseA();
    const releaseWaitingA = await waitingA;
    releaseC();
    releaseWaitingA();
    expect(gate.snapshot()).toMatchObject({ global: 0, queued: 0 });
  });
});
