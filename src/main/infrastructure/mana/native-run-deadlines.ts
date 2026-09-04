/**
 * Enforces a bounded lifetime on one native agent run: a hard total deadline plus an
 * idle deadline that is refreshed every time streamed progress arrives. Both timers are
 * unref'd so they never hold the process open; dispose() clears both exactly once.
 */
export class RunDeadlineGuard {
  #disposed = false;
  #fired = false;
  #idleMillis: number | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #onTimeout: (kind: "idle" | "total") => void;
  #totalTimer: NodeJS.Timeout | undefined;

  constructor(input: { idleMillis?: number; onTimeout: (kind: "idle" | "total") => void; totalMillis: number }) {
    this.#idleMillis = input.idleMillis;
    this.#onTimeout = input.onTimeout;
    this.#totalTimer = setTimeout(() => this.#fire("total"), input.totalMillis);
    this.#totalTimer.unref();
    if (input.idleMillis !== undefined) {
      this.#idleTimer = setTimeout(() => this.#fire("idle"), input.idleMillis);
      this.#idleTimer.unref();
    }
  }

  /** Refreshes the idle deadline; a run that keeps producing events may continue. */
  onProgress(): void {
    if (this.#disposed || this.#fired || this.#idleTimer === undefined || this.#idleMillis === undefined) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#fire("idle"), this.#idleMillis);
    this.#idleTimer.unref();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#totalTimer !== undefined) clearTimeout(this.#totalTimer);
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
  }

  #fire(kind: "idle" | "total"): void {
    if (this.#disposed || this.#fired) return;
    this.#fired = true;
    this.#onTimeout(kind);
  }
}
