import type { ConversationPiExtension } from "../../../shared/conversations.js";
import { DomainError } from "../../domain/errors.js";
import { PI_AGENT_BROWSER_TOOLS } from "../../domain/partners/pi-extension-tools.js";
import { createAgentBrowserTools } from "./pi-agent-browser.js";
import { createPiSafetyNetGuard } from "./pi-safety-net.js";

/** Only these pinned, host-wrapped capabilities can join a conversation; ambient discovery stays disabled. */
export async function createConversationPiExtensions(input: { selected: readonly ConversationPiExtension[];allowedTools: readonly string[];cwd?: string }) {
  if (input.cwd === undefined && input.selected.includes("cc-safety-net")) throw new DomainError("pi_extension_workspace_required","CC Safety Net requires a bound workbench workspace.");
  const allowed = new Set(input.allowedTools);
  const browser = input.selected.includes("agent-browser") && PI_AGENT_BROWSER_TOOLS.some(name => allowed.has(name)) ? createAgentBrowserTools(allowed) : undefined;
  const safety = input.selected.includes("cc-safety-net") && input.cwd !== undefined ? await createPiSafetyNetGuard(input.cwd) : undefined;
  return { tools: browser?.tools ?? [],prompt: "",beforeTool: safety,close: async () => { await browser?.close(); } };
}
