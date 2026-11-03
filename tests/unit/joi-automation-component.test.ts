import { describe, expect, it, vi } from "vitest";

import { JoiAutomationComponent } from "../../src/main/application/actors/components/joi-automation-component";
import type { AutomationStore } from "../../src/main/application/ports/automation";

describe("JoiAutomationComponent", () => {
  it("claims due routines through the injected store and reports both empty and non-empty ticks", async () => {
    const claimDue = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ inputId: "input_1", routineId: "routine_1", runId: "run_1" }]);
    const component = new JoiAutomationComponent({ store: { claimDue } as unknown as AutomationStore });
    const context = { now: new Date("2026-01-01T00:00:00.000Z"), tickId: 1, clock: { now: () => new Date("2026-01-01T00:00:00.000Z") } };
    await component.update(context);
    await component.update({ ...context, tickId: 2 });
    expect(claimDue).toHaveBeenCalledTimes(2);
    const lastCall = claimDue.mock.calls.at(-1)?.[0] as { now: string; timezone: string } | undefined;
    expect(lastCall?.now).toBe("2026-01-01T00:00:00.000Z");
    expect(typeof lastCall?.timezone).toBe("string");
  });
});
