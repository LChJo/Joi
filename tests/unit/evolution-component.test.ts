import { EvolutionComponent } from "../../src/main/application/actors/components/evolution-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";

it("scans durable evolution facts at startup then throttles without invoking a model", async () => {
  const scan = vi.fn();
  const component = new EvolutionComponent({ scan });
  const ctx = (time: number) => ({ now: new Date(time) }) as ActorTickContext;
  await component.update(ctx(0));
  await component.update(ctx(500));
  expect(scan).toHaveBeenCalledTimes(1);
  await component.update(ctx(10_000));
  expect(scan).toHaveBeenCalledTimes(2);
});

it("reports a bounded slow scan sample without changing the scan cadence", async () => {
  let monotonicTime = 0;
  const events: { name: string; payload: Record<string, unknown> }[] = [];
  const component = new EvolutionComponent({ scan: () => { monotonicTime += 75; } }, {
    monotonicNow: () => monotonicTime,
    slowScanMillis: 50,
  });
  const ctx = (time: number) => {
    const now = new Date(time);
    return {
      clock: { now: () => now },
      diagnostics: { emit: (name: string, payload: Record<string, unknown>) => { events.push({ name, payload }); } },
      now,
      tickId: 1,
    } as ActorTickContext;
  };

  await component.update(ctx(0));
  await component.update(ctx(10_000));

  expect(events).toEqual([{
    name: "joi.actor.scan_slow",
    payload: { componentName: "joi-evolution", durationMs: 75, step: "scan" },
  }]);
});
