import { readFile } from "node:fs/promises";

describe("desktop runtime isolation (AC-PERF-01)", () => {
  it("keeps the database and scheduler outside the Electron window thread", async () => {
    const desktop = await readFile("src/main/index.ts", "utf8");
    expect(desktop).not.toContain("openRuntimeDatabase(");
    expect(desktop).not.toContain("actorTree.tick(");
    expect(desktop).toContain("startDesktopRuntime(");
    const host = await readFile("src/main/composition/runtime-host.ts", "utf8");
    expect(host).toContain("openRuntimeDatabase(");
    expect(host).toContain("actorTree.tick(");
    expect(host).not.toMatch(/from ["']electron["']/u);
  });

  it("reconciles durable turns and dispatch claims before the first desktop scheduling tick", async () => {
    const host = await readFile("src/main/composition/runtime-host.ts", "utf8");
    const firstDispatch = host.indexOf("await runtimeStack.outboxDispatcher.dispatchOnce();");
    const firstTick = host.indexOf("await runtimeStack.actorTree.tick(");
    expect(firstDispatch).toBeGreaterThan(-1);
    expect(firstTick).toBeGreaterThan(firstDispatch);
    for (const step of ["joiInboxRepository", "dispatchClaims"]) {
      const recovery = host.indexOf(`await persistence.${step}.recoverOnBoot();`);
      expect(recovery).toBeGreaterThan(-1);
      expect(recovery).toBeLessThan(firstDispatch);
    }
  });
});
