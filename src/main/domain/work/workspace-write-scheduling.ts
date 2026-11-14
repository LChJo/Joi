import { PI_AGENT_BROWSER_TOOLS } from "../partners/pi-extension-tools.js";

export type LocalExecutionPhase = "READ_QUEUED" | "READ_RUNNING" | "WRITE_QUEUED" | "WRITE_RUNNING";
export type LocalToolEffect = "READ" | "WRITE" | "DENY";

/** Resource contention alone never authorizes the foreman to cancel queued work. */
export function requiresResourceWaitCancellationIntent(work: { executionPhase?: string | undefined; waitReason?: string | undefined }, reason?: string): boolean {
  const waiting = work.executionPhase === "WRITE_QUEUED" || work.executionPhase === "READ_QUEUED" || work.waitReason !== undefined;
  return waiting && !["USER_REQUEST", "REQUIREMENTS_CHANGED", "SUPERSEDED"].includes(reason ?? "");
}

/** Admission counts exclude the requesting Work; queued writers take precedence over new readers. */
export function decideWorkspaceAdmission(input: { access: "READ" | "WRITE"; otherReaders: number; writerHeld: boolean; earlierWriter: boolean }): boolean {
  return !input.writerHeld && !input.earlierWriter && (input.access === "READ" || input.otherReaders === 0);
}

export function classifyLocalToolEffect(name: string): LocalToolEffect {
  if ((PI_AGENT_BROWSER_TOOLS as readonly string[]).includes(name)) return "WRITE";
  if (["bash", "shell", "edit", "write", "apply_patch", "multiedit", "notebookedit"].includes(name.toLowerCase())) return "WRITE";
  if (["context_read_history", "work_read_evidence", "work_read_result", "read", "find", "git_read", "grep", "glob", "ls", "webfetch", "websearch", "web_search", "fetch_content", "get_search_content", "ask_user", "partner_complete", "financial_calculate", "research_audit", "subagent", "subagent_status", "subagent_cancel"].includes(name.toLowerCase())) return "READ";
  return "DENY";
}
