import { updateActorSafely, updateComponentSafely } from "./component-helpers.js";
import type { WorkbenchActor } from "./workbench-actor.js";
import type { JoiWorkbenchComponent } from "./components/joi-workbench-component.js";
import type { Actor, ActorComponent, ActorTickContext } from "../ports/actor-runtime.js";

/** The single global joi: the only scheduling authority in the process. */
export class JoiActor implements Actor {
  readonly actorId = "joi";
  readonly #children = new Map<string, WorkbenchActor>();

  constructor(private readonly dependencies: {
    workbenchComponent: JoiWorkbenchComponent;
    components: readonly ActorComponent[];
    createChild: (workbenchId: string) => WorkbenchActor;
  }) {}

  get workbenchActors(): readonly WorkbenchActor[] {
    return [...this.#children.values()];
  }

  async update(ctx: ActorTickContext): Promise<void> {
    for (const component of this.dependencies.components) {
      await updateComponentSafely(ctx, this.actorId, component);
    }
    await updateComponentSafely(ctx, this.actorId, this.dependencies.workbenchComponent);
    this.#reconcileChildren();
    for (const child of this.workbenchActors) {
      await updateActorSafely(ctx, child);
    }
  }

  #reconcileChildren(): void {
    const live = new Set<string>();
    for (const summary of this.dependencies.workbenchComponent.summaries) {
      live.add(summary.workbenchId);
      if (!this.#children.has(summary.workbenchId)) {
        this.#children.set(summary.workbenchId, this.dependencies.createChild(summary.workbenchId));
      }
    }
    for (const workbenchId of [...this.#children.keys()]) {
      if (!live.has(workbenchId)) this.#children.delete(workbenchId);
    }
  }
}
