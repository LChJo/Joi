import { transitionLifeState } from "../../src/main/domain/lives/life-state-machine";

describe("Life lifecycle", () => {
  it("runs the normal stopped, queued, running and sleeping loop", () => {
    expect(transitionLifeState("STOPPED", "START")).toBe("SLEEPING");
    expect(transitionLifeState("SLEEPING", "EVENT_AVAILABLE")).toBe("QUEUED");
    expect(transitionLifeState("QUEUED", "LEASE_ACQUIRED")).toBe("RUNNING");
    expect(transitionLifeState("RUNNING", "ACTIONS_COMMITTED")).toBe("SLEEPING");
  });

  it("supports pause/resume, user waiting, budgets, degradation and stop", () => {
    expect(transitionLifeState("RUNNING", "WAIT_USER")).toBe("WAITING_USER");
    expect(transitionLifeState("WAITING_USER", "EVENT_AVAILABLE")).toBe("QUEUED");
    expect(transitionLifeState("SLEEPING", "BUDGET_EXHAUSTED")).toBe("BUDGET_PAUSED");
    expect(transitionLifeState("BUDGET_PAUSED", "BUDGET_RESET")).toBe("QUEUED");
    expect(transitionLifeState("QUEUED", "PAUSE")).toBe("PAUSED");
    expect(transitionLifeState("PAUSED", "RESUME")).toBe("QUEUED");
    expect(transitionLifeState("RUNNING", "FAIL_PROTOCOL")).toBe("DEGRADED");
    expect(transitionLifeState("DEGRADED", "REPAIR")).toBe("QUEUED");
    expect(transitionLifeState("SLEEPING", "STOP")).toBe("STOPPED");
  });

  it("rejects transitions that would violate lifecycle invariants", () => {
    expect(() => transitionLifeState("STOPPED", "LEASE_ACQUIRED")).toThrow(/invalid/i);
    expect(() => transitionLifeState("RUNNING", "START")).toThrow(/invalid/i);
    expect(() => transitionLifeState("PAUSED", "EVENT_AVAILABLE")).toThrow(/invalid/i);
  });
});
