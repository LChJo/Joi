import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";

/**
 * Resolves the user's locally installed Claude Code / Codex CLI that the Agent
 * SDK spawns. Ported from ai_mana_front_debug's resolve-executable so a partner
 * runs on the user's own login / forwarding / subscription config. No bundled
 * binary fallback: if the CLI is absent the engine reports unavailable.
 */
export type LocalCliProtocol = "claude" | "codex";

export interface ResolvedLocalCliExecutable {
  commandName: string;
  executablePath?: string;
  protocol: LocalCliProtocol;
}

function executableCandidates(commandName: string): string[] {
  if (process.platform !== "win32") return [commandName];
  if (/\.[a-z0-9]+$/iu.test(commandName)) return [commandName];
  const pathext = process.env.PATHEXT?.split(";").filter(Boolean) ?? [".COM", ".EXE", ".BAT", ".CMD"];
  return pathext.map((ext) => `${commandName}${ext.toLowerCase()}`);
}

function resolvePathExecutable(commandNames: string[]): string | undefined {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    for (const commandName of commandNames) {
      for (const candidateName of executableCandidates(commandName)) {
        const candidate = join(dir, candidateName);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

interface CodexNativeTarget {
  binary: string;
  packageName: string;
  triple: string;
}

function getCodexNativeTarget(): CodexNativeTarget | undefined {
  if (process.platform === "win32" && process.arch === "x64") {
    return { binary: "codex.exe", packageName: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return { binary: "codex.exe", packageName: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" };
  }
  return undefined;
}

/** Native conversations need the real Codex binary, not an npm cmd/bat shim. */
function resolveNativeCodexExecutable(executablePath: string): string | undefined {
  if (process.platform !== "win32") return executablePath;
  const extension = extname(executablePath).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat" && extension !== ".ps1" && extension !== ".js") return executablePath;
  const target = getCodexNativeTarget();
  if (target === undefined) return undefined;
  const shimDir = dirname(executablePath);
  const packageRoots = [join(shimDir, "node_modules", "@openai", "codex"), join(shimDir, "..", "@openai", "codex")];
  for (const packageRoot of packageRoots) {
    const nativeRoots = [
      join(dirname(packageRoot), target.packageName, "vendor", target.triple),
      join(packageRoot, "node_modules", "@openai", target.packageName, "vendor", target.triple),
    ];
    for (const nativeRoot of nativeRoots) {
      const modern = join(nativeRoot, "bin", target.binary);
      if (existsSync(modern)) return modern;
      const legacy = join(nativeRoot, "codex", target.binary);
      if (existsSync(legacy)) return legacy;
    }
  }
  return undefined;
}

function resolveCodexDesktopExecutable(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const candidates = ["/Applications/Codex.app/Contents/Resources/codex", join(homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex")];
  return candidates.find((candidate) => existsSync(candidate));
}

export function resolveLocalCliExecutable(protocol: LocalCliProtocol): ResolvedLocalCliExecutable {
  if (protocol === "codex") {
    const pathExecutable = resolvePathExecutable(["codex"]);
    const executablePath = pathExecutable === undefined ? resolveCodexDesktopExecutable() : (resolveNativeCodexExecutable(pathExecutable) ?? pathExecutable);
    return {
      commandName: process.platform === "win32" ? "codex.cmd" : "codex",
      ...(executablePath === undefined ? {} : { executablePath }),
      protocol,
    };
  }
  const executablePath = resolvePathExecutable(["claude"]);
  return {
    commandName: process.platform === "win32" ? "claude.exe" : "claude",
    ...(executablePath === undefined ? {} : { executablePath }),
    protocol,
  };
}
