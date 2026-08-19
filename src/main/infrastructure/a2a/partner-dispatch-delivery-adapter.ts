/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { A2aGatewayService } from "../../application/a2a/a2a-gateway-service.js";
import type { PartnerInstanceManager } from "../../application/partners/partner-instance-manager.js";
import { normalizeAgentConversationEntries, type AgentConversationDraft } from "../../application/partners/agent-conversation-presentation.js";
import { classifyPartnerRunFailure, safePartnerRunFailureBody } from "../../application/partners/partner-run-failure.js";
import type { WorkbenchAgentRepository } from "../../application/ports/workbench-agents.js";
import type { InvocationStatus } from "../../application/ports/a2a-ports.js";
import type { PartnerRunStatus } from "../../application/ports/partner-execution.js";
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
import { createWorkResult } from "../../domain/work/work-result.js";
import type { WorkAccessMode } from "../../domain/work/work.js";
import type { SqliteWorkspaceLeaseManager } from "../persistence/sqlite-workspace-lease-manager.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

interface DispatchRow {
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
}

function workBrief(intentJson: string): { acceptanceChecks: WorkAcceptanceCheck[]; instructions?: string } {
  try {
    const parsed = JSON.parse(intentJson) as { acceptanceChecks?: unknown; instructions?: unknown };
    const acceptanceChecks = Array.isArray(parsed.acceptanceChecks)
      ? parsed.acceptanceChecks.filter((value): value is WorkAcceptanceCheck => {
        if (value === null || Array.isArray(value) || typeof value !== "object") return false;
        const candidate = value as Record<string, unknown>;
        if (candidate.kind === "BODY_PRESENT") return true;
        if (candidate.kind === "ARTIFACT_PRESENT") return typeof candidate.name === "string";
        if (candidate.kind === "FILE_EXISTS") return typeof candidate.relativePath === "string";
        return candidate.kind === "FILE_CONTAINS_EXACT"
          && typeof candidate.relativePath === "string" && typeof candidate.expectedText === "string";
      })
      : [];
    return {
      acceptanceChecks,
      ...(typeof parsed.instructions === "string" && parsed.instructions !== "" ? { instructions: parsed.instructions } : {}),
    };
  } catch {
    return { acceptanceChecks: [] };
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
  const stagedLines = (stagedAttachments ?? []).map((staged) => `- ${staged.relativePath} (${staged.mimeType}, ${String(staged.size)} bytes)`);
  return [
    `Work title: ${row.title}`,
    `Original user request (authoritative):\n${row.source_request}`,
    ...(brief.instructions === undefined ? [] : [`Additional instructions:\n${brief.instructions}`]),
    ...(stagedLines.length === 0 ? [] : [`Attachments from the user's original input are staged in this workspace (read them via these relative paths; treat them as read-only inputs):\n${stagedLines.join("\n")}`]),
    ...(checks.length === 0 ? [] : [`Acceptance checks:\n${checks.join("\n")}`]),
  ].join("\n\n");
}

function attemptTerminal(status: string): boolean {
  return ["COMPLETED", "FAILED", "WAITING_INPUT", "WAITING_AUTH", "UNKNOWN"].includes(status);
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
    return (this.database.transaction((connection) => connection.prepare(`
      SELECT o.outbox_id, o.payload_json, o.attempt_count, a.dispatch_attempt_id
        FROM outbox o
        JOIN dispatch_attempts a ON a.outbox_id = o.outbox_id
        JOIN work_items w ON w.work_id = a.work_id
        JOIN partner_revisions rev ON rev.partner_revision_id = a.partner_revision_id
       WHERE o.kind = 'partner.dispatch' AND w.workbench_id = ? AND rev.partner_id = ?
         AND o.available_at <= ?
         AND (o.status = 'PENDING' OR (o.status = 'CLAIMED' AND o.claim_until <= ?))
       ORDER BY o.created_at ASC, o.outbox_id ASC LIMIT 10`)
      .all(input.workbenchId, input.partnerId, input.now, input.now)) as Record<string, unknown>[])
      .map((row) => ({
        attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : 0,
        dispatchAttemptId: String(row.dispatch_attempt_id),
        outboxId: String(row.outbox_id),
        payloadJson: String(row.payload_json),
      }));
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
    agentConversations?: Pick<WorkbenchAgentRepository, "append">;
    /** Stages source-input attachments into the workspace for file-capable local work. */
    attachmentStager?: Pick<WorkAttachmentStagerPort, "stage">;
    clock: Clock;
    contextAssembler: Pick<WorkbenchContextAssembler, "assemble">;
    contexts: WorkbenchExecutionContextReader;
    database: TransactionalDatabase;
    diagnostics?: RuntimeDiagnostics;
    gateway: Pick<A2aGatewayService, "recover" | "startWithResult">;
    instances: Pick<PartnerInstanceManager, "dispatch">;
    leases: Pick<SqliteWorkspaceLeaseManager, "acquire" | "release">;
    partners: Pick<PartnerRegistryRepository, "getRevision">;
    publish?: (event: SseEvent) => Promise<unknown>;
    results: WorkResultRepository;
    verifier?: WorkVerifier;
  }) {}

  async prepare(claim: PartnerDispatchClaimRow): Promise<PreparedDispatch | "skipped_terminal"> {
    let row = this.#load(claim.dispatchAttemptId);
    if (row === undefined) throw new Error("partner_dispatch_attempt_invalid");
    if (attemptTerminal(row.status)) return "skipped_terminal";
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

    if (row.access_mode !== "NONE") {
      if (row.kind === "A2A") {
        await this.#ensureRun(row);
        row = this.#load(claim.dispatchAttemptId) ?? row;
        await this.#complete(row, "FAILED", { artifacts: [], body: "Remote partners cannot execute Workbench file work." });
        return "skipped_terminal";
      }
      if (row.workspace_status !== "READY" || row.workspace_ref === null) throw new Error("workbench_workspace_not_ready");
      const lease = await this.dependencies.leases.acquire({
        accessMode: row.access_mode,
        workId: row.work_id,
        workspaceRef: row.workspace_ref,
      });
      if (lease === null) throw new Error("workspace_lease_conflict");
    }

    // Stage the source input's attachments while holding the workspace lease so
    // file-capable local partners can read the originals from deterministic paths.
    let stagedAttachments: readonly StagedAttachment[] | undefined;
    if (row.access_mode !== "NONE" && row.kind === "LOCAL_PI" && row.workspace_ref !== null && this.dependencies.attachmentStager !== undefined) {
      const workspaceRef = row.workspace_ref;
      const inputId = row.input_id;
      const roots = this.dependencies.database.transaction((connection) => connection.prepare(
        "SELECT root_path FROM workbench_workspace_roots WHERE workspace_ref = ?",
      ).get(workspaceRef)) as { root_path?: unknown } | undefined;
      if (typeof roots?.root_path === "string") {
        const staged = await this.dependencies.attachmentStager.stage({ inputId, workspacePath: roots.root_path });
        if (staged.length > 0) stagedAttachments = staged;
      }
    }

    const runWasPresent = row.run_id !== null;
    if (!runWasPresent) {
      await this.#ensureRun(row);
      row = this.#load(claim.dispatchAttemptId);
      if (row?.run_id === undefined || row.run_id === null) throw new Error("partner_run_create_failed");
    }
    const revision = await this.dependencies.partners.getRevision(row.partner_revision_id);
    if (revision === null) {
      await this.#complete(row, "FAILED", { artifacts: [], body: "The pinned partner revision is unavailable." });
      return "skipped_terminal";
    }
    if (row.context_snapshot_id === null) throw new Error("workbench_context_snapshot_not_found");

    if (runWasPresent && row.run_status === "RUNNING" && row.kind === "LOCAL_PI" && row.instance_id === null) {
      // A crashed legacy single-shot run is not resumable; instance-linked attempts resume via finalizeOrphan.
      await this.#complete(row, "UNKNOWN", { artifacts: [], body: "The previous local run could not be resumed safely." });
      return "skipped_terminal";
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
      ...(instanceId === undefined ? {} : { instanceId }),
      kind: row.kind,
      outboxId: claim.outboxId,
      ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
      ...(stagedAttachments === undefined ? {} : { stagedAttachments }),
    };
  }

  async run(prepared: PreparedDispatch): Promise<DispatchRunOutput> {
    const row = this.#load(prepared.dispatchAttemptId);
    if (row === undefined) throw new Error("partner_dispatch_attempt_invalid");
    const revision = await this.dependencies.partners.getRevision(row.partner_revision_id);
    if (revision === null) throw new Error("partner_revision_unavailable");

    if (row.kind === "LOCAL_PI") {
      const result = await this.dependencies.instances.dispatch({
        dispatchAttemptId: row.dispatch_attempt_id,
        ...(prepared.instanceId === undefined ? {} : { instanceId: prepared.instanceId }),
        request: {
          actionId: row.action_id, workbenchId: row.workbench_id, contextSnapshotId: row.context_snapshot_id ?? "",
          taskProjection: taskProjection(row, prepared.stagedAttachments), workId: row.work_id,
        },
        revision,
        ...(prepared.sessionPolicy === undefined ? {} : { sessionPolicy: prepared.sessionPolicy }),
      });
      return {
        artifacts: result.artifacts,
        body: result.body,
        ...(result.conversation === undefined ? {} : { conversation: result.conversation }),
        kind: "terminal",
        status: result.status,
      };
    }

    if (row.agent_connection_id === null) {
      return { artifacts: [], body: "The remote partner connection is unavailable.", kind: "terminal", status: "FAILED" };
    }
    const execution = await this.dependencies.contexts.loadForExecution(row.context_snapshot_id ?? "");
    if (execution === null) throw new Error("workbench_context_snapshot_not_found");
    const started = row.invocation_id === null
      ? await this.dependencies.gateway.startWithResult({
        agentConnectionId: row.agent_connection_id,
        capacity: { lane: "collaborator", lifeId: row.workbench_id },
        messageId: row.action_id,
        parts: [
          { kind: "text", text: taskProjection(row) },
          { data: { actionId: row.action_id, workbenchId: row.workbench_id, context: execution.sanitized, sourceBoundary: "joi-work", workId: row.work_id }, kind: "data" },
        ],
      })
      : { invocation: await this.dependencies.gateway.recover(row.invocation_id), output: { artifacts: [], parts: [] } };
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
    return { artifacts, body, kind: "terminal", status: terminal };
  }

  async complete(input: { output: DispatchRunOutput & { kind: "terminal" }; prepared: PreparedDispatch }): Promise<{ isAuthoritative: boolean; resultId: string }> {
    const row = this.#load(input.prepared.dispatchAttemptId);
    if (row === undefined) throw new Error("partner_dispatch_attempt_invalid");
    return this.#complete(row, input.output.status, {
      artifacts: input.output.artifacts,
      body: input.output.body,
      ...(input.output.conversation === undefined ? {} : { conversation: input.output.conversation }),
    });
  }

  async finalizeOrphan(orphan: PartnerDispatchOrphanRow): Promise<"completed" | "waiting"> {
    const row = this.#load(orphan.dispatchAttemptId);
    if (row === undefined || attemptTerminal(row.status)) return "completed";
    const prepared: PreparedDispatch = {
      actionId: row.action_id,
      attemptCount: 0,
      dispatchAttemptId: row.dispatch_attempt_id,
      ...(row.instance_id === null ? {} : { instanceId: row.instance_id }),
      kind: row.kind,
      outboxId: "",
    };
    if (row.kind === "LOCAL_PI") {
      const fresh = orphan.instanceStatus;
      if (fresh === "BUSY") return "waiting";
      if (fresh === "IDLE") {
        try {
          const output = await this.run(prepared);
          if (output.kind === "waiting_remote") return "waiting";
          await this.complete({ output, prepared });
          return "completed";
        } catch (error) {
          const failure = classifyPartnerRunFailure(error, { phase: "RECOVERY", sideEffectState: "UNKNOWN" });
          await this.#complete(row, "UNKNOWN", { artifacts: [], body: safePartnerRunFailureBody(failure) });
          return "completed";
        }
      }
      const failure = classifyPartnerRunFailure({ code: "orphan_terminal_state_unknown" }, { phase: "RECOVERY", sideEffectState: "UNKNOWN" });
      await this.#complete(row, "UNKNOWN", { artifacts: [], body: safePartnerRunFailureBody(failure) });
      return "completed";
    }
    const output = await this.run(prepared);
    if (output.kind === "waiting_remote") return "waiting";
    await this.complete({ output, prepared });
    return "completed";
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
        const failure = classifyPartnerRunFailure(error, { phase: "EXECUTION", sideEffectState: "UNKNOWN" });
        await this.#complete(failedRow, "UNKNOWN", { artifacts: [], body: safePartnerRunFailureBody(failure) });
      }
      return;
    }
    if (output.kind === "waiting_remote") throw new Error("partner_dispatch_not_terminal");
    await this.complete({ output, prepared });
  }

  #load(dispatchAttemptId: string): DispatchRow | undefined {
    return this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT a.dispatch_attempt_id, a.action_id, a.status, a.partner_revision_id, a.instance_id,
             w.work_id, w.workbench_id, w.input_id, w.title, w.intent_json, i.body AS source_request,
             COALESCE(ap.access_mode, w.access_mode) AS access_mode,
             b.workspace_ref, b.status AS workspace_status,
             p.partner_id, p.kind, p.legacy_agent_connection_id AS agent_connection_id,
             (SELECT invocation_id FROM invocations WHERE message_id = a.action_id) AS invocation_id,
             pr.run_id, pr.status AS run_status, pr.context_snapshot_id
        FROM dispatch_attempts a
        JOIN work_items w ON w.work_id = a.work_id
        JOIN joi_inbox_messages i ON i.input_id = w.input_id
        JOIN partner_revisions r ON r.partner_revision_id = a.partner_revision_id
        JOIN partners p ON p.partner_id = r.partner_id
        LEFT JOIN work_access_policies ap ON ap.work_id = w.work_id
        LEFT JOIN workbench_workspace_bindings b ON b.workbench_id = w.workbench_id
        LEFT JOIN partner_runs pr ON pr.dispatch_attempt_id = a.dispatch_attempt_id
       WHERE a.dispatch_attempt_id = ?`).get(dispatchAttemptId)) as DispatchRow | undefined;
  }

  async #ensureRun(row: DispatchRow): Promise<void> {
    const now = this.dependencies.clock.now().toISOString();
    const runId = `partner_run:${row.action_id}`;
    const externalRunId = row.kind === "LOCAL_PI" ? `local_pi:${row.action_id}` : `a2a:${row.action_id}`;
    const snapshot = await this.dependencies.contextAssembler.assemble({ workbenchId: row.workbench_id, workId: row.work_id });
    this.dependencies.database.transaction((connection) => {
      connection.prepare(`INSERT INTO partner_runs
        (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind,
         external_run_id, status, created_at, updated_at, context_snapshot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)`
      ).run(
        runId, row.dispatch_attempt_id, row.action_id, row.workbench_id, row.work_id, row.partner_revision_id,
        row.kind, externalRunId, now, now, snapshot.contextSnapshotId,
      );
      if (row.kind === "A2A") connection.prepare(`INSERT OR IGNORE INTO workbench_agent_sessions
        (agent_id, workbench_id, partner_id, partner_revision_id, backing_kind, backing_id, session_policy, created_at)
        VALUES (?, ?, ?, ?, 'A2A_RUN', ?, 'EPHEMERAL', ?)`
      ).run(`a2a_agent:${runId}`, row.workbench_id, row.partner_id, row.partner_revision_id, runId, now);
    });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.run.created", {
      actionId: row.action_id,
      ...(row.kind === "A2A" ? { agentId: `a2a_agent:${runId}` } : {}),
      workbenchId: row.workbench_id,
      dispatchAttemptId: row.dispatch_attempt_id,
      kind: row.kind,
      runId,
      workId: row.work_id,
    });
  }

  async #complete(row: DispatchRow, status: PartnerRunStatus, output: {
    artifacts: { artifactRef?: string; mimeType?: string; name: string; size: number }[];
    body: string;
    conversation?: AgentConversationDraft[];
  }): Promise<{ isAuthoritative: boolean; resultId: string }> {
    const current = this.#load(row.dispatch_attempt_id);
    if (current !== undefined && attemptTerminal(current.status)) return { isAuthoritative: false, resultId: "" };
    row = current ?? row;
    const now = this.dependencies.clock.now().toISOString();
    const runId = row.run_id ?? `partner_run:${row.action_id}`;
    const brief = workBrief(row.intent_json);
    let verification = { status: "NOT_REQUIRED" as const } as Awaited<ReturnType<WorkVerifier["verify"]>>;
    let committedStatus = status;
    if (status === "COMPLETED" && brief.acceptanceChecks.length > 0) {
      verification = row.context_snapshot_id === null
        ? { reasonCode: "verification_context_missing", status: "FAILED" }
        : this.dependencies.verifier === undefined
          ? { reasonCode: "verification_unavailable", status: "FAILED" }
          : await this.dependencies.verifier.verify({
            acceptanceChecks: brief.acceptanceChecks,
            artifacts: output.artifacts,
            body: output.body,
            contextSnapshotId: row.context_snapshot_id,
          });
      if (verification.status !== "PASSED") committedStatus = "FAILED";
    }
    const recorded = await this.dependencies.results.record(createWorkResult({
      actionId: row.action_id,
      artifacts: output.artifacts,
      workbenchId: row.workbench_id,
      body: output.body,
      createdAt: now,
      ...(row.instance_id === null ? {} : { instanceId: row.instance_id }),
      isLate: false,
      partnerRevisionId: row.partner_revision_id,
      resultId: `work_result:${runId}:${committedStatus}`,
      runId,
      status: committedStatus,
      ...(verification.status === "FAILED" ? { summary: `Work verification failed (${verification.reasonCode ?? "verification_failed"}).` } : {}),
      verification,
      workId: row.work_id,
    }));
    const agentId = row.kind === "A2A" ? `a2a_agent:${runId}` : row.instance_id;
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.result.recorded", {
      actionId: row.action_id,
      ...(agentId === null ? {} : { agentId }),
      workbenchId: row.workbench_id,
      dispatchAttemptId: row.dispatch_attempt_id,
      isLate: recorded.result.isLate,
      isAuthoritative: recorded.isAuthoritative,
      resultId: recorded.result.resultId,
      runId,
      status: committedStatus,
      workId: row.work_id,
    });
    if (agentId !== null && this.dependencies.agentConversations !== undefined) {
      const fallback: AgentConversationDraft[] = [
        { kind: "MARKDOWN", role: "USER", text: taskProjection(row) },
        ...(output.body === "" ? [] : [{ kind: committedStatus === "FAILED" ? "ERROR" as const : "MARKDOWN" as const, role: "AGENT" as const, text: output.body }]),
      ];
      const artifacts: AgentConversationDraft[] = output.artifacts.map((artifact) => ({
          artifact: { mimeType: artifact.mimeType ?? "application/octet-stream", name: artifact.name, size: artifact.size },
          kind: "ARTIFACT" as const,
          role: "AGENT" as const,
        }));
      await this.dependencies.agentConversations.append(agentId, normalizeAgentConversationEntries(
        { agentId, runId, startedAt: now }, [...(output.conversation ?? fallback), ...artifacts],
      ));
    }
    await this.dependencies.leases.release(row.work_id);
    if (recorded.isAuthoritative) {
      await this.dependencies.publish?.(recorded.event);
    }
    return { isAuthoritative: recorded.isAuthoritative, resultId: recorded.result.resultId };
  }
}
