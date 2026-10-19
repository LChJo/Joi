export type LocalExecutionPhase = "READ_QUEUED" | "READ_RUNNING" | "WRITE_QUEUED" | "WRITE_RUNNING";
export type LocalToolEffect = "READ" | "WRITE" | "DENY";

/** Admission counts exclude the requesting Work; queued writers take precedence over new readers. */
export function decideWorkspaceAdmission(input: { access: "READ" | "WRITE"; otherReaders: number; writerHeld: boolean; earlierWriter: boolean }): boolean {
  return !input.writerHeld && !input.earlierWriter && (input.access === "READ" || input.otherReaders === 0);
}

export function classifyLocalToolEffect(name: string): LocalToolEffect {
  if (["bash", "shell", "edit", "write", "apply_patch", "multiedit", "notebookedit"].includes(name.toLowerCase())) return "WRITE";
  if (["context_read_history", "work_read_evidence", "work_read_result", "read", "find", "grep", "glob", "ls", "webfetch", "websearch", "web_search", "fetch_content", "get_search_content", "ask_user", "financial_calculate", "research_audit"].includes(name.toLowerCase())) return "READ";
  return "DENY";
}
