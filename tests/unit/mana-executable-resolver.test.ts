import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { resolveLocalCliExecutable } from "../../src/main/infrastructure/mana/local-cli-executable-resolver.js";

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function withPath(dir: string, run: () => void): void {
  withEnvironment({
    CODEX_MANAGED_PACKAGE_ROOT: undefined,
    CODEX_SESSION_ID: undefined,
    CODEX_THREAD_ID: undefined,
    PATH: dir,
  }, run);
}

function withEnvironment(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

function managedCodexBinary(packageRoot: string): string | undefined {
  const targets: Partial<Record<string, readonly [string, string, string]>> = {
    "darwin:arm64": ["codex-darwin-arm64", "aarch64-apple-darwin", "codex"],
    "darwin:x64": ["codex-darwin-x64", "x86_64-apple-darwin", "codex"],
    "linux:arm64": ["codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"],
    "linux:x64": ["codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
    "win32:arm64": ["codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"],
    "win32:x64": ["codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
  };
  const target = targets[`${process.platform}:${process.arch}`];
  if (target === undefined) return undefined;
  const [packageName, triple, binary] = target;
  return join(packageRoot, "node_modules", "@openai", packageName, "vendor", triple, "bin", binary);
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

  it("ignores the host-managed Codex package and uses the user's PATH installation", () => {
    const root = mkdtempSync(join(tmpdir(), "joi-managed-codex-"));
    const pathDir = join(root, "old-path");
    const packageRoot = join(root, "managed", "node_modules", "@openai", "codex");
    const managedBinary = managedCodexBinary(packageRoot);
    if (managedBinary === undefined) return;
    mkdirSync(pathDir, { recursive: true });
    mkdirSync(dirname(managedBinary), { recursive: true });
    writeFileSync(join(pathDir, exe("codex")), "old");
    writeFileSync(managedBinary, "managed");

    withEnvironment({
      CODEX_MANAGED_PACKAGE_ROOT: packageRoot,
      CODEX_SESSION_ID: "nested-session",
      CODEX_THREAD_ID: undefined,
      PATH: pathDir,
    }, () => {
      expect(resolveLocalCliExecutable("codex").executablePath).toBe(join(pathDir, exe("codex")));
    });
  });

  it("skips the app-local node_modules bin before resolving Codex from the user's PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "joi-user-codex-"));
    const appBin = join(root, "app", "node_modules", ".bin");
    const userBin = join(root, "user-bin");
    mkdirSync(appBin, { recursive: true });
    mkdirSync(userBin, { recursive: true });
    writeFileSync(join(appBin, exe("codex")), "bundled");
    writeFileSync(join(userBin, exe("codex")), "user");

    withEnvironment({
      CODEX_MANAGED_PACKAGE_ROOT: undefined,
      CODEX_SESSION_ID: undefined,
      CODEX_THREAD_ID: undefined,
      PATH: [appBin, userBin].join(delimiter),
    }, () => {
      expect(resolveLocalCliExecutable("codex").executablePath).toBe(join(userBin, exe("codex")));
    });
  });
});
