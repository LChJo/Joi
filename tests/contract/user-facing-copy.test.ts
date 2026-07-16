import { readFile } from "node:fs/promises";
import path from "node:path";

describe("user-facing copy contract", () => {
  it("does not use decorative em or en dashes in visible copy sources", async () => {
    const sources = await Promise.all([
      "src/renderer/App.tsx",
      "src/renderer/Onboarding.tsx",
      "src/renderer/Console.tsx",
      "src/main/interfaces/http/recovery-mode-handler.ts",
    ].map((file) => readFile(path.resolve(file), "utf8")));

    expect(sources.join("\n")).not.toMatch(/[–—]/u);
  });
});
