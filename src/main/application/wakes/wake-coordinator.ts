import type { WakeRunner } from "./wake-runner.js";

export class WakeCoordinator {
  private accepting = true;
  private readonly dirty = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly running = new Set<string>();

  constructor(private readonly dependencies: {
    canRun?: () => boolean | Promise<boolean>;
    leaseOwner: string;
    onError?: (error: unknown) => void;
    runner: WakeRunner;
  }) {}

  notify(lifeId: string): void {
    if (!this.accepting) return;
    this.dirty.add(lifeId);
    if (this.running.has(lifeId)) return;
    this.running.add(lifeId);
    void this.drain(lifeId);
  }

  isRunning(lifeId: string): boolean {
    return this.running.has(lifeId);
  }

  emergencyStop(lifeId: string): boolean {
    this.dirty.delete(lifeId);
    return this.dependencies.runner.cancelLife(lifeId);
  }

  async shutdown(timeoutMilliseconds = 30_000): Promise<{ forced: boolean }> {
    this.accepting = false;
    this.dirty.clear();
    if (this.running.size === 0) return { forced: false };
    const idle = new Promise<"idle">((resolve) => this.idleWaiters.add(() => resolve("idle")));
    let timeout: NodeJS.Timeout | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), timeoutMilliseconds);
      timeout.unref();
    });
    const result = await Promise.race([idle, expired]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (result === "idle") return { forced: false };
    for (const lifeId of this.running) this.dependencies.runner.cancelLife(lifeId);
    if (this.running.size > 0) {
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 1_000);
        fallback.unref();
        this.idleWaiters.add(() => { clearTimeout(fallback); resolve(); });
      });
    }
    return { forced: true };
  }

  private async drain(lifeId: string): Promise<void> {
    try {
      while (this.dirty.delete(lifeId)) {
        if (this.dependencies.canRun !== undefined && !await this.dependencies.canRun()) return;
        const result = await this.dependencies.runner.runLife(lifeId, this.dependencies.leaseOwner);
        if (result !== null && this.accepting) this.dirty.add(lifeId);
      }
    } catch (error) {
      this.dependencies.onError?.(error);
    } finally {
      this.running.delete(lifeId);
      if (this.running.size === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
      if (this.accepting && this.dirty.has(lifeId)) this.notify(lifeId);
    }
  }
}
