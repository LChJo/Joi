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

  it("does nothing after dispose even when timers were already queued", () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const guard = new RunDeadlineGuard({ idleMillis: 10, onTimeout: (kind) => fired.push(kind), totalMillis: 20 });
    guard.dispose();
    vi.advanceTimersByTime(1_000);
    expect(fired).toEqual([]);
  });
});
