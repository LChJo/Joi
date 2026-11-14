import type { AgentTool } from "@earendil-works/pi-agent-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { DomainError } from "../../domain/errors.js";

const execute = promisify(execFile);
const parameters = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("show")]),
  revision: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  staged: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

/** Fixed Git reads disable index refresh, external diff/textconv, fsmonitor and lazy fetch. */
export function createGitReadTool(cwd: string, environment: NodeJS.ProcessEnv): AgentTool<typeof parameters> {
  return {
    name: "git_read", label: "Inspect Git",
    description: "Read local Git status, diff, recent log or a commit's patch without a shell or a workspace WRITE lease. Use revision for a commit/ref; staged selects the index diff. No mutations or network access. For large output, narrow file contents with read/grep.",
    parameters,
    execute: async (_id, args, signal) => {
      if (!["status", "diff", "log", "show"].includes(args.action)
        || (args.revision !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_./~^@{}-]{0,199}$/u.test(args.revision))
        || (args.staged !== undefined && typeof args.staged !== "boolean")) {
        throw new DomainError("git_read_arguments_invalid", "Choose a supported Git read and a commit or ref.");
      }
      const command = args.action === "status" ? ["status", "--short", "--branch", "--untracked-files=normal"]
        : args.action === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...(args.staged === true ? ["--cached"] : []), ...(args.revision === undefined ? [] : [args.revision]), "--"]
          : args.action === "log" ? ["log", "--no-show-signature", "--format=%h %s", "-n", "30", args.revision ?? "HEAD", "--"]
            : ["show", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--format=short", args.revision ?? "HEAD", "--"];
      try {
        const { stdout } = await execute("git", ["--no-pager", "--no-optional-locks", "--no-lazy-fetch",
          "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "diff.autoRefreshIndex=false", ...command], {
          cwd, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 512_000,
          ...(signal === undefined ? {} : { signal }),
          env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
        });
        const truncated = stdout.length > 120_000;
        return { content: [{ type: "text", text: stdout.slice(0, 120_000) + (truncated ? "\n[Git output truncated]" : "") }], details: { truncated } };
      } catch {
        signal?.throwIfAborted();
        throw new DomainError("git_read_failed", "The local Git read failed or exceeded its time/output limit. Check the repository and revision with the available read tools.");
      }
    },
  };
}
