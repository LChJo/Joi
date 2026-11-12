import { PI_OPENWIKI_READ_TOOLS,PI_OPENWIKI_WRITE_TOOLS,PI_AGENT_BROWSER_TOOLS } from "../partners/pi-extension-tools.js";

export type LocalExecutionPhase = "READ_QUEUED" | "READ_RUNNING" | "WRITE_QUEUED" | "WRITE_RUNNING";
export type LocalToolEffect = "READ" | "WRITE" | "DENY";

/** Admission counts exclude the requesting Work; queued writers take precedence over new readers. */
export function decideWorkspaceAdmission(input: { access: "READ" | "WRITE"; otherReaders: number; writerHeld: boolean; earlierWriter: boolean }): boolean {
  return !input.writerHeld && !input.earlierWriter && (input.access === "READ" || input.otherReaders === 0);
}

export function classifyLocalToolEffect(name: string): LocalToolEffect {
  if (([...PI_OPENWIKI_WRITE_TOOLS,...PI_AGENT_BROWSER_TOOLS] as readonly string[]).includes(name)) return "WRITE";
  if ((PI_OPENWIKI_READ_TOOLS as readonly string[]).includes(name)) return "READ";
  if (["bash", "shell", "edit", "write", "apply_patch", "multiedit", "notebookedit"].includes(name.toLowerCase())) return "WRITE";
  if (["context_read_history", "work_read_evidence", "work_read_result", "read", "find", "grep", "glob", "ls", "webfetch", "websearch", "web_search", "fetch_content", "get_search_content", "ask_user", "partner_complete", "financial_calculate", "research_audit", "subagent", "subagent_status", "subagent_cancel"].includes(name.toLowerCase())) return "READ";
  return "DENY";
}
