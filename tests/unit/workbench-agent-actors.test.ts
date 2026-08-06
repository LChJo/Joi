/* eslint-disable @typescript-eslint/require-await */
import { AgentActor } from "../../src/main/application/actors/agent-actor";
import { WorkbenchActor } from "../../src/main/application/actors/workbench-actor";
import { JoiActor } from "../../src/main/application/actors/joi-actor";
import { JoiWorkbenchComponent } from "../../src/main/application/actors/components/joi-workbench-component";
import type { Actor, ActorComponent, ActorTickContext } from "../../src/main/application/ports/actor-runtime";

const NOW = new Date("2026-08-05T10:00:00.000Z");
const ctx: ActorTickContext = { clock: { now: () => NOW }, now: NOW, tickId: 1 };

function probeComponent(name: string, log: string[]): ActorComponent {
  return {
    componentName: name,
    update: async () => {
      log.push(name);
    },
  };
}

describe("workbench and agent actor shells", () => {
  it("updates components and children in order", async () => {
    const log: string[] = [];
    const child: Actor = { actorId: "leaf", update: async () => { log.push("leaf"); } };
    const actor = new WorkbenchActor({
      workbenchId: "workbench_1",
      children: [child],
      components: [probeComponent("workbench-agent", log)],
    });
    expect(actor.actorId).toBe("workbench:workbench_1");
    await actor.update(ctx);
    expect(log).toEqual(["workbench-agent", "leaf"]);
  });

  it("resolves dynamic children at update time", async () => {
    const log: string[] = [];
    let children: Actor[] = [];
    const actor = new WorkbenchActor({ workbenchId: "workbench_dynamic", children: () => children });

    await actor.update(ctx);
    children = [{ actorId: "late-leaf", update: async () => { log.push("late-leaf"); } }];
    await actor.update(ctx);

    expect(log).toEqual(["late-leaf"]);
  });

  it("actors without components or children update cleanly", async () => {
    await expect(new WorkbenchActor({ workbenchId: "workbench_x" }).update(ctx)).resolves.toBeUndefined();
    await expect(new AgentActor({ workbenchId: "workbench_x", partnerId: "partner_x" }).update(ctx)).resolves.toBeUndefined();
  });

  it("agent actor exposes its identity and updates its components", async () => {
    const log: string[] = [];
    const actor = new AgentActor({
      workbenchId: "workbench_1",
      components: [probeComponent("agent-dispatch", log)],
      partnerId: "partner_1",
    });
    expect(actor.actorId).toBe("agent:workbench_1:partner_1");
    expect(actor.partnerId).toBe("partner_1");
    await actor.update(ctx);
    expect(log).toEqual(["agent-dispatch"]);
  });

  it("joi actor reconciles workbench children from the roster projection", async () => {
    const log: string[] = [];
    let roster: { workbenchId: string; name: string; scopeSummary: string; updatedAt: string }[] = [
      { workbenchId: "workbench_1", name: "甲", scopeSummary: "s", updatedAt: NOW.toISOString() },
    ];
    const joi = new JoiActor({
      workbenchComponent: new JoiWorkbenchComponent({ workbenches: { listSummaries: async () => roster } }),
      components: [],
      createChild: (workbenchId) => new WorkbenchActor({
        workbenchId,
        components: [probeComponent(`workbench:${workbenchId}`, log)],
      }),
    });
    await joi.update(ctx);
    expect(joi.workbenchActors.map((actor) => actor.workbenchId)).toEqual(["workbench_1"]);
    expect(log).toEqual(["workbench:workbench_1"]);

    await joi.update(ctx);
    expect(joi.workbenchActors.map((actor) => actor.workbenchId)).toEqual(["workbench_1"]);

    roster = [];
    await joi.update(ctx);
    expect(joi.workbenchActors).toEqual([]);
  });
});
