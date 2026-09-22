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
