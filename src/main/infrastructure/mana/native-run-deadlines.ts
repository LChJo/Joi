/**
 * Enforces a bounded lifetime on one native agent run: a hard total deadline plus an
 * idle deadline that is refreshed every time streamed progress arrives. A run that is
 * still streaming when the total deadline expires gets one non-renewable grace window
 * to land its in-flight turn; a run whose progress already went stale gets no grace.
 * All timers are unref'd so they never hold the process open; dispose() clears them
 * exactly once.
 */
export class RunDeadlineGuard {
  #disposed = false;
  #fired = false;
  #graceMillis: number;
  #graceTimer: NodeJS.Timeout | undefined;
  #graceUsed = false;
  #idleMillis: number | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #onGrace: (() => void) | undefined;
  #onTimeout: (kind: "idle" | "total") => void;
  #recentlyActive = true;
  #recencyTimer: NodeJS.Timeout | undefined;
  #recencyWindowMillis: number;
  #totalTimer: NodeJS.Timeout | undefined;

  constructor(input: {
    /** One-shot landing window granted at total expiry to a run that is still streaming. */
    graceMillis?: number;
    /** How fresh progress must be at total expiry for the grace window to apply. */
    graceActiveWindowMillis?: number;
    idleMillis?: number;
    onGrace?: () => void;
    onTimeout: (kind: "idle" | "total") => void;
    totalMillis: number;
  }) {
    this.#graceMillis = input.graceMillis ?? 0;
    this.#idleMillis = input.idleMillis;
    this.#onGrace = input.onGrace;
    this.#onTimeout = input.onTimeout;
    this.#recencyWindowMillis = input.graceActiveWindowMillis ?? 0;
    this.#totalTimer = setTimeout(() => this.#totalExpired(), input.totalMillis);
    this.#totalTimer.unref();
    if (input.idleMillis !== undefined) {
      this.#idleTimer = setTimeout(() => this.#fire("idle"), input.idleMillis);
      this.#idleTimer.unref();
    }
    if (this.#graceConfigured()) this.#armRecency();
  }

  /** Refreshes the idle deadline; a run that keeps producing events may continue. */
  onProgress(): void {
    if (this.#disposed || this.#fired) return;
    if (this.#graceConfigured()) this.#armRecency();
    if (this.#idleTimer === undefined || this.#idleMillis === undefined) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#fire("idle"), this.#idleMillis);
    this.#idleTimer.unref();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#totalTimer !== undefined) clearTimeout(this.#totalTimer);
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    if (this.#graceTimer !== undefined) clearTimeout(this.#graceTimer);
    if (this.#recencyTimer !== undefined) clearTimeout(this.#recencyTimer);
  }

  /** Total expiry: a still-streaming run gets one grace window to land; anything else aborts at once. */
  #totalExpired(): void {
    if (this.#disposed || this.#fired) return;
    if (this.#graceConfigured() && !this.#graceUsed && this.#recentlyActive) {
      this.#graceUsed = true;
      this.#graceTimer = setTimeout(() => this.#fire("total"), this.#graceMillis);
      this.#graceTimer.unref();
      this.#onGrace?.();
      return;
    }
    this.#fire("total");
  }

  #graceConfigured(): boolean {
    return this.#graceMillis > 0 && this.#recencyWindowMillis > 0;
  }

  /** Progress seen within the recency window keeps the run eligible for the grace window. */
  #armRecency(): void {
    this.#recentlyActive = true;
    if (this.#recencyTimer !== undefined) clearTimeout(this.#recencyTimer);
    this.#recencyTimer = setTimeout(() => { this.#recentlyActive = false; }, this.#recencyWindowMillis);
    this.#recencyTimer.unref();
  }

  #fire(kind: "idle" | "total"): void {
    if (this.#disposed || this.#fired) return;
    this.#fired = true;
    this.#onTimeout(kind);
  }
}
