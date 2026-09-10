import type { WorkAccessMode } from "../../domain/work/work.js";

/**
 * Dispatch policy decision rules live in the application layer.
 * Infrastructure adapters only collect facts and report denials; they never
 * redefine which dispatches are allowed (see AGENTS.md required boundaries).
 */
export const DISPATCH_POLICY_REASONS = {
  a2aWorkspaceAccessForbidden: "a2a_workspace_access_forbidden",
  workbenchWorkspaceNotReady: "workbench_workspace_not_ready",
  workspaceLeaseConflict: "workspace_lease_conflict",
} as const;

export type DispatchPolicyReason = typeof DISPATCH_POLICY_REASONS[keyof typeof DISPATCH_POLICY_REASONS];

export interface DispatchPolicyFacts {
  /** A non-conflicting lease check requires the current time and workspace ref; adapters report the outcome. */
  leaseConflict: boolean;
  /** Canonical stored partner kind, e.g. LOCAL_PI or A2A. */
  partnerKind: string;
  /** Opaque workspace binding ref; undefined when the workbench has none. */
  workspaceRef?: string;
  /** Managed directories are provisioned idempotently by dispatch before execution. */
  workspaceKind?: "BOUND" | "MANAGED";
  /** Workspace binding status; undefined when no binding row exists. */
  workspaceStatus?: string;
}

export interface DispatchPolicyDecision {
  allowed: boolean;
  reason?: DispatchPolicyReason;
}

/**
 * Decides whether a Work item may be dispatched to a partner.
 * Precedence is fixed: NONE always passes, A2A never touches workspace files,
 * file work needs a READY binding, and a conflicting lease denies last.
 */
export function evaluateDispatchPolicy(accessMode: WorkAccessMode, facts: DispatchPolicyFacts): DispatchPolicyDecision {
  if (accessMode === "NONE") return { allowed: true };
  if (facts.partnerKind === "A2A") return { allowed: false, reason: DISPATCH_POLICY_REASONS.a2aWorkspaceAccessForbidden };
  if (facts.workspaceKind === "MANAGED" && typeof facts.workspaceRef === "string") {
    return facts.leaseConflict ? { allowed: false, reason: DISPATCH_POLICY_REASONS.workspaceLeaseConflict } : { allowed: true };
  }
  if (facts.workspaceStatus !== "READY" || typeof facts.workspaceRef !== "string") {
    return { allowed: false, reason: DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady };
  }
  return facts.leaseConflict
    ? { allowed: false, reason: DISPATCH_POLICY_REASONS.workspaceLeaseConflict }
    : { allowed: true };
}
