import { updateActorSafely, updateComponentSafely } from "./component-helpers.js";
import type { Actor, ActorComponent, ActorTickContext } from "../ports/actor-runtime.js";

/** One Workbench subtree node; phase ① ships it as a structural shell. */
export class WorkbenchActor implements Actor {
  constructor(private readonly dependencies: {
    workbenchId: string;
    children?: readonly Actor[] | (() => readonly Actor[]);
    components?: readonly ActorComponent[];
  }) {}

  get actorId(): string {
    return `workbench:${this.dependencies.workbenchId}`;
  }

  get workbenchId(): string {
    return this.dependencies.workbenchId;
  }

  async update(ctx: ActorTickContext): Promise<void> {
    for (const component of this.dependencies.components ?? []) {
      await updateComponentSafely(ctx, this.actorId, component);
    }
    const children = typeof this.dependencies.children === "function"
      ? this.dependencies.children()
      : this.dependencies.children ?? [];
    for (const child of children) {
      await updateActorSafely(ctx, child);
    }
  }
}
