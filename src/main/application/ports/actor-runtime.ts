import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import type { Clock } from "./runtime-store.js";

/** One pass of the single root loop; actors never own timers. */
export interface ActorTickContext {
  clock: Clock;
  diagnostics?: RuntimeDiagnostics;
  now: Date;
  tickId: number;
}

/** A traversable state unit inside an actor; periodic behavior = throttled timestamps in update. */
export interface ActorComponent {
  readonly componentName: string;
  readonly hasPendingWork?: boolean;
  update(ctx: ActorTickContext): Promise<void>;
}

/** A tree node reconciled every tick; coordination happens only through persisted facts. */
export interface Actor {
  readonly actorId: string;
  update(ctx: ActorTickContext): Promise<void>;
}
