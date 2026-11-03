import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
} from "../../ports/runtime-diagnostics.js";
import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";

export interface RhythmTickEntry {
  name: string;
  tick: () => Promise<unknown>;
}

/** Folds the legacy idempotent rhythm ticks into the actor tree; signals only persist facts. */
export class JoiRhythmComponent implements ActorComponent {
  readonly componentName = "joi-rhythm";
  readonly #failureStreaks = new Map<string, number>();

  constructor(private readonly dependencies: {
    services: readonly RhythmTickEntry[];
  }) {}

  async update(ctx: ActorTickContext): Promise<void> {
    for (const entry of this.dependencies.services) {
      try {
        await entry.tick();
        this.#failureStreaks.delete(entry.name);
      } catch (error) {
        // Per-service streak makes a persistently failing scheduler visible instead of an
        // undifferentiated stream of single failures every tick.
        const consecutiveFailures = (this.#failureStreaks.get(entry.name) ?? 0) + 1;
        this.#failureStreaks.set(entry.name, consecutiveFailures);
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.rhythm.tick_failed", {
          consecutiveFailures,
          errorCode: runtimeDiagnosticErrorCode(error),
          service: entry.name,
        });
      }
    }
  }
}
