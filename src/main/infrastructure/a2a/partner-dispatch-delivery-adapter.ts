/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import { isWriteResumeWait } from "../../application/partners/local-write-gate.js";
import { assertGoalRequirementsReady, loadGoalRequirements } from "../persistence/sqlite-goal-requirements-repository.js";
import { renderGoalRequirements, type GoalRequirement } from "../../domain/work/goal-requirements.js";

import type { A2aGatewayService } from "../../application/a2a/a2a-gateway-service.js";
import type { PartnerInstanceManager } from "../../application/partners/partner-instance-manager.js";
import { normalizeAgentConversationEntries, type AgentConversationDraft } from "../../application/partners/agent-conversation-presentation.js";
import { classifyPartnerRunFailure, partnerRunArtifactsFromError, partnerRunFailureFromError, safePartnerRunFailureBody, type PartnerRunFailure } from "../../application/partners/partner-run-failure.js";
import {
  DISPATCH_POLICY_REASONS,
  evaluateDispatchPolicy,
  type DispatchPolicyDecision,
} from "../../application/work/dispatch-policy.js";
import type { WorkbenchAgentRepository } from "../../application/ports/workbench-agents.js";
import type { InvocationStatus } from "../../application/ports/a2a-ports.js";
import type { JoiCoordinatorStore } from "../../application/ports/joi-coordinator.js";
import type { PartnerRunOutput, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import { parseWorkHandoff, WORK_HANDOFF_INSTRUCTION } from "../../domain/work/work-handoff.js";
import type {
  DispatchRunOutput,
  PartnerDispatchClaimRow,
  PartnerDispatchClaims,
  PartnerDispatchDelivery,
  PartnerDispatchOrphanRow,
  PreparedDispatch,
  StagedAttachment,
  WorkAttachmentStagerPort,
} from "../../application/ports/partner-dispatch-delivery.js";
import type { PartnerRegistryRepository } from "../../application/ports/partner-registry.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";
import type { Clock, OutboxRecord, SseEvent } from "../../application/ports/runtime-store.js";
import type { WorkbenchContextAssembler } from "../../application/joi/workbench-context-assembler.js";
import type { WorkbenchExecutionContextReader } from "../../application/ports/workbench-context.js";
import type { WorkResultRepository } from "../../application/ports/work-results.js";
import type { WorkAcceptanceCheck } from "../../application/ports/work-orchestration.js";
import type { WorkVerifier } from "../../application/ports/work-verification.js";
import { DomainError } from "../../domain/errors.js";
import { validWorkInstructions } from "../../application/work/work-instructions.js";
import { assertExecutionAccess, localExecutionCapabilities, readExecutionNeeds } from "../../domain/work/work-execution-needs.js";
import { createWorkResult } from "../../domain/work/work-result.js";
import type { WorkAccessMode } from "../../domain/work/work.js";
import type { SqliteWorkspaceLeaseManager } from "../persistence/sqlite-workspace-lease-manager.js";
import { selfContainedEvidenceContext, stageWorkEvidence } from "../workspace/work-evidence-stager.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

/**
 * Live conversation snapshots are display-only; the authoritative conversation is rewritten
 * once by #complete. Writing on every streaming chunk deletes and re-inserts the whole run,
 * an O(N²) amplification on the main-process synchronous database, so the live writes are
 * throttled to at most one per interval.
 */
const LIVE_CONVERSATION_SNAPSHOT_INTERVAL_MS = 500;

interface DispatchRow {
  scheduling_version: number;
  required_context?: string;
  access_mode: WorkAccessMode;
  action_id: string;
  agent_connection_id: string | null;
  workbench_id: string;
  context_snapshot_id: string | null;
  dispatch_attempt_id: string;
  instance_id: string | null;
  input_id: string;
  intent_json: string;
  invocation_id: string | null;
  kind: "A2A" | "LOCAL_PI";
  partner_display_name: string;
  partner_id: string;
  partner_revision_id: string;
  run_id: string | null;
  run_status: PartnerRunStatus | "RUNNING" | null;
  status: string;
  title: string;
  source_request: string;
  work_id: string;
  workspace_ref: string | null;
  workspace_status: string | null;
  work_status: string;
}

function isValidAcceptanceCheck(value: unknown): value is WorkAcceptanceCheck {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "BODY_PRESENT") return true;
  if (candidate.kind === "ARTIFACT_PRESENT") return typeof candidate.name === "string";
  if (candidate.kind === "FILE_EXISTS") return typeof candidate.relativePath === "string";
  return candidate.kind === "FILE_CONTAINS_EXACT"
    && typeof candidate.relativePath === "string" && typeof candidate.expectedText === "string";
}

/** Rejects unreadable briefs and invalid or unsupported versioned instruction contracts. */
function intentJsonCorrupt(intentJson: string): boolean {
  try {
    const parsed = JSON.parse(intentJson) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return true;
    const brief = parsed as Record<string, unknown>;
    return brief.briefVersion !== undefined && (![2, 3].includes(brief.briefVersion as number) || !validWorkInstructions(brief.instructions));
  } catch {
    return true;
  }
}

function workBrief(intentJson: string): { acceptanceChecks: WorkAcceptanceCheck[]; droppedChecks: number; instructions?: string; legacy: boolean } {
  try {
    const parsed = JSON.parse(intentJson) as { acceptanceChecks?: unknown; briefVersion?: unknown; instructions?: unknown };
    const candidates = Array.isArray(parsed.acceptanceChecks) ? parsed.acceptanceChecks : [];
    const acceptanceChecks = candidates.filter(isValidAcceptanceCheck);
    return {
      acceptanceChecks,
      droppedChecks: candidates.length - acceptanceChecks.length,
      legacy: parsed.briefVersion === undefined,
      ...(validWorkInstructions(parsed.instructions) ? { instructions: parsed.instructions } : {}),
    };
  } catch {
    return { acceptanceChecks: [], droppedChecks: 0, legacy: false };
  }
}

function taskProjection(row: DispatchRow, stagedAttachments?: readonly StagedAttachment[]): string {
  const brief = workBrief(row.intent_json);
  const checks = brief.acceptanceChecks.map((check) => {
    if (check.kind === "BODY_PRESENT") return "BODY_PRESENT";
    if (check.kind === "ARTIFACT_PRESENT") return `ARTIFACT_PRESENT ${check.name} (create a file with this exact filename in the assigned workspace)`;
    if (check.kind === "FILE_EXISTS") return `FILE_EXISTS ${check.relativePath}`;
    return `FILE_CONTAINS_EXACT ${check.relativePath} = ${check.expectedText}`;
  });
  const stagedLines = (stagedAttachments ?? []).map((staged) => `- ${staged.readPath ?? staged.relativePath} (${staged.mimeType}, ${String(staged.size)} bytes)`);
  return [
    `Work title: ${row.title}`,
    ...(row.required_context === undefined ? [] : [row.required_context]),
    brief.instructions !== undefined ? `Task instructions:\n${brief.instructions}`
      : brief.legacy ? `Original user request (authoritative):\n${row.source_request}` : "Task instructions unavailable.",
    ...(stagedLines.length === 0 ? [] : [`Attachments from the user's original input are staged in ${(stagedAttachments ?? []).some(item => item.readPath !== undefined) ? "this task's independent input directory" : "this workspace"} (read them via these paths; treat them as read-only inputs):\n${stagedLines.join("\n")}`]),
    ...(checks.length === 0 ? [] : [`Acceptance checks:\n${checks.join("\n")}`]),
  ].join("\n\n");
}

function attemptTerminal(status: string): boolean {
  return ["COMPLETED", "FAILED", "WAITING_INPUT", "WAITING_AUTH", "UNKNOWN"].includes(status);
}

function deliveryPolicy(row: DispatchRow, leaseConflict = false): DispatchPolicyDecision {
  return evaluateDispatchPolicy(row.access_mode, {
    leaseConflict,
    partnerKind: row.kind,
    ...(row.workspace_ref === null ? {} : { workspaceRef: row.workspace_ref }),
    ...(row.workspace_status === null ? {} : { workspaceStatus: row.workspace_status }),
  });
}

function denialReason(decision: DispatchPolicyDecision): string {
  if (decision.allowed || decision.reason === undefined) throw new Error("dispatch_policy_denial_reason_missing");
  return decision.reason;
}

function terminalInvocation(status: InvocationStatus): PartnerRunStatus | null {
  switch (status) {
    case "COMPLETED": return "COMPLETED";
    case "INPUT_REQUIRED": return "WAITING_INPUT";
    case "AUTH_REQUIRED": return "WAITING_AUTH";
    case "CANCELED":
    case "FAILED": return "FAILED";
    case "UNKNOWN_REQUIRES_REVIEW": return "UNKNOWN";
    default: return null;
  }
}

/** Traversal sources for agent actors: claimable dispatch outbox rows and orphaned runs. */
export class SqlitePartnerDispatchClaims implements PartnerDispatchClaims {
  constructor(private readonly database: TransactionalDatabase) {}

