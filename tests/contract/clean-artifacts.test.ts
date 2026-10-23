import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("selective artifact cleanup", () => {
  const script = path.resolve("scripts/clean-artifacts.mjs");
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "joi-clean-contract-"));
    for (const directory of [".cache", "dist", "release-keep"]) await mkdir(path.join(root, directory));
    await writeFile(path.join(root, ".cache", "temporary.txt"), "temporary");
    await writeFile(path.join(root, "dist", "built.js"), "compiled");
    await writeFile(path.join(root, "release-keep", "installer.exe"), "installer");
    await writeFile(path.join(root, "source.ts"), "source");
  });
  afterEach(async () => {
    if (!root.startsWith(path.join(os.tmpdir(), "joi-clean-contract-"))) throw new Error("Unexpected fixture root");
    await rm(root, { recursive: true, force: true });
  });
  it("removes only requested allowlisted artifacts and retains releases and source", async () => {
    execFileSync(process.execPath, [script, "--only", ".cache"], { cwd: root });
    await expect(readFile(path.join(root, ".cache", "temporary.txt"))).rejects.toThrow();
    expect(await readFile(path.join(root, "dist", "built.js"), "utf8")).toBe("compiled");
    expect(await readFile(path.join(root, "release-keep", "installer.exe"), "utf8")).toBe("installer");
    expect(await readFile(path.join(root, "source.ts"), "utf8")).toBe("source");
  });
  it.each([["--only"], ["--only", "../outside"], ["--only", "source.ts"], ["--unknown"]])("rejects invalid arguments before removing anything: %j", async (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root });
    expect(result.status).not.toBe(0);
    expect(await readFile(path.join(root, ".cache", "temporary.txt"), "utf8")).toBe("temporary");
    expect(await readFile(path.join(root, "release-keep", "installer.exe"), "utf8")).toBe("installer");
  });
});
