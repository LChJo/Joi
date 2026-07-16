import type { Clock, RuntimeStore, SseBroker, SseEvent, SsePublisher } from "../ports/runtime-store.js";

const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export interface SseReplay {
  events: SseEvent[];
  latestSequence: number;
  resetRequired: boolean;
}

export class SseService implements SsePublisher {
  constructor(private readonly dependencies: {
    broker: SseBroker;
    clock: Clock;
    store: Pick<RuntimeStore, "getSseSequenceWindow" | "listSseEvents" | "pruneSseEventsBefore">;
  }) {}

  listAfter(sequence: number, limit: number) {
    return this.dependencies.store.listSseEvents(sequence, limit);
  }

  async replayAfter(sequence: number, limit: number): Promise<SseReplay> {
    const cutoff = new Date(this.dependencies.clock.now().getTime() - RETENTION_MILLISECONDS).toISOString();
    await this.dependencies.store.pruneSseEventsBefore(cutoff);
    const window = await this.dependencies.store.getSseSequenceWindow();
    const earliest = window.earliestRetainedSequence;
    const resetRequired = sequence > 0 && sequence < window.latestIssuedSequence
      && (earliest === undefined || sequence < earliest - 1);
    return {
      events: resetRequired ? [] : await this.dependencies.store.listSseEvents(sequence, limit),
      latestSequence: window.latestIssuedSequence,
      resetRequired,
    };
  }

  publish(event: SseEvent) {
    this.dependencies.broker.publish(event);
  }

  subscribe(listener: (event: SseEvent) => void) {
    return this.dependencies.broker.subscribe(listener);
  }
}
