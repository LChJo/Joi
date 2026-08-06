/* eslint-disable @typescript-eslint/require-await */
import { JoiRhythmComponent } from "../../src/main/application/actors/components/joi-rhythm-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";

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
});
