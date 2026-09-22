import { RunDeadlineGuard } from "../../src/main/infrastructure/mana/native-run-deadlines";

describe("RunDeadlineGuard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the total deadline once and never again after dispose", async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const guard = new RunDeadlineGuard({ onTimeout: (kind) => fired.push(kind), totalMillis: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(["total"]);
    guard.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual(["total"]);
  });

  it("fires the idle deadline when progress stops and refreshes it while progress arrives", async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const guard = new RunDeadlineGuard({ idleMillis: 100, onTimeout: (kind) => fired.push(kind), totalMillis: 60_000 });
    await vi.advanceTimersByTimeAsync(90);
    guard.onProgress();
    await vi.advanceTimersByTimeAsync(90);
    guard.onProgress();
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toEqual(["idle"]);
    guard.dispose();
  });

  it("still enforces the total deadline while progress keeps refreshing the idle one", async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const guard = new RunDeadlineGuard({ idleMillis: 50, onTimeout: (kind) => fired.push(kind), totalMillis: 120 });
    // Progress at t=40 and t=80 keeps pushing the idle deadline out (to t=130), but the
    // total deadline at t=120 still fires first: a progressing run is not unbounded.
    await vi.advanceTimersByTimeAsync(40);
    guard.onProgress();
    await vi.advanceTimersByTimeAsync(40);
    guard.onProgress();
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);
    expect(fired).toEqual(["total"]);
    guard.dispose();
  });

  it("grants a still-streaming run one grace window at the total deadline instead of aborting mid-landing", async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    let graced = 0;
    const guard = new RunDeadlineGuard({ graceActiveWindowMillis: 50, graceMillis: 30, idleMillis: 500, onGrace: () => { graced += 1; }, onTimeout: (kind) => fired.push(kind), totalMillis: 100 });
    await vi.advanceTimersByTimeAsync(90);
    guard.onProgress();
    // Total deadline at t=100 sees fresh progress, so the abort waits out the grace window.
    await vi.advanceTimersByTimeAsync(10);
    expect(fired).toEqual([]);
    expect(graced).toBe(1);
    await vi.advanceTimersByTimeAsync(29);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(["total"]);
    guard.dispose();
  });

  it("lets a run that lands inside the grace window complete without a timeout", async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const guard = new RunDeadlineGuard({ graceActiveWindowMillis: 50, graceMillis: 30, idleMillis: 500, onTimeout: (kind) => fired.push(kind), totalMillis: 100 });
    await vi.advanceTimersByTimeAsync(90);
    guard.onProgress();
    await vi.advanceTimersByTimeAsync(20);
    guard.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual([]);
  });

  it("denies the grace window to a run whose progress went stale before the total deadline", async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const guard = new RunDeadlineGuard({ graceActiveWindowMillis: 20, graceMillis: 30, idleMillis: 500, onTimeout: (kind) => fired.push(kind), totalMillis: 100 });
    await vi.advanceTimersByTimeAsync(50);
    guard.onProgress();
    // Last progress at t=50 is outside the 20ms recency window when the total deadline expires.
    await vi.advanceTimersByTimeAsync(50);
    expect(fired).toEqual(["total"]);
    guard.dispose();
  });

  it("does not renew the grace window with further progress", async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const guard = new RunDeadlineGuard({ graceActiveWindowMillis: 50, graceMillis: 30, idleMillis: 500, onTimeout: (kind) => fired.push(kind), totalMillis: 100 });
    await vi.advanceTimersByTimeAsync(90);
    guard.onProgress();
    await vi.advanceTimersByTimeAsync(30);
    guard.onProgress();
    await vi.advanceTimersByTimeAsync(9);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(["total"]);
    guard.dispose();
  });

  it("does nothing after dispose even when timers were already queued", () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const guard = new RunDeadlineGuard({ idleMillis: 10, onTimeout: (kind) => fired.push(kind), totalMillis: 20 });
    guard.dispose();
    vi.advanceTimersByTime(1_000);
    expect(fired).toEqual([]);
  });
});
