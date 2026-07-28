import { readFile } from "node:fs/promises";

describe("single joi scheduler authority", () => {
  it("does not compose the legacy Wake coordinator beside the global joi coordinator", async () => {
    const composition = await readFile("src/main/index.ts", "utf8");
    expect(composition).toContain("new JoiCoordinator(");
    expect(composition).not.toContain("new WakeCoordinator(");
    expect(composition).not.toContain("new WakeRunner(");
  });
});
