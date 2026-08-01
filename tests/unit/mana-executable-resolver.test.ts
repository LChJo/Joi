import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveLocalCliExecutable } from "../../src/main/infrastructure/mana/local-cli-executable-resolver.js";

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function withPath(dir: string, run: () => void): void {
  const previous = process.env.PATH;
  process.env.PATH = dir;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

describe("local CLI executable resolver", () => {
  it("detects claude and codex on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "joi-cli-"));
    writeFileSync(join(dir, exe("claude")), "");
    writeFileSync(join(dir, exe("codex")), "");
    withPath(dir, () => {
      const claude = resolveLocalCliExecutable("claude");
      expect(claude.protocol).toBe("claude");
      expect(claude.executablePath).toBe(join(dir, exe("claude")));
      const codex = resolveLocalCliExecutable("codex");
      expect(codex.protocol).toBe("codex");
      expect(codex.executablePath).toBe(join(dir, exe("codex")));
    });
  });

  it("reports no executable when neither CLI is on PATH", () => {
    const empty = mkdtempSync(join(tmpdir(), "joi-cli-empty-"));
    withPath(empty, () => {
      expect(resolveLocalCliExecutable("claude").executablePath).toBeUndefined();
      expect(resolveLocalCliExecutable("codex").executablePath).toBeUndefined();
    });
  });
});
