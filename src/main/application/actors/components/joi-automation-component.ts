import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";
import type { AutomationStore } from "../../ports/automation.js";
import { emitRuntimeDiagnostic } from "../../ports/runtime-diagnostics.js";

/** Claims due Routine occurrences into ordinary Joi PENDING inbox rows. */
export class JoiAutomationComponent implements ActorComponent {
  readonly componentName = "joi-automation";

  constructor(private readonly dependencies: { store: AutomationStore }) {}

  async update(ctx: ActorTickContext): Promise<void> {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const triggers = await this.dependencies.store.claimDue({ now: ctx.now.toISOString(), timezone });
    if (triggers.length > 0) {
      emitRuntimeDiagnostic(ctx.diagnostics, "joi.automation.claimed", { count: triggers.length });
    }
  }
}
