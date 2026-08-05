export class JoiInputScheduler {
  readonly #pending: string[] = [];
  readonly #scheduled = new Set<string>();
  readonly #rerun = new Set<string>();
  readonly #idleWaiters = new Set<() => void>();
  #activeInputId: string | undefined;
  #running = false;

  constructor(private readonly dependencies: {
    handle(inputId: string): Promise<void>;
    onError?: (inputId: string, error: unknown) => void;
  }) {}

  notify(inputId: string): void {
    if (this.#scheduled.has(inputId)) {
      if (this.#activeInputId === inputId) this.#rerun.add(inputId);
      return;
    }
    this.#scheduled.add(inputId);
    this.#pending.push(inputId);
    void this.#drain();
  }

  async waitForIdle(): Promise<void> {
    if (!this.#running && this.#pending.length === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      let inputId = this.#pending.shift();
      while (inputId !== undefined) {
        this.#activeInputId = inputId;
        try {
          await this.dependencies.handle(inputId);
        } catch (error) {
          this.dependencies.onError?.(inputId, error);
        } finally {
          this.#activeInputId = undefined;
          if (this.#rerun.delete(inputId)) this.#pending.push(inputId);
          else this.#scheduled.delete(inputId);
        }
        inputId = this.#pending.shift();
      }
    } finally {
      this.#running = false;
      if (this.#pending.length > 0) {
        void this.#drain();
      } else {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    }
  }
}