  async listClaimable(input: { workbenchId: string; now: string; partnerId: string }): Promise<PartnerDispatchClaimRow[]> {
    const initial = (this.database.transaction((connection) => connection.prepare(`
      WITH due AS MATERIALIZED (
        SELECT outbox_id, attempt_count, created_at FROM outbox
         WHERE kind = 'partner.dispatch' AND available_at <= ?
           AND (status = 'PENDING' OR (status = 'CLAIMED' AND claim_until <= ?))
      ), eligible AS MATERIALIZED (
      SELECT o.outbox_id, o.attempt_count, o.created_at, a.dispatch_attempt_id, p.kind
        FROM due o
        CROSS JOIN dispatch_attempts a ON a.outbox_id = o.outbox_id
        CROSS JOIN work_items w ON w.work_id = a.work_id
        JOIN partner_revisions rev ON rev.partner_revision_id = a.partner_revision_id
        JOIN partners p ON p.partner_id = rev.partner_id
        JOIN joi_inbox_messages i ON i.input_id = w.input_id
        LEFT JOIN joi_goal_execution_gates gate ON gate.goal_input_id = COALESCE(i.goal_input_id, i.input_id)
       WHERE w.workbench_id = ? AND rev.partner_id = ?
         AND ((w.status IN ('PLANNED', 'READY') AND (gate.status IS NULL OR gate.status = 'OPEN'))
           -- A crash between persisted start and outbox ACK only needs re-ACK, never
           -- another execution. prepare skips existing runs; orphan recovery owns them.
           OR (w.status IN ('PLANNED','READY','RUNNING','CANCELED') AND EXISTS (
             SELECT 1 FROM partner_runs started WHERE started.dispatch_attempt_id = a.dispatch_attempt_id AND started.status = 'RUNNING')))
         -- Dependency gate: a Work is only claimable once every declared predecessor
         -- has completed. In-flight predecessors keep it waiting; FAILED/CANCELED
         -- predecessors cancel it through the cascade instead of stranding it here.
         AND NOT EXISTS (
           SELECT 1 FROM work_dependencies d
           JOIN work_items dep ON dep.work_id = d.depends_on_work_id
           WHERE d.work_id = w.work_id AND dep.status <> 'COMPLETED'
         )
       ORDER BY o.created_at ASC, o.outbox_id ASC LIMIT 10
      ) SELECT e.outbox_id, o.payload_json, e.attempt_count, e.dispatch_attempt_id, e.kind
          FROM eligible e JOIN outbox o ON o.outbox_id = e.outbox_id
         ORDER BY e.created_at, e.outbox_id`)
      .all(input.now, input.now, input.workbenchId, input.partnerId)) as Record<string, unknown>[])
      .map((row) => ({
        attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : 0,
        dispatchAttemptId: String(row.dispatch_attempt_id),
        kind: row.kind === "A2A" ? "A2A" as const : "LOCAL_PI" as const,
        outboxId: String(row.outbox_id),
        payloadJson: String(row.payload_json),
      }));
    const continued = this.database.transaction(connection => connection.prepare(`SELECT o.outbox_id, o.payload_json, o.attempt_count,
        a.dispatch_attempt_id, json_extract(o.payload_json, '$.generation') AS continuation_generation
      FROM outbox o JOIN dispatch_attempts a ON a.dispatch_attempt_id = json_extract(o.payload_json, '$.dispatchAttemptId')
      JOIN work_items w ON w.work_id = a.work_id JOIN partner_revisions rev ON rev.partner_revision_id = a.partner_revision_id
      JOIN local_work_execution e ON e.dispatch_attempt_id = a.dispatch_attempt_id
      WHERE o.kind = 'partner.continue' AND w.workbench_id = ? AND rev.partner_id = ?
        AND o.available_at <= ? AND (o.status = 'PENDING' OR (o.status = 'CLAIMED' AND o.claim_until <= ?))
      ORDER BY o.created_at, o.outbox_id LIMIT 10`).all(input.workbenchId, input.partnerId, input.now, input.now));
    return [...continued.map(row => ({ attemptCount: Number(row.attempt_count), continuationGeneration: Number(row.continuation_generation),
      dispatchAttemptId: String(row.dispatch_attempt_id), kind: "LOCAL_PI" as const, outboxId: String(row.outbox_id), payloadJson: String(row.payload_json) })), ...initial];
  }

  async listOrphanRuns(input: { workbenchId: string; partnerId: string }): Promise<PartnerDispatchOrphanRow[]> {
    return (this.database.transaction((connection) => connection.prepare(`
      SELECT pr.run_id, pr.kind, a.dispatch_attempt_id, i.status AS instance_status
        FROM partner_runs pr
        JOIN dispatch_attempts a ON a.dispatch_attempt_id = pr.dispatch_attempt_id
        JOIN outbox o ON o.outbox_id = a.outbox_id AND o.status = 'DONE'
        JOIN work_items w ON w.work_id = a.work_id
        JOIN partner_revisions rev ON rev.partner_revision_id = pr.partner_revision_id
        LEFT JOIN partner_instances i ON i.instance_id = a.instance_id
       WHERE pr.status = 'RUNNING' AND w.workbench_id = ? AND rev.partner_id = ?
         AND NOT EXISTS (SELECT 1 FROM local_work_execution e WHERE e.dispatch_attempt_id = a.dispatch_attempt_id AND e.phase = 'WRITE_QUEUED')
       ORDER BY pr.updated_at, pr.run_id LIMIT 20`)
      .all(input.workbenchId, input.partnerId)) as Record<string, unknown>[])
      .map((row) => ({
        dispatchAttemptId: String(row.dispatch_attempt_id),
        instanceStatus: typeof row.instance_status === "string" ? row.instance_status : null,
        kind: row.kind === "A2A" ? "A2A" as const : "LOCAL_PI" as const,
        runId: String(row.run_id),
      }));
  }
}

export class SqlitePartnerDispatchDelivery implements PartnerDispatchDelivery {
  constructor(private readonly dependencies: {
    agentConversations?: Pick<WorkbenchAgentRepository, "append" | "appendToolTrace" | "replaceRun">;
    /** Stages source attachments into private task input storage. */
    attachmentStager?: Pick<WorkAttachmentStagerPort, "stage">;
    evidenceDirectory?: string;
    clock: Clock;
    /** Raises a user question card when a local partner pauses with WAITING_INPUT. */
    clarifications?: Pick<JoiCoordinatorStore, "requireClarification">;
    contextAssembler: Pick<WorkbenchContextAssembler, "assemble">;
    contexts: WorkbenchExecutionContextReader;
    database: TransactionalDatabase;
    diagnostics?: RuntimeDiagnostics;
    gateway: Pick<A2aGatewayService, "recover" | "startWithResult">;
    instances: Pick<PartnerInstanceManager, "dispatch"> & Partial<Pick<PartnerInstanceManager, "validateCheckpoint">>;
    leases: Pick<SqliteWorkspaceLeaseManager, "acquire" | "release"> & Partial<Pick<SqliteWorkspaceLeaseManager, "requestWrite" | "cancelWait">>;
    partners: Pick<PartnerRegistryRepository, "getRevision">;
    publish?: (event: SseEvent) => Promise<unknown>;
    results: WorkResultRepository;
    runDirectories?: { ensureForWork(input: { workbenchId: string; workId: string }): Promise<void> };
    verifier?: WorkVerifier;
  }) {}

  async queued(claim: PartnerDispatchClaimRow, reason: "CAPACITY" | "WORKSPACE_READ" | "WORKSPACE_WRITE"): Promise<void> {
    const row = this.#load(claim.dispatchAttemptId);
    if (row?.kind !== "LOCAL_PI" || row.scheduling_version !== 2 || attemptTerminal(row.status)) return;
    this.dependencies.database.transaction(db => db.prepare(`INSERT INTO local_work_execution
      (dispatch_attempt_id, phase, generation, wait_reason, updated_at) VALUES (?, 'READ_QUEUED', 1, ?, ?)
      ON CONFLICT(dispatch_attempt_id) DO UPDATE SET
        updated_at = CASE WHEN wait_reason = excluded.wait_reason THEN updated_at ELSE excluded.updated_at END,
        wait_reason = excluded.wait_reason WHERE phase IN ('READ_QUEUED','WRITE_QUEUED')`)
      .run(claim.dispatchAttemptId, reason, this.dependencies.clock.now().toISOString()));
  }

  async prepare(claim: PartnerDispatchClaimRow): Promise<PreparedDispatch | "skipped_terminal"> {
    let row = this.#load(claim.dispatchAttemptId);
    if (row === undefined) throw new Error("partner_dispatch_attempt_invalid");
    if (claim.continuationGeneration !== undefined) return this.#prepareContinuation(row, claim);
    if (attemptTerminal(row.status) || ["COMPLETED", "FAILED", "CANCELED"].includes(row.work_status)) return "skipped_terminal";
    // A persisted start is owned by its live slot or the orphan recovery path.
    // Redelivery must never start it again or finalize a still-live preparation.
    if (row.run_id !== null) return "skipped_terminal";
    const initialRow = row;
    this.dependencies.database.transaction(db => this.#assertRequirements(db, initialRow));
    if (!this.#goalExecutionOpen(row.work_id)) {
      throw new DomainError("goal_execution_paused", "The goal is waiting for Joi to review a user answer.");
    }
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.dispatch.started", {
      actionId: row.action_id,
      workbenchId: row.workbench_id,
      dispatchAttemptId: row.dispatch_attempt_id,
      kind: row.kind,
      outboxId: claim.outboxId,
      partnerId: row.partner_id,
      partnerRevisionId: row.partner_revision_id,
      workId: row.work_id,
    });

