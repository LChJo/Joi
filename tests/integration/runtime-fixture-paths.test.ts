import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

describe("runtime fixture directory identity", () => {
  it("keeps migrated database copies independent with production SQLite settings", async () => {
    const first = await createRuntimeFixture();
    let second: RuntimeFixture | undefined;
    try {
      first.database.transaction((connection) => connection.exec("CREATE TABLE fixture_private (value TEXT)"));
      second = await createRuntimeFixture();
      expect(second.database.inspect()).toEqual(first.database.inspect());
      expect(second.database.inspect()).toMatchObject({ foreignKeys: true, journalMode: "wal", mode: "read-write" });
      expect(second.database.transaction((connection) => connection.prepare(
        "SELECT name FROM sqlite_master WHERE name = 'fixture_private'",
      ).get())).toBeUndefined();
      expect(second.database.transaction((connection) => connection.prepare("PRAGMA synchronous").get()))
        .toEqual(first.database.transaction((connection) => connection.prepare("PRAGMA synchronous").get()));
    } finally {
      await second?.close();
      await first.close();
    }
  });

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
