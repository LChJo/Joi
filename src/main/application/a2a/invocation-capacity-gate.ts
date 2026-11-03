export interface InvocationCapacityScope {
  endpointKey: string;
  lane?: "collaborator" | "primary";
  lifeId?: string;
}

interface Waiter {
  reject: (reason: unknown) => void;
  resolve: (release: () => void) => void;
  scope: InvocationCapacityScope;
  signal?: AbortSignal;
}

export class InvocationCapacityGate {
  private globalCount = 0;
  private readonly endpointCounts = new Map<string, number>();
  private readonly collaboratorLifeCounts = new Map<string, number>();
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limits = { collaboratorPerLife: 4, endpoint: 2, global: 4 }) {}

  acquire(scope: InvocationCapacityScope, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    if (this.canEnter(scope)) return Promise.resolve(this.enter(scope));
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { reject, resolve, scope, ...(signal === undefined ? {} : { signal }) };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal === undefined ? new Error("Invocation was canceled.") : abortError(signal));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const originalResolve = waiter.resolve;
      waiter.resolve = (release) => {
        signal?.removeEventListener("abort", abort);
        originalResolve(release);
      };
      this.waiters.push(waiter);
    });
  }

  snapshot() {
    return {
      collaboratorLives: Object.fromEntries(this.collaboratorLifeCounts),
      endpoints: Object.fromEntries(this.endpointCounts),
      global: this.globalCount,
      queued: this.waiters.length,
    };
  }

  private canEnter(scope: InvocationCapacityScope): boolean {
    if (this.globalCount >= this.limits.global) return false;
    if ((this.endpointCounts.get(scope.endpointKey) ?? 0) >= this.limits.endpoint) return false;
    return scope.lane !== "collaborator" || scope.lifeId === undefined
      || (this.collaboratorLifeCounts.get(scope.lifeId) ?? 0) < this.limits.collaboratorPerLife;
  }

  private enter(scope: InvocationCapacityScope): () => void {
    this.globalCount += 1;
    this.endpointCounts.set(scope.endpointKey, (this.endpointCounts.get(scope.endpointKey) ?? 0) + 1);
    if (scope.lane === "collaborator" && scope.lifeId !== undefined) {
      this.collaboratorLifeCounts.set(scope.lifeId, (this.collaboratorLifeCounts.get(scope.lifeId) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.globalCount -= 1;
      decrement(this.endpointCounts, scope.endpointKey);
      if (scope.lane === "collaborator" && scope.lifeId !== undefined) decrement(this.collaboratorLifeCounts, scope.lifeId);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length && this.globalCount < this.limits.global;) {
      const waiter = this.waiters[index];
      if (waiter === undefined) break;
      if (waiter.signal?.aborted === true) {
        this.waiters.splice(index, 1);
        waiter.reject(waiter.signal.reason ?? new Error("Invocation was canceled."));
        continue;
      }
      if (!this.canEnter(waiter.scope)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.resolve(this.enter(waiter.scope));
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Invocation was canceled.");
}

function decrement(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 1) - 1;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}
