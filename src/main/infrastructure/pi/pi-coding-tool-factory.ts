import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";

export interface PiCodingToolFactory {
  create(cwd: string, names: string[]): AgentTool[];
  readonly names: readonly string[];
}

const SAFE_ENVIRONMENT_KEYS = new Set([
  "COMSPEC", "LANG", "LC_ALL", "LOCALAPPDATA", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "WINDIR",
]);

function safeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase())));
}

export const PI_CODING_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"] as const;

const factories: Record<string, (cwd: string) => AgentTool> = {
  bash: (cwd) => createBashTool(cwd, {
    exposeSessionEnvironment: false,
    spawnHook: (context) => ({ ...context, env: safeEnvironment(context.env) }),
  }),
  edit: createEditTool,
  find: createFindTool,
  grep: createGrepTool,
  ls: createLsTool,
  read: createReadTool,
  write: createWriteTool,
};

export class BuiltinPiCodingToolFactory implements PiCodingToolFactory {
  readonly names: readonly string[] = PI_CODING_TOOL_NAMES;

  create(cwd: string, names: string[]): AgentTool[] {
    const canonical = realpathSync(cwd);
    if (!statSync(canonical).isDirectory()) throw new Error("partner_workspace_not_directory");
    return [...new Set(names)].map((name) => {
      const factory = factories[name];
      if (factory === undefined) throw new Error("partner_tool_not_allowed");
      return factory(canonical);
    });
  }
}
