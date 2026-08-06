import { updateComponentSafely } from "./component-helpers.js";
import type { Actor, ActorComponent, ActorTickContext } from "../ports/actor-runtime.js";

/** Leaf actor for one (workbenchId, partnerId) agent; phase ① ships it as a structural shell. */
export class AgentActor implements Actor {
  constructor(private readonly dependencies: {
    workbenchId: string;
    components?: readonly ActorComponent[];
    partnerId: string;
  }) {}

  get actorId(): string {
    return `agent:${this.dependencies.workbenchId}:${this.dependencies.partnerId}`;
  }

  get workbenchId(): string {
    return this.dependencies.workbenchId;
  }

  get partnerId(): string {
    return this.dependencies.partnerId;
  }

  async update(ctx: ActorTickContext): Promise<void> {
    for (const component of this.dependencies.components ?? []) {
      await updateComponentSafely(ctx, this.actorId, component);
    }
  }
}
