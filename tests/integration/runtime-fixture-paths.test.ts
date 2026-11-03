import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

describe("runtime fixture directory identity", () => {
  it("resolves temporary directory aliases before exposing workspace roots", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "joi-fixture-identity-"));
    const physical = path.join(parent, "physical");
    const alias = path.join(parent, "alias");
    await mkdir(physical);
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
    const temporaryDirectory = vi.spyOn(os, "tmpdir").mockReturnValue(alias);
    let fixture: RuntimeFixture | undefined;
    try {
      fixture = await createRuntimeFixture();
      expect(fixture.root).toBe(await realpath(fixture.root));
      expect(path.dirname(fixture.root)).toBe(await realpath(physical));
    } finally {
      temporaryDirectory.mockRestore();
      await fixture?.close();
      await rm(parent, { force: true, recursive: true });
    }
  });
});
