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
  ])("rejects forbidden import from %s to %s", (source, target) => {
    expect(validateImport(source, target)).toMatchObject({ allowed: false });
  });

  it("accepts the current production tree", async () => {
    const result = await scanProductionBoundaries(path.resolve("src"));
    expect(result.violations).toEqual([]);
    expect(result.unclassified).toEqual([]);
  });
});