    if (row.kind === "LOCAL_PI" && this.dependencies.runDirectories !== undefined) {
      if (row.access_mode === "NONE") throw new DomainError("work_execution_access_required", "Local Work requires a working directory. Resume or reassign it to refresh its access policy.");
      await this.dependencies.runDirectories.ensureForWork({ workbenchId: row.workbench_id, workId: row.work_id });
      row = this.#load(claim.dispatchAttemptId) ?? row;
    }
    const policy = deliveryPolicy(row);
    if (!policy.allowed) {
      const reason = denialReason(policy);
      if (reason === DISPATCH_POLICY_REASONS.a2aWorkspaceAccessForbidden) {
        if (!await this.#ensureRun(row)) return "skipped_terminal";
        row = this.#load(claim.dispatchAttemptId) ?? row;
        await this.#complete(row, "FAILED", { artifacts: [], body: "Remote partners cannot execute Workbench file work." });
        return "skipped_terminal";
      }
      throw new DomainError(reason, "The dispatch policy denied this Work at delivery time.");
    }

    // Versioned briefs require valid independent instructions before a partner can start.
    // An unreadable brief cannot carry an enforceable acceptance contract.
    if (intentJsonCorrupt(row.intent_json)) {
      if (!await this.#ensureRun(row)) return "skipped_terminal";
      row = this.#load(claim.dispatchAttemptId) ?? row;
      await this.#complete(row, "FAILED", {
        artifacts: [],
        body: "The Work brief is corrupted or lacks valid instructions, so its contract cannot be executed.",
        failure: { phase: "CONFIGURATION", reasonCode: "work_brief_invalid", retryable: false, sideEffectState: "NONE" },
      });
      return "skipped_terminal";
    }

    let leaseExpiresAt: string | undefined;
    let leaseWorkId: string | undefined;
    let leaseGeneration: number | undefined;
    const scheduled = row.kind === "LOCAL_PI" && row.scheduling_version === 2 && row.access_mode !== "NONE";
    if (scheduled) this.dependencies.database.transaction(db => db.prepare(`INSERT OR IGNORE INTO local_work_execution
      (dispatch_attempt_id, phase, generation, wait_reason, updated_at) VALUES (?, 'READ_QUEUED', 1, 'WORKSPACE_READ', ?)`)
      .run(claim.dispatchAttemptId, this.dependencies.clock.now().toISOString()));
    if (row.access_mode !== "NONE") {
      if (row.workspace_ref === null) throw new Error("dispatch_policy_workspace_ref_missing");
      const lease = await this.dependencies.leases.acquire({
        accessMode: scheduled ? "READ" : row.access_mode,
        workId: row.work_id,
        workspaceRef: row.workspace_ref,
      });
      if (lease === null) {
        if (scheduled) await this.queued(claim, "WORKSPACE_READ");
        throw new DomainError(denialReason(deliveryPolicy(row, true)), "The workspace lease could not be acquired.");
      }
      leaseExpiresAt = lease.expiresAt;
      leaseGeneration = lease.generation;
      leaseWorkId = row.work_id;
      if (scheduled) this.#workspaceQueueFinished(row, "READ", this.#executionState(row.dispatch_attempt_id));
    }

