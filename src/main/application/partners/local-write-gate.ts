import { classifyLocalToolEffect } from "../../domain/work/workspace-write-scheduling.js";
import { DomainError } from "../../domain/errors.js";
import type { PartnerRunRequest } from "../ports/partner-execution.js";

/** Once suspension begins, every remaining tool in the batch is blocked. */
export class LocalWriteGate {
  suspended = false;
  constructor(private readonly execution: PartnerRunRequest["workspaceExecution"]) {}
  beforeTool(name: string): { block: true; reason: string } | undefined {
    if (this.execution === undefined) return undefined;
    if (this.suspended) return { block: true, reason: "workspace_write_suspended" };
    const effect = classifyLocalToolEffect(name);
    if (effect === "DENY") return { block: true, reason: "partner_tool_not_allowed" };
    if (effect === "READ") return undefined;
    if (this.execution.accessCeiling !== "WRITE") return { block: true, reason: "workspace_write_forbidden" };
    if (this.execution.phase === "WRITE_RUNNING") return undefined;
    this.suspended = true;
    return { block: true, reason: "workspace_write_required" };
  }
}

export const WORKSPACE_WRITE_CONTINUATION = "Workspace WRITE lease is now held. Re-read and verify all files relevant to the pending change before deciding on fresh edits. Do not replay the blocked tool arguments or stale generated edits. Continue the original task and provide its final deliverable.";

export function isWriteResumeWait(error: unknown): boolean {
  return error instanceof DomainError && ["goal_execution_paused", "goal_requirements_pending", "goal_requirements_stale"].includes(error.code);
}
