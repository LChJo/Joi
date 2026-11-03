import { updateActorSafely } from "./component-helpers.js";
import type { Actor, ActorTickContext } from "../ports/actor-runtime.js";
import type { RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import type { Clock } from "../ports/runtime-store.js";

/**
 * Single root tick: one loop traverses joi → workbench → agent in order every pass.
 * Reentrancy-guarded like the outbox dispatcher; actors never own timers.
 */
export class ActorTree {
  #inFlight: Promise<void> | null = null;
  #tickId = 0;

  constructor(private readonly dependencies: {
    clock: Clock;
    diagnostics?: RuntimeDiagnostics;
    roots: readonly Actor[];
  }) {}

  tick(now: Date): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    const chained = this.#tick(now).finally(() => {
      if (this.#inFlight === chained) this.#inFlight = null;
    });
    this.#inFlight = chained;
    return chained;
  }

  async #tick(now: Date): Promise<void> {
    this.#tickId += 1;
    const ctx: ActorTickContext = {
      clock: this.dependencies.clock,
      ...(this.dependencies.diagnostics === undefined ? {} : { diagnostics: this.dependencies.diagnostics }),
      now,
      tickId: this.#tickId,
    };
    for (const root of this.dependencies.roots) {
      await updateActorSafely(ctx, root);
    }
  }
}
