import { classifyLocalToolEffect } from "../../domain/work/workspace-write-scheduling.js";
import { DomainError } from "../../domain/errors.js";
import type { PartnerRunRequest } from "../ports/partner-execution.js";

/** Once suspension begins, every remaining tool in the batch is blocked. */
export class LocalWriteGate {
  suspended = false;
  denied = false;
  constructor(private readonly execution: PartnerRunRequest["workspaceExecution"]) {}
  beforeTool(name: string): { block: true; reason: string } | undefined {
    if (this.execution === undefined) return undefined;
    if (this.suspended) return { block: true, reason: "workspace_write_suspended" };
    const effect = classifyLocalToolEffect(name);
    if (effect === "DENY") return { block: true, reason: "partner_tool_not_allowed" };
    if (effect === "READ") return undefined;
    if (this.execution.accessCeiling !== "WRITE") { this.denied = true; return { block: true, reason: "workspace_write_forbidden" }; }
    if (this.execution.phase === "WRITE_RUNNING") return undefined;
    this.suspended = true;
    return { block: true, reason: "workspace_write_required" };
  }
}

export function workAccessPrompt(execution: PartnerRunRequest["workspaceExecution"], sandboxedShell = false): string {
  if (execution === undefined) return "";
  return `Work access ceiling: ${execution.accessCeiling}. Execution phase: ${execution.phase}. ` + (execution.accessCeiling === "READ"
    ? (sandboxedShell ? "This Work cannot write files; read commands remain available under the configured read-only sandbox. " : "This Work cannot write files or use unrestricted shell tools. ") + "Complete it with available read tools; a missing execution capability is an internal task-contract conflict, not a user permission question."
    : execution.phase === "WRITE_RUNNING" ? "The WRITE lease is held. Re-read relevant files before fresh edits."
      : "Write, edit and shell tools request a WRITE lease before execution. The runtime checkpoints and resumes this Work automatically; do not ask the user or treat this resource wait as failure.");
}

export const WORKSPACE_WRITE_CONTINUATION = "Workspace WRITE lease is now held. Re-read and verify all files relevant to the pending change before deciding on fresh edits. Do not replay the blocked tool arguments or stale generated edits. Continue the original task and provide its final deliverable.";

export function isWriteResumeWait(error: unknown): boolean {
  return error instanceof DomainError && ["goal_execution_paused", "goal_requirements_pending", "goal_requirements_stale"].includes(error.code);
}
