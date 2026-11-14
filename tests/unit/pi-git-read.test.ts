import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuiltinPiCodingToolFactory } from "../../src/main/infrastructure/pi/pi-coding-tool-factory.js";
import { LocalWriteGate } from "../../src/main/application/partners/local-write-gate.js";

describe("AC-WR-08 Git inspection without a write lease", () => {
  it("reads status, diffs and committed evidence without shell execution or index writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "joi-git-read-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    try {
      git("init", "-b", "main");
      git("config", "core.autocrlf", "false");
      writeFileSync(join(root, "input.txt"), "initial\n");
      writeFileSync(join(root, "unchanged.txt"), "unchanged\n");
      git("add", "--", "input.txt", "unchanged.txt");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture commit");
      utimesSync(join(root, "unchanged.txt"), new Date(0), new Date(0));
      const beforeRefresh = readFileSync(join(root, ".git", "index"));
      git("status", "--short");
      expect(readFileSync(join(root, ".git", "index"))).not.toEqual(beforeRefresh);
      writeFileSync(join(root, "input.txt"), "updated\n");
      git("add", "--", "input.txt");
      writeFileSync(join(root, "input.txt"), "working tree\n");
      const marker = join(root, "external-command-ran");
      writeFileSync(join(root, "external.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`);
      git("config", "diff.external", `"${process.execPath.replaceAll("\\", "/")}" external.cjs`);
      git("config", "core.fsmonitor", `"${process.execPath.replaceAll("\\", "/")}" external.cjs`);
      utimesSync(join(root, "unchanged.txt"), new Date(1000), new Date(1000));
      const index = readFileSync(join(root, ".git", "index"));
      const [tool] = new BuiltinPiCodingToolFactory().create(root, ["git_read"]);
      if (tool === undefined) throw new Error("git tool missing");
      const gate = new LocalWriteGate({ accessCeiling: "READ", phase: "READ_RUNNING", generation: 1 });
      expect(gate.beforeTool(tool.name)).toBeUndefined();
      for (const [action, expected] of [["status", "input.txt"], ["diff", "+working tree"], ["log", "fixture commit"], ["show", "initial"]]) {
        const result = await tool.execute("read", { action });
        expect(JSON.stringify(result.content)).toContain(expected);
        expect(readFileSync(join(root, ".git", "index")), action).toEqual(index);
      }
      expect(JSON.stringify((await tool.execute("staged", { action: "diff", staged: true, revision: "HEAD" })).content)).toContain("+updated");
      expect(gate.suspended).toBe(false);
      expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
      expect(existsSync(marker)).toBe(false);
      await expect(tool.execute("bad", { action: "commit" })).rejects.toMatchObject({ code: "git_read_arguments_invalid" });
      await expect(tool.execute("bad", { action: "show", revision: "--output=unexpected" })).rejects.toMatchObject({ code: "git_read_arguments_invalid" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
