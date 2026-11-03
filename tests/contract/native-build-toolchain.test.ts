import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveCargo } from "../../scripts/cargo-path.mjs";

describe("native build toolchain discovery", () => {
  let root: string;
  const executable = process.platform === "win32" ? "cargo.exe" : "cargo";

  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "joi-toolchain-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function cargoIn(directory: string) {
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, executable);
    await writeFile(file, "toolchain fixture");
    await chmod(file, 0o755);
    return file;
  }

  it.each(["PATH", "Path"])("finds Cargo outside the home directory using %s", async (key) => {
    const directory = path.join(root, "system tools with spaces");
    const cargo = await cargoIn(directory);
    expect(await resolveCargo({
      environment: { [key]: [path.join(root, "missing"), directory].join(path.delimiter) },
      homeDirectory: path.join(root, "empty-home"),
    })).toBe(cargo);
  });

  it("prefers an explicit Cargo executable", async () => {
    const cargo = await cargoIn(path.join(root, "override"));
    await cargoIn(path.join(root, ".cargo", "bin"));
    expect(await resolveCargo({ environment: { CARGO: cargo }, homeDirectory: root })).toBe(cargo);
  });

  it("uses a custom CARGO_HOME", async () => {
    const cargoHome = path.join(root, "custom-cargo");
    const cargo = await cargoIn(path.join(cargoHome, "bin"));
    expect(await resolveCargo({ environment: { CARGO_HOME: cargoHome }, homeDirectory: root })).toBe(cargo);
  });

  it("retains the default rustup home location", async () => {
    const cargo = await cargoIn(path.join(root, ".cargo", "bin"));
    expect(await resolveCargo({ environment: {}, homeDirectory: root })).toBe(cargo);
  });

  it("reports a missing toolchain without consulting the real home or PATH", async () => {
    expect(await resolveCargo({ environment: {}, homeDirectory: root })).toBeUndefined();
  });
});
