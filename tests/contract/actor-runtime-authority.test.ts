import { readFile } from "node:fs/promises";

import { ActorTree } from "../../src/main/application/actors/actor-tree.js";
import { JoiActor } from "../../src/main/application/actors/joi-actor.js";
import { WorkbenchActor } from "../../src/main/application/actors/workbench-actor.js";
import type { JoiWorkbenchComponent } from "../../src/main/application/actors/components/joi-workbench-component.js";
import type { ActorComponent } from "../../src/main/application/ports/actor-runtime.js";
import { TestClock } from "../support/runtime-fixture.js";

describe("actor tree single root tick authority", () => {
  it("composes the actor tree as the only traversal driver and retires notify callbacks and SSE", async () => {
    const composition = await readFile("src/main/composition/runtime-host.ts", "utf8");
    const wiring = await readFile("src/main/composition/wire-runtime.ts", "utf8");
    expect(wiring).toContain("new ActorTree(");
    expect(composition).toContain("actorTree.tick(");
    expect(composition).not.toContain("new JoiInputScheduler(");
    expect(composition).not.toContain("processJoiInput");
    expect(wiring).not.toContain("new JoiInputScheduler(");
    expect(wiring).not.toContain("processJoiInput");
  });

  it("wires exactly one root actor and keeps the fixed component order in the composition source", async () => {
    const wiring = await readFile("src/main/composition/wire-runtime.ts", "utf8");
    expect(wiring).toContain("roots: [new JoiActor(");
    const orderedMarkers = ["new JoiAutomationComponent(", "new JoiTaskComponent(", "new JoiHarnessComponent(", "new JoiRhythmComponent("];
    let lastIndex = -1;
    for (const marker of orderedMarkers) {
      const index = wiring.indexOf(marker);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("traverses joi components in order, then the workbench component, then child actors", async () => {
    const calls: string[] = [];
    const fakeComponent = (name: string): ActorComponent => ({
      componentName: name,
      update: () => { calls.push(name); return Promise.resolve(); },
    });
    const workbenchComponent = {
      componentName: "joi-workbench",
      summaries: [{ workbenchId: "workbench-a" }],
      update: () => { calls.push("workbench"); return Promise.resolve(); },
    } as unknown as JoiWorkbenchComponent;
    const clock = new TestClock();
    const tree = new ActorTree({
      clock,
      roots: [new JoiActor({
        workbenchComponent,
        components: [fakeComponent("automation"), fakeComponent("task"), fakeComponent("harness"), fakeComponent("rhythm")],
        createChild: (workbenchId) => new WorkbenchActor({
          workbenchId,
          children: () => [],
          components: [fakeComponent(`agent:${workbenchId}`)],
        }),
      })],
    });
    await tree.tick(clock.now());
    expect(calls).toEqual(["automation", "task", "harness", "rhythm", "workbench", "agent:workbench-a"]);
  });

  it("removes the SSE stream endpoint from the HTTP surface", async () => {
    const handler = await readFile("src/main/interfaces/http/api-handler.ts", "utf8");
    expect(handler).not.toContain("/api/v1/stream");
  });

  it("documents the actor/component/tick vocabulary in ADR 0009", async () => {
    const adr = await readFile("docs/adr/0009-actor-tree-single-root-tick.md", "utf8");
    for (const term of ["actor", "component", "tick", "唯一调度权威", "SQLite"]) {
      expect(adr).toContain(term);
    }
  });
});
