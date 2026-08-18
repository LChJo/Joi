import path from "node:path";

import {
  classifyProductionPath,
  scanProductionBoundaries,
  validateImport,
} from "../../scripts/architecture-boundaries.mjs";

describe("production import boundaries", () => {
  it("classifies every production directory and rejects unknown directories", () => {
    expect(classifyProductionPath("src/main/domain/life.ts")).toBe("domain");
    expect(classifyProductionPath("src/main/unclassified/example.ts")).toBeNull();
  });

  it.each([
    ["src/main/domain/life.ts", "electron"],
    ["src/main/domain/life.ts", "better-sqlite3"],
    ["src/main/domain/life.ts", "@a2a-js/sdk"],
    ["src/renderer/App.tsx", "node:fs"],
    ["src/main/interfaces/http/router.ts", "../../domain/life.js"],
    ["src/main/infrastructure/pi/runner.ts", "@rd-efficiency/agentsdk"],
    ["src/main/application/partners/service.ts", "@rd-efficiency/agentsdk/types"],
    ["src/main/infrastructure/mana/runner.ts", "@earendil-works/pi-agent-core"],
    ["src/renderer/App.tsx", "@rd-efficiency/agentsdk"],
  ])("rejects forbidden import from %s to %s", (source, target) => {
    expect(validateImport(source, target)).toMatchObject({ allowed: false });
  });

  it("confines each engine SDK to its own infrastructure directory", () => {
    expect(validateImport("src/main/infrastructure/mana/local-cli-partner-engine-runtime.ts", "@rd-efficiency/agentsdk")).toMatchObject({ allowed: true });
    expect(validateImport("src/main/infrastructure/pi/pi-coding-partner-runner.ts", "@earendil-works/pi-agent-core")).toMatchObject({ allowed: true });
  });

  // Full-suite parallel load can starve this filesystem scan well past the default 5s.
  it("accepts the current production tree", async () => {
    const result = await scanProductionBoundaries(path.resolve("src"));
    expect(result.violations).toEqual([]);
    expect(result.unclassified).toEqual([]);
  }, 30_000);
});
