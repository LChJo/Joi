import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function resolveCargo({ environment = process.env, homeDirectory = os.homedir() } = {}) {
  const executable = process.platform === "win32" ? "cargo.exe" : "cargo";
  const searchPath = Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const candidates = [
    environment.CARGO,
    environment.CARGO_HOME ? path.join(environment.CARGO_HOME, "bin", executable) : undefined,
    path.join(homeDirectory, ".cargo", "bin", executable),
    ...searchPath.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, executable)),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next candidate. */ }
  }
  return undefined;
}
