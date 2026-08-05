import { JoiInputScheduler } from "../../src/main/application/joi/joi-input-scheduler.js";

describe("continuous joi input scheduler", () => {
  it("keeps accepted inputs in order and starts the next only at a safe turn boundary", async () => {
    const started: string[] = [];
    const releases: (() => void)[] = [];
    let running = 0;
    let maximumRunning = 0;
    const scheduler = new JoiInputScheduler({
      handle: async (inputId) => {
        started.push(inputId);
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
      },
    });

    scheduler.notify("input-1");
    scheduler.notify("input-2");
    scheduler.notify("input-2");
    await Promise.resolve();
    expect(started).toEqual(["input-1"]);
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["input-1", "input-2"]);
    releases.shift()?.();
    await scheduler.waitForIdle();
    expect(maximumRunning).toBe(1);
  });

  it("keeps draining after one failed input and reports the durable retry candidate", async () => {
    const handled: string[] = [];
    const failed: string[] = [];
    const scheduler = new JoiInputScheduler({
      handle: (inputId) => {
        handled.push(inputId);
        return inputId === "bad" ? Promise.reject(new Error("offline")) : Promise.resolve();
      },
      onError: (inputId) => failed.push(inputId),
    });
    await scheduler.waitForIdle();
    scheduler.notify("bad");
    scheduler.notify("good");
    await scheduler.waitForIdle();
    expect(handled).toEqual(["bad", "good"]);
    expect(failed).toEqual(["bad"]);
  });

  it("runs an active input again at the next safe boundary when clarification wakes the same id", async () => {
    const handled: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const scheduler = new JoiInputScheduler({
      handle: async (inputId) => {
        handled.push(inputId);
        if (handled.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      },
    });

    scheduler.notify("input-clarify");
    await Promise.resolve();
    scheduler.notify("input-clarify");
    releaseFirst?.();
    await scheduler.waitForIdle();

    expect(handled).toEqual(["input-clarify", "input-clarify"]);
  });
});
