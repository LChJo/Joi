import type { AgentConversationDraft } from "../partners/agent-conversation-presentation.js";
import type { OutboxRecord, SseEvent } from "./runtime-store.js";
import type { PartnerRunOutput, PartnerRunStatus } from "./partner-execution.js";
import type { PartnerRunFailure } from "../partners/partner-run-failure.js";

export interface PartnerDispatchClaimRow {
  attemptCount: number;
  dispatchAttemptId: string;
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
  prepare(claim: PartnerDispatchClaimRow): Promise<PreparedDispatch | "skipped_terminal">;
  run(prepared: PreparedDispatch, options?: { signal?: AbortSignal }): Promise<DispatchRunOutput>;
  complete(input: { output: DispatchRunOutput & { kind: "terminal" }; prepared: PreparedDispatch }): Promise<{ isAuthoritative: boolean; resultId: string }>;
  finalizeOrphan(orphan: PartnerDispatchOrphanRow): Promise<"completed" | "waiting">;
  /** Compatibility composition: prepare → run → complete in one await (tests, one-shot callers). */
  handle(record: OutboxRecord): Promise<void>;
  publish?(event: SseEvent): Promise<unknown>;
}
