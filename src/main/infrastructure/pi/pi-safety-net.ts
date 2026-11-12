import type { ToolCall } from "@earendil-works/pi-ai";

interface SafetyEnvironment { env: Map<string,string>; }
interface SafetyCore {
  c(): SafetyEnvironment;
  S(name: string): string;
  G(invocation: unknown,options: { environment: SafetyEnvironment }): { decision: { kind: "allow" | "deny" } };
}
const blocked = { block: true as const,reason: "CC Safety Net blocked a destructive command or sensitive file access, or could not verify the operation. Revise the operation; do not bypass the guard." };

/** The pinned Pi guard's evaluator omits its CLI audit writer and raw evidence formatter. */
export async function createPiSafetyNetGuard(cwd: string) {
  // cc-safety-net 2.7.11 exposes file-tool evaluation only through its bundled core.
  const core = await import(new URL("./chunks/index-seh2yy6z.js",import.meta.resolve("cc-safety-net")).href) as SafetyCore;
  if (typeof core.c !== "function" || typeof core.S !== "function" || typeof core.G !== "function") throw new Error("cc_safety_net_incompatible");
  return (toolCall: ToolCall) => {
    try {
      const environment = core.c(),level = environment.env.get("CC_SAFETY_NET_LEVEL");
      if (level?.trim() && !["standard","strict","paranoid"].includes(level.trim().toLowerCase())) return blocked;
      const commandTool = toolCall.name === "bash";
      if (commandTool && (typeof toolCall.arguments.command !== "string" || !toolCall.arguments.command.trim())) return blocked;
      const invocation = { toolName: toolCall.name,input: toolCall.arguments,
        route: commandTool ? { kind: "command",shell: "posix" } : { kind: core.S(toolCall.name) },
        context: { configCwd: cwd,executionCwd: cwd },...(commandTool ? { command: toolCall.arguments.command } : {}) };
      return core.G(invocation,{ environment }).decision.kind === "allow" ? undefined : blocked;
    } catch { return blocked; }
  };
}
