import type { AgentConversationDraft } from "../partners/agent-conversation-presentation.js";
import type { OutboxRecord, SseEvent } from "./runtime-store.js";
import type { PartnerRunOutput, PartnerRunStatus } from "./partner-execution.js";
import type { PartnerRunFailure } from "../partners/partner-run-failure.js";

export interface PartnerDispatchClaimRow {
  attemptCount: number;
  dispatchAttemptId: string;
  kind?: "A2A" | "LOCAL_PI";
  outboxId: string;
  payloadJson: string;
}

export interface PartnerDispatchOrphanRow {
  dispatchAttemptId: string;
  instanceStatus: string | null;
  kind: "A2A" | "LOCAL_PI";
  runId: string;
}

/** Per (workbench, partner) view of dispatch work the agent actor may claim or recover. */
export interface PartnerDispatchClaims {
  listClaimable(input: { workbenchId: string; now: string; partnerId: string }): Promise<PartnerDispatchClaimRow[]>;
  listOrphanRuns(input: { workbenchId: string; partnerId: string }): Promise<PartnerDispatchOrphanRow[]>;
}

export interface StagedAttachment {
  filename: string;
  mimeType: string;
  /** Path relative to the Workbench workspace root, e.g. joi-attachments/<id>/<name>. */
  relativePath: string;
  size: number;
}

export interface PreparedDispatch {
  actionId: string;
  attemptCount: number;
  dispatchAttemptId: string;
  instanceId?: string;
  kind: "A2A" | "LOCAL_PI";
  outboxId: string;
  sessionPolicy?: "EPHEMERAL" | "RESIDENT";
  /** Attachments staged into the workspace for file-capable local work. */
  stagedAttachments?: readonly StagedAttachment[];
  /** The Work this run executes; the dispatch actor checks its goal for cancellation. */
  workId: string;
  /** Workspace lease held by this run; the dispatch actor heartbeats it while in flight. */
  workspaceLease?: { expiresAt: string; workId: string; workspaceRef: string };
}

/** Renews the workspace lease held by an in-flight run; null means the lease was lost. */
export interface WorkspaceLeaseRenewal {
  renew(input: { workId: string; workspaceRef: string }): Promise<{ expiresAt: string } | null>;
}

export type DispatchRunOutput =
  | { artifacts: PartnerRunOutput["artifacts"]; body: string; conversation?: AgentConversationDraft[]; failure?: PartnerRunFailure; kind: "terminal"; pendingQuestion?: string; status: PartnerRunStatus }
  | { kind: "waiting_remote" };

/** Stages the attachments bound to a dispatch's source input into the Workbench workspace. */
export interface WorkAttachmentStagerPort {
  stage(input: { inputId: string; workspacePath: string }): Promise<StagedAttachment[]>;
}

/**
 * Split delivery lifecycle so agent actors can ack the outbox before the long
 * engine run and converge the terminal result on later ticks.
 */
export interface PartnerDispatchDelivery {
  /**
   * Ends a dispatch whose preparation kept failing after the bounded retry window:
   * persists a terminal FAILED result so the Work reaches a visible end state instead
   * of retrying forever. The caller acknowledges the outbox afterwards.
   */
  abandon?(input: { claim: PartnerDispatchClaimRow; reasonCode: string }): Promise<void>;
  prepare(claim: PartnerDispatchClaimRow): Promise<PreparedDispatch | "skipped_terminal">;
  run(prepared: PreparedDispatch, options?: { onProgress?: () => void; signal?: AbortSignal }): Promise<DispatchRunOutput>;
  complete(input: { output: DispatchRunOutput & { kind: "terminal" }; prepared: PreparedDispatch }): Promise<{ isAuthoritative: boolean; resultId: string }>;
  finalizeOrphan(orphan: PartnerDispatchOrphanRow): Promise<"completed" | "waiting">;
  /**
   * Records that the process owning an in-flight run is still alive.
   *
   * A run that executes for an hour without a state transition leaves `updated_at` at its
   * dispatch time — the column means "when did this run change state", and nothing else writes
   * it while a partner works. That is how a healthy long-running partner became indistinguishable
   * from a dead one and left a goal stranded on its review gate. An expired heartbeat means the
   * owner is gone; it is NULL until the first beat, and readers keep the old meaning for NULL.
   */
  heartbeatRun?(input: { dispatchAttemptId: string; now: string }): Promise<void>;
  /** Compatibility composition: prepare → run → complete in one await (tests, one-shot callers). */
  handle(record: OutboxRecord): Promise<void>;
  publish?(event: SseEvent): Promise<unknown>;
}
