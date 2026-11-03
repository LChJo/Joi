/* eslint-disable @typescript-eslint/require-await */
import { ActorTree } from "../../src/main/application/actors/actor-tree";
import type { Actor, ActorTickContext } from "../../src/main/application/ports/actor-runtime";

const NOW = new Date("2026-08-05T10:00:00.000Z");

function recordingActor(name: string, log: string[], options?: { throw?: boolean }): Actor {
  return {
    actorId: name,
    update: async () => {
      log.push(name);
      if (options?.throw === true) throw new Error(`${name}_boom`);
    },
  };
}

describe("ActorTree single root tick", () => {
  it("traverses roots in order and isolates a failing root", async () => {
    const log: string[] = [];
    const tree = new ActorTree({
      clock: { now: () => NOW },
      roots: [recordingActor("joi", log, { throw: true }), recordingActor("second", log)],
    });
    await tree.tick(NOW);
    expect(log).toEqual(["joi", "second"]);
  });

  it("guards reentrancy while a tick is in flight", async () => {
    let releases: (() => void)[] = [];
    let runs = 0;
    const slow: Actor = {
      actorId: "slow",
      update: async () => {
        runs += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    };
    const tree = new ActorTree({ clock: { now: () => NOW }, roots: [slow] });
    const first = tree.tick(NOW);
    const second = tree.tick(NOW);
    expect(second).toBe(first);
    expect(runs).toBe(1);
    releases.forEach((resolve) => resolve());
    releases = [];
    await first;
    const third = tree.tick(NOW);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases.forEach((resolve) => resolve());
    await third;
    expect(runs).toBe(2);
  });

  it("records joi.actor.failed through diagnostics when provided", async () => {
    const events: { name: string; payload: unknown }[] = [];
    const tree = new ActorTree({
      clock: { now: () => NOW },
      diagnostics: { emit: (name, payload) => { events.push({ name, payload }); } },
      roots: [recordingActor("joi", [], { throw: true })],
    });
    await tree.tick(NOW);
    expect(events.map((event) => event.name)).toContain("joi.actor.failed");
  });

  it("passes an incrementing tick id through the context", async () => {
    const seen: number[] = [];
    const tree = new ActorTree({
      clock: { now: () => NOW },
      roots: [{ actorId: "probe", update: async (ctx: ActorTickContext) => { seen.push(ctx.tickId); } }],
    });
    await tree.tick(NOW);
    await tree.tick(NOW);
    expect(seen).toEqual([1, 2]);
  });
});
