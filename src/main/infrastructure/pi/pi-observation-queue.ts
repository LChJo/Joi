/** Display consumers cannot hold an SDK event callback or grow an unbounded backlog. */
export class PiObservationQueue {
  readonly #pending: (() => Promise<void>)[] = [];
  #running = false;
  #closed = false;
  constructor(private readonly degraded: () => void, private readonly capacity = 256) {}

  enqueue(deliver: () => Promise<void>): void {
    if (this.#closed) return;
    if (this.#pending.length >= this.capacity) {
      this.#pending.shift();
      this.#degrade();
    }
    this.#pending.push(deliver);
    if (!this.#running) { this.#running = true; queueMicrotask(() => { void this.#consume(); }); }
  }

  close(): void { this.#closed = true; }

  async #consume(): Promise<void> {
    try {
      let next: (() => Promise<void>) | undefined;
      while ((next = this.#pending.shift()) !== undefined) {
        try { await next(); } catch { this.#degrade(); }
      }
    } finally { this.#running = false; }
  }

  #degrade(): void { try { this.degraded(); } catch { /* Observers cannot affect the producer. */ } }
}
