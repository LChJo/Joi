import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";

/** Bounded fact traversal; all inference stays in the existing Joi task slot. */
export class EvolutionComponent implements ActorComponent {
  readonly componentName = "joi-evolution";
  #lastScanAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly evolution: { scan(): void }) {}
  update(ctx: ActorTickContext): Promise<void> {
    if (ctx.now.getTime() - this.#lastScanAt >= 10_000) {
      this.#lastScanAt = ctx.now.getTime();
      this.evolution.scan();
    }
    return Promise.resolve();
  }
}
