import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
} from "../ports/runtime-diagnostics.js";
import type { Actor, ActorComponent, ActorTickContext } from "../ports/actor-runtime.js";

/** A failing component must never take down the rest of the tree; facts reconverge next tick. */
export async function updateComponentSafely(ctx: ActorTickContext, actorId: string, component: ActorComponent): Promise<void> {
  try {
    await component.update(ctx);
  } catch (error) {
    emitRuntimeDiagnostic(ctx.diagnostics, "joi.actor.component_failed", {
      actorId,
      componentName: component.componentName,
      errorCode: runtimeDiagnosticErrorCode(error),
    });
  }
}

export async function updateActorSafely(ctx: ActorTickContext, actor: Actor): Promise<void> {
  try {
    await actor.update(ctx);
  } catch (error) {
    emitRuntimeDiagnostic(ctx.diagnostics, "joi.actor.failed", {
      actorId: actor.actorId,
      errorCode: runtimeDiagnosticErrorCode(error),
    });
  }
}
