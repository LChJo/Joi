import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createEditToolDefinition,
  createFindTool,
  createFindToolDefinition,
  createGrepTool,
  createGrepToolDefinition,
  createLsTool,
  createLsToolDefinition,
  createReadTool,
  createReadToolDefinition,
  createWriteTool,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { guardedEditOperations, guardedWriteOperations } from "./pi-filesystem-boundary.js";
import { PI_WEB_ACCESS_TOOL_NAMES, PiWebAccessToolFactory } from "./pi-web-access-tools.js";
import { PI_FINANCIAL_RESEARCH_TOOL_NAMES, PiFinancialResearchToolFactory } from "./pi-financial-research-tools.js";
import { createGitReadTool } from "./pi-git-read-tool.js";

export type PiCodingTool = AgentTool & Pick<ToolDefinition, "promptSnippet" | "promptGuidelines">;

export interface PiCodingToolFactory {
  create(cwd: string, names: string[], options?: { environmentKeys?: readonly string[] }): PiCodingTool[];
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

export const PI_CODING_TOOL_NAMES = ["bash", "edit", "find", "git_read", "grep", "ls", "read", "write"] as const;
export const PI_PARTNER_TOOL_NAMES = [...PI_CODING_TOOL_NAMES, ...PI_WEB_ACCESS_TOOL_NAMES, ...PI_FINANCIAL_RESEARCH_TOOL_NAMES] as const;

// The heterogeneous list retains each concrete schema for Pi's runtime argument validation.
const factories: Record<string, (cwd: string) => PiCodingTool> = {
  edit: cwd => withPromptMetadata(createEditTool(cwd) as AgentTool, createEditToolDefinition(cwd)),
  find: cwd => withPromptMetadata(createFindTool(cwd) as AgentTool, createFindToolDefinition(cwd)),
  grep: cwd => withPromptMetadata(createGrepTool(cwd) as AgentTool, createGrepToolDefinition(cwd)),
  ls: cwd => withPromptMetadata(createLsTool(cwd) as AgentTool, createLsToolDefinition(cwd)),
  read: cwd => withPromptMetadata(createReadTool(cwd) as AgentTool, createReadToolDefinition(cwd)),
  write: cwd => withPromptMetadata(createWriteTool(cwd) as AgentTool, createWriteToolDefinition(cwd)),
};

function withPromptMetadata(tool: AgentTool, definition: Pick<ToolDefinition, "promptSnippet" | "promptGuidelines">): PiCodingTool {
  return { ...tool,
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
    ...(definition.promptGuidelines === undefined ? {} : { promptGuidelines: definition.promptGuidelines }),
  };
}

/**
 * The two tools that write are given operations that refuse a path outside the workspace; the rest
 * read, and reads are not confined (see pi-filesystem-boundary.ts for why enforcement sits here
 * rather than in argument inspection).
 *
 * `bash` is deliberately not on this list, and cannot be: a shell command's writes are whatever it
 * chooses to run, and no argument inspection decides that. It is the honest limit of this
 * boundary — a partner with `bash` can still write outside the workspace — and the prompt says so
 * rather than implying a containment the runtime does not have.
 */
export class BuiltinPiCodingToolFactory implements PiCodingToolFactory {
  readonly names: readonly string[] = PI_PARTNER_TOOL_NAMES;

  constructor(
    private readonly webAccess = new PiWebAccessToolFactory(),
    private readonly financialResearch = new PiFinancialResearchToolFactory(),
  ) {}

  create(cwd: string, names: string[], options?: { environmentKeys?: readonly string[] }): PiCodingTool[] {
    const needsWorkspace = names.some((name) => !(PI_WEB_ACCESS_TOOL_NAMES as readonly string[]).includes(name));
    // Native resolution expands Windows short names to match asynchronous filesystem checks.
    const canonical = needsWorkspace ? realpathSync.native(cwd) : cwd;
    if (needsWorkspace && !statSync(canonical).isDirectory()) throw new Error("partner_workspace_not_directory");
    return [...new Set(names)].map((name): PiCodingTool => {
      if (name === "git_read") return createGitReadTool(canonical, safeEnvironment(process.env, [])) as AgentTool;
      if (name === "bash") return createBashTool(canonical, {
        exposeSessionEnvironment: false,
        spawnHook: (context) => ({
          ...context,
          env: safeEnvironment(context.env, options?.environmentKeys ?? []),
        }),
      }) as AgentTool;
      if (name === "write") return withPromptMetadata(createWriteTool(canonical, { operations: guardedWriteOperations(canonical) }) as AgentTool, createWriteToolDefinition(canonical));
      if (name === "edit") return withPromptMetadata(createEditTool(canonical, { operations: guardedEditOperations(canonical) }) as AgentTool, createEditToolDefinition(canonical));
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
