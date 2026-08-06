import { readFile } from "node:fs/promises";

describe("actor tree single root tick authority", () => {
  it("composes the actor tree as the only traversal driver and retires notify callbacks and SSE", async () => {
    const composition = await readFile("src/main/index.ts", "utf8");
    expect(composition).toContain("new ActorTree(");
    expect(composition).toContain("actorTree.tick(");
    expect(composition).not.toContain("new JoiInputScheduler(");
    expect(composition).not.toContain("processJoiInput");
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