    // Every failure after the lease was granted must release it; otherwise the row
    // blocks the workspace until its TTL expires. The #complete branches below release
    // on their own, so only thrown errors need the catch.
    try {
      // Private input staging keeps preparation from modifying the shared directory.
      let stagedAttachments: readonly StagedAttachment[] | undefined;
      if (row.access_mode !== "NONE" && row.kind === "LOCAL_PI" && row.workspace_ref !== null && this.dependencies.attachmentStager !== undefined) {
        const workspaceRef = row.workspace_ref;
        const workId = row.work_id;
        const inputId = row.input_id;
        const roots = this.dependencies.database.transaction((connection) => connection.prepare(
          `SELECT root_path FROM work_run_directories WHERE work_id = ? AND status = 'READY'
           UNION ALL SELECT root_path FROM workbench_workspace_roots WHERE workspace_ref = ? LIMIT 1`,
        ).get(workId, workspaceRef)) as { root_path?: unknown } | undefined;
        if (typeof roots?.root_path === "string") {
          const staged = await this.dependencies.attachmentStager.stage({ inputId, workspacePath: roots.root_path, ...(scheduled ? { workId } : {}) });
          if (staged.length > 0) stagedAttachments = staged;
        }
      }

      if (!await this.#ensureRun(row, claim.payloadJson)) {
        if (leaseWorkId !== undefined) await this.dependencies.leases.release(leaseWorkId);
        return "skipped_terminal";
      }
      if (scheduled) this.dependencies.database.transaction(db => db.prepare(`UPDATE local_work_execution
        SET phase = 'READ_RUNNING', wait_reason = NULL, staged_attachments_json = ?, updated_at = ? WHERE dispatch_attempt_id = ?`)
        .run(JSON.stringify(stagedAttachments ?? []), this.dependencies.clock.now().toISOString(), claim.dispatchAttemptId));
      row = this.#load(claim.dispatchAttemptId);
      if (row?.run_id === undefined || row.run_id === null) throw new Error("partner_run_create_failed");
      const revision = await this.dependencies.partners.getRevision(row.partner_revision_id);
      if (revision === null) {
        await this.#complete(row, "FAILED", { artifacts: [], body: "The pinned partner revision is unavailable." });
        return "skipped_terminal";
      }
      if (row.context_snapshot_id === null) throw new Error("workbench_context_snapshot_not_found");
      if (row.kind === "LOCAL_PI" && ["claude-code", "codex"].includes(revision.engine)) {
        const execution = await this.dependencies.contexts.loadForExecution(row.context_snapshot_id);
        if (execution?.evidence !== undefined && execution.workspacePath !== undefined) {
          try {
            await stageWorkEvidence({ contextSnapshotId: row.context_snapshot_id, evidence: execution.evidence,
              ...(this.dependencies.evidenceDirectory === undefined ? {} : { taskDirectory: this.dependencies.evidenceDirectory }),
            });
          } catch { /* The runtime retains inline evidence and records a delivery fallback if staging remains unavailable. */ }
        }
      }

      let instanceId: string | undefined;
      let sessionPolicy: "EPHEMERAL" | "RESIDENT" | undefined;
      try {
        const payload = JSON.parse(claim.payloadJson) as Record<string, unknown>;
        if (typeof payload.instanceId === "string") instanceId = payload.instanceId;
        if (payload.sessionPolicy === "EPHEMERAL" || payload.sessionPolicy === "RESIDENT") sessionPolicy = payload.sessionPolicy;
      } catch {
        // Malformed payloads dispatch as one-shot ephemeral work.
      }
      return {
        actionId: row.action_id,
        attemptCount: claim.attemptCount,
        dispatchAttemptId: row.dispatch_attempt_id,
        ...(scheduled ? { executionGeneration: 1 } : {}),
        ...(instanceId === undefined ? {} : { instanceId }),
        kind: row.kind,
        outboxId: claim.outboxId,
        ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
        ...(stagedAttachments === undefined ? {} : { stagedAttachments }),
        workId: row.work_id,
        ...(leaseExpiresAt === undefined || row.workspace_ref === null ? {} : {
          workspaceLease: { expiresAt: leaseExpiresAt, ...(leaseGeneration === undefined ? {} : { generation: leaseGeneration }), workId: row.work_id, workspaceRef: row.workspace_ref },
        }),
      };
    } catch (error) {
      if (leaseWorkId !== undefined) await this.dependencies.leases.release(leaseWorkId);
      throw error;
    }
  }

  async abandon(input: { claim: PartnerDispatchClaimRow; reasonCode: string }): Promise<void> {
    let row = this.#load(input.claim.dispatchAttemptId);
    if (row === undefined) throw new Error("partner_dispatch_attempt_invalid");
    if (attemptTerminal(row.status) || (row.work_status === "CANCELED" && row.run_status === null)) return;
    if (row.run_id === null && !await this.#ensureRun(row)) return;
    row = this.#load(input.claim.dispatchAttemptId) ?? row;
    await this.#complete(row, "FAILED", {
      artifacts: [],
      body: `Dispatch preparation kept failing with '${input.reasonCode}' and the bounded retry window is exhausted. Inspect the workspace, lease or partner configuration, then create a new attempt.`,
      failure: { phase: "EXECUTION", reasonCode: input.reasonCode, retryable: false, sideEffectState: "NONE" },
    });
  }

  #executionState(dispatchAttemptId: string): { checkpoint_ref: string | null; generation: number; phase: string; staged_attachments_json: string | null; updated_at: string; wait_reason: string | null } | undefined {
    return this.dependencies.database.transaction(db => db.prepare(`SELECT checkpoint_ref, generation, phase, staged_attachments_json, updated_at, wait_reason
      FROM local_work_execution WHERE dispatch_attempt_id = ?`).get(dispatchAttemptId)) as { checkpoint_ref: string | null; generation: number; phase: string; staged_attachments_json: string | null; updated_at: string; wait_reason: string | null } | undefined;
  }

  #workspaceQueueFinished(row: DispatchRow, phase: "READ" | "WRITE", state: { updated_at: string; wait_reason: string | null } | undefined): void {
    if (state?.wait_reason !== `WORKSPACE_${phase}`) return;
    const durationMs = this.dependencies.clock.now().getTime() - Date.parse(state.updated_at);
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.workspace_queue_finished", {
      dispatchAttemptId: row.dispatch_attempt_id, durationMs, phase, workbenchId: row.workbench_id, workId: row.work_id,
    });
  }

  async #prepareContinuation(row: DispatchRow, claim: PartnerDispatchClaimRow): Promise<PreparedDispatch | "skipped_terminal"> {
    const state = this.#executionState(row.dispatch_attempt_id);
    if (state === undefined) return "skipped_terminal";
    if (attemptTerminal(row.status) || ["CANCELED", "FAILED", "COMPLETED"].includes(row.work_status)) {
      await this.dependencies.leases.cancelWait?.(row.work_id);
      await this.dependencies.leases.release(row.work_id);
      this.dependencies.database.transaction(db => {
        db.prepare("DELETE FROM local_work_execution WHERE dispatch_attempt_id = ?").run(row.dispatch_attempt_id);
        db.prepare(`UPDATE partner_instances SET status = 'DISPOSED', disposal_reason = 'work_canceled', disposed_at = ?, last_used_at = ?
          WHERE instance_id = ? AND status = 'SUSPENDED'`).run(this.dependencies.clock.now().toISOString(), this.dependencies.clock.now().toISOString(), row.instance_id);
      });
      return "skipped_terminal";
    }
    const continuationGeneration = claim.continuationGeneration;
    if (state.phase !== "WRITE_QUEUED" || continuationGeneration === undefined || continuationGeneration !== state.generation + 1) return "skipped_terminal";
    if (!this.#goalExecutionOpen(row.work_id)) throw new DomainError("goal_execution_paused", "The goal is awaiting review.");
    this.dependencies.database.transaction(db => this.#assertRequirements(db, row));
    const valid = this.dependencies.database.transaction(db => {
      const instance = db.prepare("SELECT status, engine, external_session_ref FROM partner_instances WHERE instance_id = ?").get(row.instance_id);
      if (state.checkpoint_ref === null || instance?.status !== "SUSPENDED") return false;
      if (instance.engine === "PI_CORE") return state.checkpoint_ref === `partner_instance_messages:${row.instance_id ?? ""}`
        && db.prepare("SELECT 1 FROM partner_instance_messages WHERE instance_id = ? LIMIT 1").get(row.instance_id) !== undefined;
      return instance.external_session_ref === state.checkpoint_ref && state.checkpoint_ref.startsWith("native-agent:v1:");
    });
    const durable = valid && (this.dependencies.instances.validateCheckpoint === undefined || (row.instance_id !== null && state.checkpoint_ref !== null
      && await this.dependencies.instances.validateCheckpoint(row.instance_id, state.checkpoint_ref)));
    if (!durable || row.workspace_ref === null) {
      await this.#complete(row, "FAILED", { artifacts: [], body: "The suspended execution checkpoint is missing or invalid.",
        failure: { phase: "RECOVERY", reasonCode: "workspace_checkpoint_missing", retryable: false, sideEffectState: "NONE" } });
      return "skipped_terminal";
    }
    const lease = await this.dependencies.leases.acquire({ accessMode: "WRITE", workId: row.work_id, workspaceRef: row.workspace_ref, preserveQueue: true,
      admit: db => {
        const current = db.prepare(`SELECT e.phase, e.generation, w.status, a.status AS attempt_status FROM local_work_execution e
          JOIN dispatch_attempts a ON a.dispatch_attempt_id = e.dispatch_attempt_id JOIN work_items w ON w.work_id = a.work_id
          WHERE e.dispatch_attempt_id = ?`).get(row.dispatch_attempt_id);
        if (current?.phase !== "WRITE_QUEUED" || current.generation !== state.generation || current.status !== "RUNNING" || current.attempt_status !== "RUNNING") return null;
        const gate = db.prepare(`SELECT 1 FROM joi_goal_execution_gates gate JOIN joi_inbox_messages i
          ON gate.goal_input_id = COALESCE(i.goal_input_id, i.input_id) WHERE i.input_id = ? AND gate.status <> 'OPEN'`).get(row.input_id);
        if (gate !== undefined) throw new DomainError("goal_execution_paused", "The goal is awaiting review.");
        this.#assertRequirements(db, row);
        return () => {
          db.prepare(`UPDATE local_work_execution SET phase = 'WRITE_RUNNING', generation = ?, wait_reason = NULL, updated_at = ?
            WHERE dispatch_attempt_id = ?`).run(continuationGeneration, this.dependencies.clock.now().toISOString(), row.dispatch_attempt_id);
          db.prepare("DELETE FROM workspace_write_waiters WHERE work_id = ?").run(row.work_id);
        };
      },
    });
    if (lease === null) {
      const current = this.#executionState(row.dispatch_attempt_id);
      if (current?.phase !== "WRITE_QUEUED" || current.generation !== state.generation) return "skipped_terminal";
      await this.queued(claim, "WORKSPACE_WRITE");
      throw new DomainError(DISPATCH_POLICY_REASONS.workspaceLeaseConflict, "The workspace is awaiting its write lease.");
    }
    this.#workspaceQueueFinished(row, "WRITE", state);
    try {
      return { actionId: row.action_id, attemptCount: claim.attemptCount, dispatchAttemptId: row.dispatch_attempt_id,
        executionGeneration: continuationGeneration, ...(row.instance_id === null ? {} : { instanceId: row.instance_id }),
        kind: "LOCAL_PI", outboxId: claim.outboxId, workId: row.work_id,
        ...(state.staged_attachments_json === null ? {} : { stagedAttachments: JSON.parse(state.staged_attachments_json) as StagedAttachment[] }),
        workspaceLease: { expiresAt: lease.expiresAt, generation: lease.generation, workId: row.work_id, workspaceRef: row.workspace_ref } };
    } catch (error) { await this.dependencies.leases.release(row.work_id, lease.generation); throw error; }
  }

  async run(prepared: PreparedDispatch, options?: { onProgress?: () => void; signal?: AbortSignal }): Promise<DispatchRunOutput> {
    const row = this.#load(prepared.dispatchAttemptId);
    if (row === undefined) throw new Error("partner_dispatch_attempt_invalid");
    const revision = await this.dependencies.partners.getRevision(row.partner_revision_id);
    if (revision === null) throw new Error("partner_revision_unavailable");

    if (row.kind === "LOCAL_PI") {
      const executionState = prepared.executionGeneration === undefined ? undefined : this.#executionState(row.dispatch_attempt_id);
      if (prepared.executionGeneration !== undefined && executionState?.generation !== prepared.executionGeneration) return { kind: "suspended" };
      if (row.work_status === "CANCELED" || attemptTerminal(row.status)) {
        await this.dependencies.leases.release(prepared.workId, prepared.workspaceLease?.generation);
        this.dependencies.database.transaction(db => db.prepare("DELETE FROM local_work_execution WHERE dispatch_attempt_id = ? AND generation = ?")
          .run(prepared.dispatchAttemptId, prepared.executionGeneration ?? 0));
        return { kind: "suspended" };
      }
      if (executionState !== undefined && executionState.phase !== "READ_RUNNING" && executionState.phase !== "WRITE_RUNNING") return { kind: "suspended" };
      const runId = row.run_id ?? `partner_run:${row.action_id}`;
      const progressStartedAt = this.dependencies.clock.now().toISOString();
      let result;
      try {
        assertExecutionAccess(row.access_mode,readExecutionNeeds((JSON.parse(row.intent_json) as { executionNeeds?: unknown }).executionNeeds),localExecutionCapabilities(revision));
        result = await this.dependencies.instances.dispatch({
        dispatchAttemptId: row.dispatch_attempt_id,
        ...(revision.engine === "pi-core" && options?.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
        ...(prepared.instanceId === undefined ? {} : { instanceId: prepared.instanceId }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(this.dependencies.agentConversations === undefined ? {} : {
          onConversation: (() => {
            let lastSnapshotAt = 0;
            return async ({ conversation, instanceId }: { conversation: () => AgentConversationDraft[]; instanceId: string }) => {
              const nowMs = this.dependencies.clock.now().getTime();
              // Check the window before reading the snapshot: the copy is the cost, and a frame
              // that this throttle discards must not pay it.
              if (nowMs - lastSnapshotAt < LIVE_CONVERSATION_SNAPSHOT_INTERVAL_MS) return;
              lastSnapshotAt = nowMs;
              await this.dependencies.agentConversations?.replaceRun(instanceId, runId, normalizeAgentConversationEntries(
                { agentId: instanceId, runId, startedAt: progressStartedAt }, conversation(),
              ));
            };
          })(),
          // Private tool bodies are appended one call at a time and never ride along with the
          // 500 ms whole-run snapshot rewrite above.
          onToolTrace: async ({ instanceId, trace }) => {
            await this.dependencies.agentConversations?.appendToolTrace({
              agentId: instanceId, createdAt: this.dependencies.clock.now().toISOString(), runId, trace,
            });
          },
        }),
        request: {
          actionId: row.action_id, workbenchId: row.workbench_id, contextSnapshotId: row.context_snapshot_id ?? "",
          taskProjection: taskProjection(row, prepared.stagedAttachments), workId: row.work_id,
          ...(executionState === undefined ? {} : { workspaceExecution: {
            accessCeiling: row.access_mode === "WRITE" ? "WRITE" as const : "READ" as const,
            generation: executionState.generation, phase: executionState.phase === "WRITE_RUNNING" ? "WRITE_RUNNING" as const : "READ_RUNNING" as const,
          } }),
          ...(row.required_context === undefined ? {} : { requiredContext: row.required_context }),
        },
        revision,
        ...(prepared.sessionPolicy === undefined ? {} : { sessionPolicy: prepared.sessionPolicy }),
      });
      } finally {
        const ended = this.#load(prepared.dispatchAttemptId);
        if (ended?.work_status === "CANCELED" && (prepared.executionGeneration === undefined || this.#executionState(prepared.dispatchAttemptId)?.generation === prepared.executionGeneration)) {
          await this.dependencies.leases.release(prepared.workId, prepared.workspaceLease?.generation);
          this.dependencies.database.transaction(db => {
            db.prepare("DELETE FROM local_work_execution WHERE dispatch_attempt_id = ?").run(prepared.dispatchAttemptId);
            db.prepare(`UPDATE partner_instances SET status = 'DISPOSED', disposed_at = ?, last_used_at = ?, disposal_reason = 'work_canceled'
              WHERE status = 'SUSPENDED' AND instance_id IN (SELECT instance_id FROM dispatch_attempts WHERE dispatch_attempt_id = ?)`)
              .run(this.dependencies.clock.now().toISOString(), this.dependencies.clock.now().toISOString(), prepared.dispatchAttemptId);
          });
        }
      }
      if (this.#load(prepared.dispatchAttemptId)?.work_status === "CANCELED") return { kind: "suspended" };
      if (result.status === "SUSPENDED") {
        const checkpointRef = result.checkpointRef;
        if (prepared.executionGeneration === undefined || row.workspace_ref === null || result.instanceId === undefined
          || checkpointRef === undefined || this.dependencies.leases.requestWrite === undefined) throw new DomainError("workspace_checkpoint_missing", "The suspended execution has no durable checkpoint.");
        const generation = prepared.executionGeneration;
        const now = this.dependencies.clock.now().toISOString();
        const upgraded = await this.dependencies.leases.requestWrite({ workId: row.work_id, workspaceRef: row.workspace_ref, generation }, db => {
          const current = db.prepare(`SELECT e.generation, a.status, w.status AS work_status FROM local_work_execution e
            JOIN dispatch_attempts a ON a.dispatch_attempt_id = e.dispatch_attempt_id JOIN work_items w ON w.work_id = a.work_id WHERE e.dispatch_attempt_id = ?`).get(row.dispatch_attempt_id);
          if (current?.generation !== generation || current.status !== "RUNNING" || current.work_status !== "RUNNING") throw new DomainError("workspace_execution_superseded", "The execution is no longer current.");
          db.prepare(`UPDATE local_work_execution SET phase = 'WRITE_QUEUED', checkpoint_ref = ?, wait_reason = 'WORKSPACE_WRITE', updated_at = ?
            WHERE dispatch_attempt_id = ? AND generation = ?`).run(checkpointRef, now, row.dispatch_attempt_id, generation);
          const nextGeneration = generation + 1;
          db.prepare(`INSERT OR IGNORE INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
            VALUES (?, 'partner.continue', ?, 'PENDING', 0, ?, ?)`).run(`partner_continue:${runId}:${String(nextGeneration)}`,
            JSON.stringify({ actionId: row.action_id, dispatchAttemptId: row.dispatch_attempt_id, generation: nextGeneration, runId, workId: row.work_id }), now, now);
        });
        if (upgraded !== null) {
          // The current execution already owns capacity, so a sole reader continues directly.
          // Heartbeats must follow the upgraded lease while checkpoint validation awaits I/O.
          prepared.workspaceLease = { expiresAt: upgraded.expiresAt, generation: upgraded.generation, workId: row.work_id, workspaceRef: row.workspace_ref };
          const continuationId = `partner_continue:${runId}:${String(generation + 1)}`;
          try {
            const current = this.#load(row.dispatch_attempt_id);
            if (current === undefined) throw new Error("partner_dispatch_attempt_invalid");
            const continued = await this.#prepareContinuation(current, { attemptCount: 0, dispatchAttemptId: row.dispatch_attempt_id,
              outboxId: continuationId, payloadJson: "{}", continuationGeneration: generation + 1 });
            this.dependencies.database.transaction(db => db.prepare("UPDATE outbox SET status = 'DONE' WHERE outbox_id = ?").run(continuationId));
            if (continued === "skipped_terminal") return { kind: "suspended" };
            Object.assign(prepared, continued);
            return await this.run(prepared, options);
          } catch (error) {
            await this.dependencies.leases.release(row.work_id, upgraded.generation);
            if (isWriteResumeWait(error)) return { kind: "suspended" };
            throw error;
          }
        }
        return { kind: "suspended" };
      }
      return {
        artifacts: result.artifacts,
        body: result.body,
        ...(result.handoff === undefined ? {} : { handoff: result.handoff }),
        ...(result.handoffStatus === undefined ? {} : { handoffStatus: result.handoffStatus }),
        ...(result.conversation === undefined ? {} : { conversation: result.conversation }),
        kind: "terminal",
        ...(result.pendingQuestion === undefined ? {} : { pendingQuestion: result.pendingQuestion }),
        status: result.status,
      };
    }

    if (row.agent_connection_id === null) {
      return { artifacts: [], body: "The remote partner connection is unavailable.", kind: "terminal", status: "FAILED" };
    }
    const execution = await this.dependencies.contexts.loadForExecution(row.context_snapshot_id ?? "");
    if (execution === null) throw new Error("workbench_context_snapshot_not_found");
    const remoteContext = selfContainedEvidenceContext(execution);
    if (execution.evidence !== undefined) emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.context.delivery", {
      budgetFallbacks: (execution.evidence.selfContainedInline ?? execution.evidence.inline).length > 24_000 ? 1 : 0,
      contextChars: remoteContext.length, engine: "a2a", evidenceChars: (execution.evidence.selfContainedInline ?? execution.evidence.inline).length,
      evidenceCount: execution.evidence.files.length, reasonCode: "evidence_remote_inline",
    });
    const started = row.invocation_id === null
      ? await this.dependencies.gateway.startWithResult({
        agentConnectionId: row.agent_connection_id,
        // Scope remote artifacts to the Workbench so they count against the storage quota
        // instead of landing unbounded (lifeId is a grouping key; the Workbench plays that role here).
        artifactScope: { lifeId: row.workbench_id },
        capacity: { lane: "collaborator", lifeId: row.workbench_id },
        messageId: row.action_id,
        parts: [
          { kind: "text", text: `${taskProjection(row)}\n\n${remoteContext}\n\n${WORK_HANDOFF_INSTRUCTION} If supported, include a data part with joiWorkHandoff containing that version-1 handoff. Plain-text results remain supported.` },
          { data: { actionId: row.action_id, workbenchId: row.workbench_id, context: execution.sanitized, sourceBoundary: "joi-work", workId: row.work_id }, kind: "data" },
        ],
      })
      : await this.dependencies.gateway.recover(row.invocation_id);
    const terminal = terminalInvocation(started.invocation.status);
    if (terminal === null) return { kind: "waiting_remote" };
    const body = [
      ...started.output.parts.flatMap((part) => {
        const candidate = part as { data?: unknown; kind?: unknown; text?: unknown };
        if (typeof candidate.text === "string") return [candidate.text];
        if (candidate.kind === "text" && typeof candidate.data === "string") return [candidate.data];
        return [];
      }),
      ...started.output.artifacts.map((artifact) => artifact.text),
    ].join("\n");
    const artifacts = started.output.artifacts.map((artifact) => ({
      mimeType: "text/plain; charset=utf-8",
      name: artifact.name,
      size: Buffer.byteLength(artifact.text, "utf8"),
    }));
    const remoteHandoff = started.output.parts.findLast(part => {
      const value = part as { data?: unknown; kind?: unknown };
      return value.kind === "data" && value.data !== null && typeof value.data === "object" && "joiWorkHandoff" in value.data;
    }) as { data: { joiWorkHandoff: unknown } } | undefined;
    const parsed = parseWorkHandoff(remoteHandoff?.data.joiWorkHandoff);
    return { artifacts, body, kind: "terminal", status: terminal, handoffStatus: parsed.status,
      ...(parsed.status === "PROVIDED" ? { handoff: parsed.handoff } : {}) };
  }

  async complete(input: { output: DispatchRunOutput & { kind: "terminal" }; prepared: PreparedDispatch }): Promise<{ isAuthoritative: boolean; resultId: string }> {
    const row = this.#load(input.prepared.dispatchAttemptId);
    if (row === undefined) throw new Error("partner_dispatch_attempt_invalid");
    if (input.prepared.executionGeneration !== undefined && this.#executionState(row.dispatch_attempt_id)?.generation !== input.prepared.executionGeneration) return { isAuthoritative: false, resultId: "" };
    return this.#complete(row, input.output.status, {
      artifacts: input.output.artifacts,
      body: input.output.body,
      ...(input.output.handoff === undefined ? {} : { handoff: input.output.handoff }),
      ...(input.output.handoffStatus === undefined ? {} : { handoffStatus: input.output.handoffStatus }),
      ...(input.output.conversation === undefined ? {} : { conversation: input.output.conversation }),
      ...(input.output.failure === undefined ? {} : { failure: input.output.failure }),
      ...(input.output.pendingQuestion === undefined ? {} : { pendingQuestion: input.output.pendingQuestion }),
    });
  }

  async finalizeOrphan(orphan: PartnerDispatchOrphanRow): Promise<"completed" | "waiting"> {
    const row = this.#load(orphan.dispatchAttemptId);
    if (row === undefined || attemptTerminal(row.status)) return "completed";
    // A canceled Work must not be resumed: converge the orphaned run to a terminal state
    // without executing it, mirroring prepare()'s cancellation guard. Running it would do
    // work the user already revoked and could write a result into the canceled goal.
    if (row.work_status === "CANCELED") {
      const failure = classifyPartnerRunFailure({ code: "work_canceled_before_recovery" }, { phase: "RECOVERY", sideEffectState: "NONE" });
      await this.#complete(row, "FAILED", { artifacts: [], body: safePartnerRunFailureBody(failure), failure });
      return "completed";
    }
    const prepared: PreparedDispatch = {
      actionId: row.action_id,
      attemptCount: 0,
      dispatchAttemptId: row.dispatch_attempt_id,
      ...(row.instance_id === null ? {} : { instanceId: row.instance_id }),
      kind: row.kind,
      outboxId: "",
      workId: row.work_id,
    };
    if (row.kind === "LOCAL_PI") {
      if (row.scheduling_version === 2 && this.#executionState(row.dispatch_attempt_id) !== undefined) {
        const failure: PartnerRunFailure = { phase: "RECOVERY", reasonCode: "workspace_execution_interrupted", retryable: false,
          sideEffectState: this.#executionState(row.dispatch_attempt_id)?.phase === "READ_RUNNING" ? "NONE" : "UNKNOWN" };
        await this.#complete(row, failure.sideEffectState === "NONE" ? "FAILED" : "UNKNOWN", { artifacts: [], body: safePartnerRunFailureBody(failure), failure });
        return "completed";
      }
      const fresh = orphan.instanceStatus;
      if (fresh === "BUSY") return "waiting";
      if (fresh === "IDLE") {
        try {
          const output = await this.run(prepared);
          if (output.kind !== "terminal") return "waiting";
          await this.complete({ output, prepared });
          return "completed";
        } catch (error) {
          const failure = partnerRunFailureFromError(error, { phase: "RECOVERY", sideEffectState: "UNKNOWN" });
          await this.#complete(row, "UNKNOWN", { artifacts: partnerRunArtifactsFromError(error), body: safePartnerRunFailureBody(failure), failure });
          return "completed";
        }
      }
      const failure = classifyPartnerRunFailure({ code: "orphan_terminal_state_unknown" }, { phase: "RECOVERY", sideEffectState: "UNKNOWN" });
      await this.#complete(row, "UNKNOWN", { artifacts: [], body: safePartnerRunFailureBody(failure), failure });
      return "completed";
    }
    const output = await this.run(prepared);
    if (output.kind !== "terminal") return "waiting";
    await this.complete({ output, prepared });
    return "completed";
  }

  /**
   * Stamps the run as still owned by a live process. Guarded on RUNNING so a beat that races the
   * terminal write cannot revive a finished run's heartbeat and make a dead owner look alive.
   */
  async heartbeatRun(input: { dispatchAttemptId: string; now: string }): Promise<void> {
    this.dependencies.database.transaction((connection) => {
      connection.prepare(`UPDATE partner_runs SET heartbeat_at = ?
        WHERE dispatch_attempt_id = ? AND status = 'RUNNING'`).run(input.now, input.dispatchAttemptId);
    });
  }

  async handle(record: OutboxRecord): Promise<void> {
    const dispatchAttemptId = record.payload.dispatchAttemptId;
    const actionId = record.payload.actionId;
    if (typeof dispatchAttemptId !== "string" || typeof actionId !== "string") throw new Error("partner_dispatch_payload_invalid");
    const prepared = await this.prepare({
      attemptCount: record.attemptCount,
      dispatchAttemptId,
      outboxId: record.outboxId,
      payloadJson: JSON.stringify(record.payload),
    });
    if (prepared === "skipped_terminal") {
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.dispatch.skipped", {
        actionId,
        dispatchAttemptId,
        outboxId: record.outboxId,
        status: "terminal",
      });
      return;
    }
    let output: DispatchRunOutput;
    try {
      output = await this.run(prepared);
    } catch (error) {
      const failedRow = this.#load(dispatchAttemptId);
      if (failedRow !== undefined) {
        const failure = partnerRunFailureFromError(error);
        const status = failure.sideEffectState === "NONE" ? "FAILED" : "UNKNOWN";
        await this.#complete(failedRow, status, { artifacts: partnerRunArtifactsFromError(error), body: safePartnerRunFailureBody(failure), failure });
      }
      return;
    }
    if (output.kind === "suspended") return;
    if (output.kind === "waiting_remote") throw new Error("partner_dispatch_not_terminal");
    await this.complete({ output, prepared });
  }

  #load(dispatchAttemptId: string): DispatchRow | undefined {
    const row = this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT a.dispatch_attempt_id, a.action_id, a.status, a.partner_revision_id, a.instance_id, a.scheduling_version,
             w.work_id, w.workbench_id, w.input_id, w.title, w.intent_json, i.body AS source_request,
             w.status AS work_status,
             COALESCE(ap.access_mode, w.access_mode) AS access_mode,
             b.workspace_ref, COALESCE(d.status, b.status) AS workspace_status,
             p.partner_id, p.kind, p.legacy_agent_connection_id AS agent_connection_id,
             r.display_name AS partner_display_name,
             (SELECT invocation_id FROM invocations WHERE message_id = a.action_id) AS invocation_id,
             pr.run_id, pr.status AS run_status, pr.context_snapshot_id, pr.requirements_context AS required_context
        FROM dispatch_attempts a
        JOIN work_items w ON w.work_id = a.work_id
        JOIN joi_inbox_messages i ON i.input_id = w.input_id
        JOIN partner_revisions r ON r.partner_revision_id = a.partner_revision_id
        JOIN partners p ON p.partner_id = r.partner_id
        LEFT JOIN work_access_policies ap ON ap.work_id = w.work_id
        LEFT JOIN workbench_workspace_bindings b ON b.workbench_id = w.workbench_id
        LEFT JOIN work_run_directories d ON d.work_id = w.work_id
        LEFT JOIN partner_runs pr ON pr.dispatch_attempt_id = a.dispatch_attempt_id
       WHERE a.dispatch_attempt_id = ?`).get(dispatchAttemptId)) as DispatchRow | undefined;
    if (row !== undefined) {
      if (typeof row.required_context === "string" && row.run_id !== null) return row;
      delete row.required_context;
      if (row.run_id !== null) return row;
    }
    if (row !== undefined) this.dependencies.database.transaction(db => {
      let parsed: unknown;
      try { parsed = JSON.parse(row.intent_json); } catch { return; }
      if (parsed === null || typeof parsed !== "object") return;
      const brief = parsed as { requirementsRevision?: number; requirementIds?: string[]; allRequirements?: boolean };
      if (brief.requirementsRevision === undefined) return;
      const current = loadGoalRequirements(db, row.input_id, row.workbench_id);
      const snapshot = db.prepare("SELECT requirements_json FROM joi_goal_requirement_snapshots WHERE goal_input_id = ? AND revision = ?").get(row.input_id, brief.requirementsRevision);
      if (current === null || typeof snapshot?.requirements_json !== "string") throw new DomainError("goal_requirements_stale", "The pinned requirements snapshot is unavailable.");
      row.required_context = renderGoalRequirements({ ...current, revision: brief.requirementsRevision, status: "READY", sourceRevision: current.processedSourceRevision,
        requirements: JSON.parse(snapshot.requirements_json) as GoalRequirement[] }, brief.requirementIds ?? [], brief.allRequirements ?? false);
    });
    return row;
  }

  #assertRequirements(db: DatabaseSync, row: DispatchRow): void {
    let parsed: unknown;
    try { parsed = JSON.parse(row.intent_json); } catch {
      assertGoalRequirementsReady(db, row.input_id);
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      assertGoalRequirementsReady(db, row.input_id);
      return;
    }
    const brief = parsed as { briefVersion?: number; requirementsRevision?: number };
    const contract = assertGoalRequirementsReady(db, row.input_id, brief.requirementsRevision);
    if (contract !== null && brief.briefVersion !== 3) throw new DomainError("goal_requirements_stale", "Refresh this queued Work before starting.");
  }

  async #ensureRun(row: DispatchRow, payloadJson = "{}"): Promise<boolean> {
    const now = this.dependencies.clock.now().toISOString();
    const runId = `partner_run:${row.action_id}`;
    const externalRunId = row.kind === "LOCAL_PI" ? `local_pi:${row.action_id}` : `a2a:${row.action_id}`;
    const snapshot = await this.dependencies.contextAssembler.assemble({ workbenchId: row.workbench_id, workId: row.work_id });
    const created = this.dependencies.database.transaction((connection) => {
      // Recheck after asynchronous context assembly: cancellation, terminal results and
      // another preparation can win while the snapshot is being assembled.
      const current = connection.prepare(`SELECT w.status AS work_status, w.intent_json, a.status AS attempt_status,
          i.canceled_at, i.failed_at, pr.run_id
        FROM dispatch_attempts a JOIN work_items w ON w.work_id = a.work_id
        JOIN joi_inbox_messages i ON i.input_id = w.input_id
        LEFT JOIN partner_runs pr ON pr.dispatch_attempt_id = a.dispatch_attempt_id
        WHERE a.dispatch_attempt_id = ? AND a.dispatch_attempt_id = (
          SELECT latest.dispatch_attempt_id FROM dispatch_attempts latest WHERE latest.work_id = w.work_id
          ORDER BY latest.created_at DESC, latest.dispatch_attempt_id DESC LIMIT 1)`).get(row.dispatch_attempt_id) as {
          work_status: string; intent_json: string; attempt_status: string; canceled_at: string | null; failed_at: string | null; run_id: string | null;
        } | undefined;
      if (current?.run_id !== null || attemptTerminal(current.attempt_status)
        || current.canceled_at !== null || current.failed_at !== null
        || !["PLANNED", "READY"].includes(current.work_status)) return false;
      const blocked = connection.prepare(`SELECT 1 FROM work_items w
        JOIN joi_inbox_messages i ON i.input_id = w.input_id
        JOIN joi_goal_execution_gates gate ON gate.goal_input_id = COALESCE(i.goal_input_id, i.input_id)
        WHERE w.work_id = ? AND gate.status <> 'OPEN' LIMIT 1`).get(row.work_id);
      if (blocked !== undefined) throw new DomainError("goal_execution_paused", "The goal is waiting for Joi to review a user answer.");
      this.#assertRequirements(connection, row);
      if (current.intent_json !== row.intent_json) throw new DomainError("goal_requirements_stale", "The task brief changed during preparation.");
      let pinnedRevision: number | null = null;
      let pinnedRequirementIds: string[] | null = null;
      try {
        const brief = JSON.parse(row.intent_json) as { requirementsRevision?: number };
        pinnedRevision = brief.requirementsRevision ?? null;
      } catch { /* Invalid legacy briefs are persisted as terminal configuration failures. */ }
      if (pinnedRevision !== null) {
        const contract = loadGoalRequirements(connection, row.input_id, row.workbench_id);
        if (contract?.revision !== pinnedRevision) throw new DomainError("goal_requirements_stale", "The run requires its exact requirements snapshot.");
        const brief = JSON.parse(row.intent_json) as { requirementIds?: string[]; allRequirements?: boolean };
        pinnedRequirementIds = contract.requirements.filter(requirement => brief.allRequirements === true
          || requirement.scope === "GLOBAL" && requirement.mandatory || brief.requirementIds?.includes(requirement.id)).map(requirement => requirement.id);
      }
      // Reserve an explicitly selected instance by linking this persisted start in the
      // same transaction. BUSY and already-started turns both keep later Work queued.
      let instanceId: string | undefined;
      try {
        const payload = JSON.parse(payloadJson) as { instanceId?: unknown };
        if (typeof payload.instanceId === "string") instanceId = payload.instanceId;
      } catch { /* Same malformed-payload fallback as prepare. */ }
      if (row.kind === "LOCAL_PI" && instanceId !== undefined) {
        const instance = connection.prepare(`SELECT status FROM partner_instances WHERE instance_id = ?`).get(instanceId) as { status: string } | undefined;
        const started = connection.prepare(`SELECT 1 FROM dispatch_attempts a JOIN partner_runs r
          ON r.dispatch_attempt_id = a.dispatch_attempt_id WHERE a.instance_id = ? AND r.status = 'RUNNING'`).get(instanceId);
        if (instance?.status === "BUSY" || instance?.status === "SUSPENDED" || started !== undefined) {
          throw new DomainError("partner_instance_busy", "Partner instance is busy with another turn.");
        }
        if (instance?.status === "IDLE") connection.prepare("UPDATE dispatch_attempts SET instance_id = ? WHERE dispatch_attempt_id = ?")
          .run(instanceId, row.dispatch_attempt_id);
      }
      connection.prepare(`INSERT INTO partner_runs
        (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind,
         external_run_id, status, created_at, updated_at, context_snapshot_id, requirements_revision, requirements_context, requirement_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?)`
      ).run(
        runId, row.dispatch_attempt_id, row.action_id, row.workbench_id, row.work_id, row.partner_revision_id,
        row.kind, externalRunId, now, now, snapshot.contextSnapshotId,
        pinnedRevision, row.required_context ?? null, pinnedRequirementIds === null ? null : JSON.stringify(pinnedRequirementIds),
      );
      connection.prepare("UPDATE dispatch_attempts SET status = 'RUNNING', updated_at = ? WHERE dispatch_attempt_id = ?")
        .run(now, row.dispatch_attempt_id);
      connection.prepare("UPDATE work_items SET status = 'RUNNING', updated_at = ? WHERE work_id = ?")
        .run(now, row.work_id);
      if (row.kind === "A2A") connection.prepare(`INSERT OR IGNORE INTO workbench_agent_sessions
        (agent_id, workbench_id, partner_id, partner_revision_id, backing_kind, backing_id, session_policy, created_at)
        VALUES (?, ?, ?, ?, 'A2A_RUN', ?, 'EPHEMERAL', ?)`
      ).run(`a2a_agent:${runId}`, row.workbench_id, row.partner_id, row.partner_revision_id, runId, now);
      return true;
    });
    if (!created) return false;
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.run.created", {
      actionId: row.action_id,
      ...(row.kind === "A2A" ? { agentId: `a2a_agent:${runId}` } : {}),
      workbenchId: row.workbench_id,
      dispatchAttemptId: row.dispatch_attempt_id,
      kind: row.kind,
      runId,
      workId: row.work_id,
    });
    return true;
  }

  #goalExecutionOpen(workId: string): boolean {
    return this.dependencies.database.transaction((connection) => connection.prepare(`SELECT 1 FROM work_items w
      JOIN joi_inbox_messages i ON i.input_id = w.input_id
      JOIN joi_goal_execution_gates gate ON gate.goal_input_id = COALESCE(i.goal_input_id, i.input_id)
      WHERE w.work_id = ? AND gate.status <> 'OPEN' LIMIT 1`).get(workId)) === undefined;
  }

  async #complete(row: DispatchRow, status: PartnerRunStatus, output: PartnerRunOutput & {
    conversation?: AgentConversationDraft[];
    failure?: PartnerRunFailure;
    pendingQuestion?: string;
  }): Promise<{ isAuthoritative: boolean; resultId: string }> {
    const current = this.#load(row.dispatch_attempt_id);
    if (current !== undefined && attemptTerminal(current.status)) return { isAuthoritative: false, resultId: "" };
    row = current ?? row;
    const now = this.dependencies.clock.now().toISOString();
    const runId = row.run_id ?? `partner_run:${row.action_id}`;
    const brief = workBrief(row.intent_json);
    if (brief.droppedChecks > 0) {
      // Plan-time validation makes this defensive; a non-zero count signals stored data drift.
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.brief_checks_filtered", {
        workbenchId: row.workbench_id,
        dispatchAttemptId: row.dispatch_attempt_id,
        droppedChecks: brief.droppedChecks,
        partnerId: row.partner_id,
        workId: row.work_id,
      });
    }
    let verification = { status: "NOT_REQUIRED" as const } as Awaited<ReturnType<WorkVerifier["verify"]>>;
    let committedStatus = status;
    const acceptanceChecks = status === "COMPLETED"
      ? brief.acceptanceChecks
      : brief.acceptanceChecks.filter((check) => check.kind !== "BODY_PRESENT");
    if (acceptanceChecks.length > 0 && (status === "COMPLETED" || output.artifacts.length > 0)) {
      verification = row.context_snapshot_id === null
        ? { reasonCode: "verification_context_missing", status: "FAILED" }
        : this.dependencies.verifier === undefined
          ? { reasonCode: "verification_unavailable", status: "FAILED" }
          : await this.dependencies.verifier.verify({
            acceptanceChecks,
            artifacts: output.artifacts,
            body: output.body,
            contextSnapshotId: row.context_snapshot_id,
          });
      if (verification.status === "PASSED") committedStatus = "COMPLETED";
      else committedStatus = "FAILED";
    }
    const recorded = await this.dependencies.results.record(createWorkResult({
      actionId: row.action_id,
      artifacts: output.artifacts,
      workbenchId: row.workbench_id,
      body: output.body,
      ...(output.handoff === undefined ? {} : { handoff: output.handoff }),
      ...(output.handoffStatus === undefined ? {} : { handoffStatus: output.handoffStatus }),
      createdAt: now,
      ...(row.instance_id === null ? {} : { instanceId: row.instance_id }),
      isLate: false,
      partnerRevisionId: row.partner_revision_id,
      resultId: `work_result:${runId}:${committedStatus}`,
      runId,
      status: committedStatus,
      ...(verification.status === "FAILED" ? { summary: `Work verification failed (${verification.reasonCode ?? "verification_failed"}).${verification.detail === undefined ? "" : ` ${verification.detail}`}` } : {}),
      verification,
      workId: row.work_id,
    }));
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.handoff", { workbenchId: row.workbench_id, workId: row.work_id,
      resultId: recorded.result.resultId, handoffStatus: recorded.result.handoffStatus ?? "MISSING",
      handoffChars: recorded.result.handoff === undefined ? 0 : JSON.stringify(recorded.result.handoff).length, isAuthoritative: recorded.isAuthoritative });
    if (recorded.isAuthoritative && (committedStatus === "COMPLETED" || committedStatus === "FAILED")) {
      this.dependencies.database.transaction((connection) => connection.prepare(`UPDATE work_recovery_attempts
        SET status = ?, updated_at = ?
        WHERE status = 'PLANNED' AND (replacement_work_id = ? OR (source_work_id = ? AND strategy = 'REASSIGN'))`)
        .run(committedStatus, now, row.work_id, row.work_id));
    }
    const agentId = row.kind === "A2A" ? `a2a_agent:${runId}` : row.instance_id;
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.result.recorded", {
      actionId: row.action_id,
      ...(agentId === null ? {} : { agentId }),
      workbenchId: row.workbench_id,
      dispatchAttemptId: row.dispatch_attempt_id,
      isLate: recorded.result.isLate,
      isAuthoritative: recorded.isAuthoritative,
      resultId: recorded.result.resultId,
      ...(output.failure === undefined ? {} : {
        phase: output.failure.phase,
        reasonCode: output.failure.reasonCode,
        retryable: output.failure.retryable,
        sideEffectState: output.failure.sideEffectState,
      }),
      runId,
      status: committedStatus,
      workId: row.work_id,
    });
    if (recorded.cascadedWorkIds !== undefined) {
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.dependency_cascade", {
        workbenchId: row.workbench_id,
        canceledWorkIds: recorded.cascadedWorkIds,
        reasonCode: "dependency_failed",
        sourceWorkId: row.work_id,
      });
    }
    if (agentId !== null && this.dependencies.agentConversations !== undefined) {
      const fallback: AgentConversationDraft[] = [
        { kind: "MARKDOWN", role: "USER", text: taskProjection(row) },
        ...(output.body === "" ? [] : [{ kind: output.failure !== undefined || committedStatus === "FAILED" ? "ERROR" as const : "MARKDOWN" as const, role: "AGENT" as const, text: output.body }]),
      ];
      const artifacts: AgentConversationDraft[] = output.artifacts.map((artifact) => ({
          artifact: {
            ...(artifact.artifactRef === undefined ? {} : { artifactRef: artifact.artifactRef }),
            mimeType: artifact.mimeType ?? "application/octet-stream", name: artifact.name, size: artifact.size,
          },
          kind: "ARTIFACT" as const,
          role: "AGENT" as const,
        }));
      const terminalError: AgentConversationDraft[] = committedStatus === "FAILED" || committedStatus === "UNKNOWN"
        ? [{
            kind: "ERROR" as const,
            role: "AGENT" as const,
            text: terminalFailureSummary({
              ...(output.failure === undefined ? {} : { failure: output.failure }),
              status: committedStatus,
              ...(verification.status === "FAILED"
                ? {
                    verificationDetail: verification.detail,
                    verificationReasonCode: verification.reasonCode ?? "verification_failed",
                  }
                : {}),
            }),
          }]
        : [];
      const hasLiveHistory = output.conversation === undefined && this.dependencies.database.transaction(connection =>
        connection.prepare("SELECT 1 FROM workbench_agent_conversation_entries WHERE agent_id = ? AND run_id = ? LIMIT 1").get(agentId, runId) !== undefined);
      if (hasLiveHistory) {
        // Exceptions/recovery may only supply a final error, not an engine snapshot.
        // Keep the already persisted event timeline; terminal IDs are stable on retry.
        const terminalEntries = normalizeAgentConversationEntries(
          { agentId, runId, startedAt: now }, [...fallback.filter(entry => entry.role !== "USER"), ...artifacts, ...terminalError],
        ).map(entry => ({ ...entry, entryId: `terminal:${entry.entryId}` }));
        await this.dependencies.agentConversations.append(agentId, terminalEntries);
      } else {
        await this.dependencies.agentConversations.replaceRun(agentId, runId, normalizeAgentConversationEntries(
          { agentId, runId, startedAt: now }, [...(output.conversation ?? fallback), ...artifacts, ...terminalError],
        ));
      }
    }
    await this.dependencies.leases.cancelWait?.(row.work_id);
    await this.dependencies.leases.release(row.work_id);
    this.dependencies.database.transaction(db => {
      db.prepare("DELETE FROM local_work_execution WHERE dispatch_attempt_id = ?").run(row.dispatch_attempt_id);
      db.prepare(`UPDATE partner_instances SET status = 'DISPOSED', disposal_reason = 'suspended_execution_terminal', disposed_at = ?, last_used_at = ?
        WHERE instance_id = ? AND status = 'SUSPENDED'`).run(now, now, row.instance_id);
    });
    if (recorded.isAuthoritative) {
      await this.dependencies.publish?.(recorded.event);
    }
    // A paused partner raises a deterministic question card on the goal input; the user's
    // answer re-PENDs the input and joi resumes the waiting work from there.
    if (recorded.isAuthoritative && committedStatus === "WAITING_INPUT" && output.pendingQuestion !== undefined) {
      await this.dependencies.clarifications?.requireClarification(
        row.input_id,
        "question_required",
        `搭档『${row.partner_display_name}』在执行工作『${row.title}』时暂停并提问：\n${output.pendingQuestion}`,
        {
          actionId: `joi_action:question:${runId}`,
          kind: "PARTNER_QUESTION",
          runId,
          workId: row.work_id,
        },
      );
    }
    return { isAuthoritative: recorded.isAuthoritative, resultId: recorded.result.resultId };
  }
}

function terminalFailureSummary(input: { failure?: PartnerRunFailure; status: "FAILED" | "UNKNOWN"; verificationDetail?: string; verificationReasonCode?: string }): string {
  const reasonCode = input.failure?.reasonCode ?? input.verificationReasonCode ?? "partner_run_failed";
  const health = input.failure !== undefined && ["auth_forbidden", "model_access_forbidden", "region_forbidden", "request_policy_forbidden", "http_401", "http_403"].includes(reasonCode)
    ? "The model source was removed from dispatch and a no-tool health diagnostic was requested."
    : "Model source health was not changed by this terminal result.";
  const recovery = input.failure?.sideEffectState === "OBSERVED"
    ? "A tool that may have side effects was called; the original Work will not be replayed. Existing artifacts must be verified, and any remaining gap must use a supplemental Work."
    : input.failure?.sideEffectState === "UNKNOWN"
      ? "Possible side effects cannot be ruled out; the original Work will not be replayed. Existing artifacts must be verified before supplemental recovery."
      : "No possibly side-effecting tool call was recorded; any replacement attempt must still follow the bounded recovery policy.";
  // Verification failures name the exact check that failed: without it the card looks like a
  // delivery failure even when the deliverable exists and only an acceptance check mismatched.
  const detail = input.failure === undefined && input.verificationDetail !== undefined ? ` ${input.verificationDetail}` : "";
  return `Partner terminal error: status=${input.status}; reasonCode=${reasonCode}.${detail} ${health} ${recovery}`;
}
