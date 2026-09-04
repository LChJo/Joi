/* eslint-disable @typescript-eslint/require-await */
import { JoiRhythmComponent } from "../../src/main/application/actors/components/joi-rhythm-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";
import type { RuntimeDiagnosticEventMap } from "../../src/main/application/ports/runtime-diagnostics";

const NOW = new Date("2026-08-05T10:00:00.000Z");
const ctx: ActorTickContext = { clock: { now: () => NOW }, now: NOW, tickId: 1 };

describe("JoiRhythmComponent", () => {
  it("isolates a failing scheduler and keeps the rest ticking", async () => {
    const ticked: string[] = [];
    const component = new JoiRhythmComponent({
      services: [
        { name: "alarm", tick: async () => { ticked.push("alarm"); throw new Error("alarm_boom"); } },
        { name: "todo", tick: async () => { ticked.push("todo"); } },
      ],
    });
    await expect(component.update(ctx)).resolves.toBeUndefined();
    expect(ticked).toEqual(["alarm", "todo"]);
  });

  it("tracks a per-scheduler failure streak and resets it on recovery", async () => {
    const failures: RuntimeDiagnosticEventMap["joi.rhythm.tick_failed"][] = [];
    let fail = true;
    const component = new JoiRhythmComponent({
      services: [{ name: "budgets", tick: async () => { if (fail) throw new Error("budget_boom"); } }],
    });
    const diagnostics = { emit: (event: string, fields: Record<string, unknown>) => {
      if (event === "joi.rhythm.tick_failed") failures.push(fields as unknown as RuntimeDiagnosticEventMap["joi.rhythm.tick_failed"]);
    } };
    const withDiagnostics: ActorTickContext = { ...ctx, diagnostics };

    await component.update(withDiagnostics);
    await component.update(withDiagnostics);
    expect(failures.map((fields) => fields.consecutiveFailures)).toEqual([1, 2]);

    fail = false;
    await component.update(withDiagnostics);
    await component.update(withDiagnostics);
    expect(failures).toHaveLength(2);

    fail = true;
    await component.update(withDiagnostics);
    expect(failures.map((fields) => fields.consecutiveFailures)).toEqual([1, 2, 1]);
  });
});
