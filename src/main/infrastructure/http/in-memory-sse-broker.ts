import type { SseBroker, SseEvent } from "../../application/ports/runtime-store.js";

export class InMemorySseBroker implements SseBroker {
  private readonly listeners = new Set<(event: SseEvent) => void>();

  publish(event: SseEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: SseEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
