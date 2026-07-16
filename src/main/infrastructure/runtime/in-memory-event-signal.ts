import type { EventSignal } from "../../application/ports/runtime-core-ports.js";

export class InMemoryEventSignal implements EventSignal {
  private readonly listeners = new Map<string, Set<(eventId: string) => void>>();

  publish(wakeId: string, eventId: string): void {
    for (const listener of this.listeners.get(wakeId) ?? []) listener(eventId);
  }

  subscribe(wakeId: string, listener: (eventId: string) => void): () => void {
    const listeners = this.listeners.get(wakeId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(wakeId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(wakeId);
    };
  }
}
