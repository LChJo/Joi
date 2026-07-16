import { WakeCoordinator } from "../../src/main/application/wakes/wake-coordinator";
import type { WakeRunner } from "../../src/main/application/wakes/wake-runner";

describe("Wake Coordinator", () => {
  it("coalesces notifications and drains again after a completed Wake", async () => {
    const runLife = vi.fn()
      .mockResolvedValueOnce({ status: "COMPLETED", turns: 1, wakeId: "wake_1" })
      .mockResolvedValueOnce(null);
    const cancelLife = vi.fn(() => true);
    const runner = { cancelLife, runLife } as unknown as WakeRunner;
    const coordinator = new WakeCoordinator({ leaseOwner: "runtime-a", runner });

    coordinator.notify("life_1");
    coordinator.notify("life_1");
    expect(coordinator.isRunning("life_1")).toBe(true);
    await vi.waitFor(() => expect(runLife).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(coordinator.isRunning("life_1")).toBe(false));
    expect(coordinator.emergencyStop("life_1")).toBe(true);
    expect(cancelLife).toHaveBeenCalledWith("life_1");
  });

  it("reports drain failures and releases the running marker", async () => {
    const failure = new Error("agent offline");
    const onError = vi.fn();
    const runner = {
      cancelLife: vi.fn(() => false),
      runLife: vi.fn(() => Promise.reject(failure)),
    } as unknown as WakeRunner;
    const coordinator = new WakeCoordinator({ leaseOwner: "runtime-a", onError, runner });

    coordinator.notify("life_2");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(coordinator.isRunning("life_2")).toBe(false);
    expect(coordinator.emergencyStop("life_2")).toBe(false);
  });

  it("leaves events untouched when the storage guard blocks new Wakes", async () => {
    const runLife = vi.fn();
    const runner = { cancelLife: vi.fn(() => false), runLife } as unknown as WakeRunner;
    const canRun = vi.fn().mockResolvedValue(false);
    const coordinator = new WakeCoordinator({ canRun, leaseOwner: "runtime-a", runner });
    coordinator.notify("life_low_disk");
    await vi.waitFor(() => expect(canRun).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(coordinator.isRunning("life_low_disk")).toBe(false));
    expect(runLife).not.toHaveBeenCalled();
  });

  it("stops accepting work and drains a running Wake before shutdown", async () => {
    let finish: (() => void) | undefined;
    const running = new Promise<null>((resolve) => { finish = () => resolve(null); });
    const cancelLife = vi.fn(() => true);
    const runLife = vi.fn(() => running);
    const runner = { cancelLife, runLife } as unknown as WakeRunner;
    const coordinator = new WakeCoordinator({ leaseOwner: "runtime-a", runner });
    coordinator.notify("life_drain");
    await vi.waitFor(() => expect(runLife).toHaveBeenCalledOnce());
    const shutdown = coordinator.shutdown(1_000);
    coordinator.notify("life_ignored");
    finish?.();
    await expect(shutdown).resolves.toEqual({ forced: false });
    expect(runLife).toHaveBeenCalledOnce();
    expect(cancelLife).not.toHaveBeenCalled();
  });
});
