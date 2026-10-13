import { readFile } from "node:fs/promises";

describe("single joi scheduler authority", () => {
  it("does not compose the legacy Wake coordinator beside the global joi coordinator", async () => {
    const composition = await readFile("src/main/index.ts", "utf8");
    const host = await readFile("src/main/composition/runtime-host.ts", "utf8");
    const joiWiring = await readFile("src/main/composition/wire-joi.ts", "utf8");
    const runtimeWiring = await readFile("src/main/composition/wire-runtime.ts", "utf8");
    expect(joiWiring).toContain("new JoiCoordinator(");
    for (const source of [composition, host, joiWiring, runtimeWiring]) {
      expect(source).not.toContain("new WakeCoordinator(");
      expect(source).not.toContain("new WakeRunner(");
    }
  });
});
