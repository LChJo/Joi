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

  constructor(private readonly dependencies: {
    services: readonly RhythmTickEntry[];
  }) {}

  async update(ctx: ActorTickContext): Promise<void> {
    for (const entry of this.dependencies.services) {
      try {
        await entry.tick();
      } catch (error) {
        emitRuntimeDiagnostic(ctx.diagnostics, "joi.rhythm.tick_failed", {
          errorCode: runtimeDiagnosticErrorCode(error),
          service: entry.name,
        });
      }
    }
  }
}
