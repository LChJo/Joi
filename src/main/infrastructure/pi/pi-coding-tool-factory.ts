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
import { PI_WEB_ACCESS_TOOL_NAMES, PiWebAccessToolFactory } from "./pi-web-access-tools.js";
import { PI_FINANCIAL_RESEARCH_TOOL_NAMES, PiFinancialResearchToolFactory } from "./pi-financial-research-tools.js";

export interface PiCodingToolFactory {
  create(cwd: string, names: string[], options?: { environmentKeys?: readonly string[] }): AgentTool[];
  readonly names: readonly string[];
}

const SAFE_ENVIRONMENT_KEYS = new Set([
  "ALLUSERSPROFILE", "APPDATA", "COLORTERM", "COMSPEC", "HOME", "HOMEDRIVE", "HOMEPATH",
  "LANG", "LANGUAGE", "LC_ADDRESS", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_IDENTIFICATION",
  "LC_MEASUREMENT", "LC_MESSAGES", "LC_MONETARY", "LC_NAME", "LC_NUMERIC", "LC_PAPER", "LC_TELEPHONE", "LC_TIME",
  "LOCALAPPDATA", "LOGNAME", "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "PROGRAMW6432", "PUBLIC", "SHELL", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TERM", "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION", "TMP", "TMPDIR", "TZ", "USER", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "USERNAME",
  "USERPROFILE", "WINDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME",
]);

/**
 * Extra environment names partner shell commands may see, configured through
 * JOI_PARTNER_ENV_PASSTHROUGH (comma separated, e.g. "TAVILY_API_KEY"). Everything
 * not listed here or in the safe baseline is stripped from the child environment.
 */
function passthroughEnvironmentKeys(): Set<string> {
  const configured = process.env.JOI_PARTNER_ENV_PASSTHROUGH ?? "";
  return new Set(configured.split(",").map((key) => key.trim().toUpperCase()).filter((key) => key !== ""));
}

function safeEnvironment(environment: NodeJS.ProcessEnv, requestedKeys: readonly string[]): NodeJS.ProcessEnv {
  const passthrough = passthroughEnvironmentKeys();
  const requested = new Set(requestedKeys.map((key) => key.trim().toUpperCase()));
  return Object.fromEntries(Object.entries(environment).filter(([key]) => {
    const upper = key.toUpperCase();
    return SAFE_ENVIRONMENT_KEYS.has(upper) || (passthrough.has(upper) && requested.has(upper));
  }));
}

export const PI_CODING_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"] as const;
export const PI_PARTNER_TOOL_NAMES = [...PI_CODING_TOOL_NAMES, ...PI_WEB_ACCESS_TOOL_NAMES, ...PI_FINANCIAL_RESEARCH_TOOL_NAMES] as const;

const factories: Record<string, (cwd: string) => AgentTool> = {
  edit: createEditTool,
  find: createFindTool,
  grep: createGrepTool,
  ls: createLsTool,
  read: createReadTool,
  write: createWriteTool,
};

/**
 * Tools carry no path sandbox: the workspace scope is prompt governance, not tool
 * enforcement. Partners may leave the workspace when the task requires it and must
 * report every outside write in their final reply (see the engine system prompt).
 */
export class BuiltinPiCodingToolFactory implements PiCodingToolFactory {
  readonly names: readonly string[] = PI_PARTNER_TOOL_NAMES;

  constructor(
    private readonly webAccess = new PiWebAccessToolFactory(),
    private readonly financialResearch = new PiFinancialResearchToolFactory(),
  ) {}

  create(cwd: string, names: string[], options?: { environmentKeys?: readonly string[] }): AgentTool[] {
    const needsWorkspace = names.some((name) => !(PI_WEB_ACCESS_TOOL_NAMES as readonly string[]).includes(name));
    const canonical = needsWorkspace ? realpathSync(cwd) : cwd;
    if (needsWorkspace && !statSync(canonical).isDirectory()) throw new Error("partner_workspace_not_directory");
    return [...new Set(names)].map((name) => {
      if (name === "bash") return createBashTool(canonical, {
        exposeSessionEnvironment: false,
        spawnHook: (context) => ({
          ...context,
          env: safeEnvironment(context.env, options?.environmentKeys ?? []),
        }),
      });
      if ((PI_WEB_ACCESS_TOOL_NAMES as readonly string[]).includes(name)) {
        const [tool] = this.webAccess.create([name]);
        if (tool === undefined) throw new Error("partner_tool_not_allowed");
        return tool;
      }
      if ((PI_FINANCIAL_RESEARCH_TOOL_NAMES as readonly string[]).includes(name)) {
        const [tool] = this.financialResearch.create([name]);
        if (tool === undefined) throw new Error("partner_tool_not_allowed");
        return tool;
      }
      const factory = factories[name];
      if (factory === undefined) throw new Error("partner_tool_not_allowed");
      return factory(canonical);
    });
  }
}
