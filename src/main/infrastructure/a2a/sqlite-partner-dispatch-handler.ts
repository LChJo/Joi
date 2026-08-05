import type { DatabaseSync } from "node:sqlite";

import type { A2aGatewayService } from "../../application/a2a/a2a-gateway-service.js";
import type { PartnerInstanceManager } from "../../application/partners/partner-instance-manager.js";
import { normalizeAgentConversationEntries, type AgentConversationDraft } from "../../application/partners/agent-conversation-presentation.js";
import type { AvatarAgentRepository } from "../../application/ports/avatar-agents.js";
import type { InvocationStatus } from "../../application/ports/a2a-ports.js";
import type { PartnerExecutor, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerRegistryRepository } from "../../application/ports/partner-registry.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";
import type { Clock, OutboxRecord, SseEvent } from "../../application/ports/runtime-store.js";
import type { AvatarContextAssembler } from "../../application/joi/avatar-context-assembler.js";
import type { AvatarExecutionContextReader } from "../../application/ports/avatar-context.js";
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
  avatar_id: string;
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

function taskProjection(row: DispatchRow): string {
  const brief = workBrief(row.intent_json);
  const checks = brief.acceptanceChecks.map((check) => {
    if (check.kind === "ARTIFACT_PRESENT") return `ARTIFACT_PRESENT ${check.name}`;
    if (check.kind === "FILE_EXISTS") return `FILE_EXISTS ${check.relativePath}`;
    return `FILE_CONTAINS_EXACT ${check.relativePath} = ${check.expectedText}`;
  });
  return [
    `Work title: ${row.title}`,
    `Original user request (authoritative):\n${row.source_request}`,
    ...(brief.instructions === undefined ? [] : [`Additional instructions:\n${brief.instructions}`]),
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

export class SqliteA2aPartnerDispatchHandler {
  constructor(private readonly dependencies: {
    agentConversations?: Pick<AvatarAgentRepository, "append">;
    clock: Clock;
    contextAssembler: Pick<AvatarContextAssembler, "assemble">;
    contexts: AvatarExecutionContextReader;
    database: TransactionalDatabase;
    diagnostics?: RuntimeDiagnostics;
    gateway: Pick<A2aGatewayService, "recover" | "startWithResult">;
    instances?: Pick<PartnerInstanceManager, "dispatch">;
    leases: Pick<SqliteWorkspaceLeaseManager, "acquire" | "release">;
    local: PartnerExecutor;
    onResult?: (event: { avatarId: string; committedEvent: SseEvent; eventId: string; isLate: boolean; partnerId: string; resultId: string; sessionDataSource: string; status: PartnerRunStatus; summary: string; title: string; workId: string }) => Promise<void>;
    partners: Pick<PartnerRegistryRepository, "getRevision">;
    results: WorkResultRepository;
    verifier?: WorkVerifier;
  }) {}

  async handle(record: OutboxRecord): Promise<void> {
    const dispatchAttemptId = record.payload.dispatchAttemptId;
    const actionId = record.payload.actionId;
    if (typeof dispatchAttemptId !== "string" || typeof actionId !== "string") throw new Error("partner_dispatch_payload_invalid");
    let row = this.#load(dispatchAttemptId);
    if (row?.action_id !== actionId) throw new Error("partner_dispatch_attempt_invalid");
    if (attemptTerminal(row.status)) {
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.dispatch.skipped", {
        actionId,
        dispatchAttemptId,
        outboxId: record.outboxId,
        status: row.status,
      });
      return;
    }
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.dispatch.started", {
      actionId,
      avatarId: row.avatar_id,
      dispatchAttemptId,
      kind: row.kind,
      outboxId: record.outboxId,
      partnerId: row.partner_id,
      partnerRevisionId: row.partner_revision_id,
      workId: row.work_id,
    });

    if (row.access_mode !== "NONE") {
      if (row.kind === "A2A") {
        await this.#ensureRun(row);
        row = this.#load(dispatchAttemptId) ?? row;
        await this.#complete(row, "FAILED", { artifacts: [], body: "Remote partners cannot execute Avatar file work." });
        return;
      }
      if (row.workspace_status !== "READY" || row.workspace_ref === null) throw new Error("avatar_workspace_not_ready");
      const lease = await this.dependencies.leases.acquire({
        accessMode: row.access_mode,
        workId: row.work_id,
        workspaceRef: row.workspace_ref,
      });
      if (lease === null) throw new Error("workspace_lease_conflict");
    }

    const runWasPresent = row.run_id !== null;
    if (!runWasPresent) {
      await this.#ensureRun(row);
      row = this.#load(dispatchAttemptId);
      if (row?.run_id === undefined || row.run_id === null) throw new Error("partner_run_create_failed");
    }
    const revision = await this.dependencies.partners.getRevision(row.partner_revision_id);
    if (revision === null) {
      await this.#complete(row, "FAILED", { artifacts: [], body: "The pinned partner revision is unavailable." });
      return;
    }
    if (row.context_snapshot_id === null) throw new Error("avatar_context_snapshot_not_found");

    if (runWasPresent && row.run_status === "RUNNING" && row.kind === "LOCAL_PI" && row.instance_id === null) {
      // A crashed legacy single-shot run is not resumable; instance-linked attempts resume via the manager below.
      await this.#complete(row, "UNKNOWN", { artifacts: [], body: "The previous local run could not be resumed safely." });
      return;
    }

    if (row.kind === "LOCAL_PI") {
      const payloadInstance = record.payload.instanceId;
      const payloadPolicy = record.payload.sessionPolicy;
      const instanceId = typeof payloadInstance === "string" ? payloadInstance : undefined;
      const sessionPolicy = payloadPolicy === "EPHEMERAL" || payloadPolicy === "RESIDENT" ? payloadPolicy : undefined;
      if (this.dependencies.instances !== undefined) {
        let result: Awaited<ReturnType<PartnerInstanceManager["dispatch"]>>;
        try {
          result = await this.dependencies.instances.dispatch({
            dispatchAttemptId: row.dispatch_attempt_id,
            ...(instanceId === undefined ? {} : { instanceId }),
            request: {
              actionId: row.action_id, avatarId: row.avatar_id, contextSnapshotId: row.context_snapshot_id,
              taskProjection: taskProjection(row), workId: row.work_id,
            },
            revision,
            ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
          });
        } catch {
          const linked = this.#load(row.dispatch_attempt_id);
          await this.#complete(linked ?? row, "UNKNOWN", { artifacts: [], body: "The local partner run ended without a reliable terminal output." });
          return;
        }
        // The instance manager links dispatch_attempts.instance_id during dispatch; reload so the
        // result event records the real session data source instead of the pre-dispatch snapshot.
        const linked = this.#load(row.dispatch_attempt_id);
        await this.#complete(linked ?? row, result.status, {
          artifacts: result.artifacts,
          body: result.body,
          ...(result.conversation === undefined ? {} : { conversation: result.conversation }),
        });
        return;
      }
      let result: Awaited<ReturnType<PartnerExecutor["run"]>>;
      try {
        result = await this.dependencies.local.run({
          actionId: row.action_id,
          avatarId: row.avatar_id,
          contextSnapshotId: row.context_snapshot_id,
          taskProjection: taskProjection(row),
          workId: row.work_id,
        }, revision);
      } catch {
        await this.#complete(row, "UNKNOWN", { artifacts: [], body: "The local partner run ended without a reliable terminal output." });
        return;
      }
      await this.#complete(row, result.status, { artifacts: result.artifacts, body: result.body });
      return;
    }

    if (row.agent_connection_id === null) {
      await this.#complete(row, "FAILED", { artifacts: [], body: "The remote partner connection is unavailable." });
      return;
    }
    const execution = await this.dependencies.contexts.loadForExecution(row.context_snapshot_id);
    if (execution === null) throw new Error("avatar_context_snapshot_not_found");
    const privateTaskProjection = taskProjection(row);
    const started = row.invocation_id === null
      ? await this.dependencies.gateway.startWithResult({
        agentConnectionId: row.agent_connection_id,
        capacity: { lane: "collaborator", lifeId: row.avatar_id },
        messageId: row.action_id,
        parts: [
          { kind: "text", text: privateTaskProjection },
          { data: { actionId: row.action_id, avatarId: row.avatar_id, context: execution.sanitized, sourceBoundary: "joi-work", workId: row.work_id }, kind: "data" },
        ],
      })
      : { invocation: await this.dependencies.gateway.recover(row.invocation_id), output: { artifacts: [], parts: [] } };
    const invocation = started.invocation;
    const terminal = terminalInvocation(invocation.status);
    if (terminal === null) throw new Error("partner_dispatch_not_terminal");
    const body = [
      ...started.output.parts.flatMap((part) => {
        const candidate = part as { data?: unknown; kind?: unknown; text?: unknown };
        if (typeof candidate.text === "string") return [candidate.text];
        if (candidate.kind === "text" && typeof candidate.data === "string") return [candidate.data];
        return [];
      }),
      ...started.output.artifacts.map((artifact) => artifact.text),
    ].join("\n");
    await this.#complete(row, terminal, { artifacts: [], body });
  }

  #load(dispatchAttemptId: string): DispatchRow | undefined {
    return this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT a.dispatch_attempt_id, a.action_id, a.status, a.partner_revision_id, a.instance_id,
             w.work_id, w.avatar_id, w.input_id, w.title, w.intent_json, i.body AS source_request,
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
        LEFT JOIN avatar_workspace_bindings b ON b.avatar_id = w.avatar_id
        LEFT JOIN partner_runs pr ON pr.dispatch_attempt_id = a.dispatch_attempt_id
       WHERE a.dispatch_attempt_id = ?`).get(dispatchAttemptId)) as DispatchRow | undefined;
  }

  async #ensureRun(row: DispatchRow): Promise<void> {
    const now = this.dependencies.clock.now().toISOString();
    const runId = `partner_run:${row.action_id}`;
    const externalRunId = row.kind === "LOCAL_PI" ? `local_pi:${row.action_id}` : `a2a:${row.action_id}`;
    const snapshot = await this.dependencies.contextAssembler.assemble({ avatarId: row.avatar_id, workId: row.work_id });
    this.dependencies.database.transaction((connection) => {
      connection.prepare(`INSERT INTO partner_runs
        (run_id, dispatch_attempt_id, action_id, avatar_id, work_id, partner_revision_id, kind,
         external_run_id, status, created_at, updated_at, context_snapshot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)`
      ).run(
        runId, row.dispatch_attempt_id, row.action_id, row.avatar_id, row.work_id, row.partner_revision_id,
        row.kind, externalRunId, now, now, snapshot.contextSnapshotId,
      );
      if (row.kind === "A2A") connection.prepare(`INSERT OR IGNORE INTO avatar_agent_sessions
        (agent_id, avatar_id, partner_id, partner_revision_id, backing_kind, backing_id, session_policy, created_at)
        VALUES (?, ?, ?, ?, 'A2A_RUN', ?, 'EPHEMERAL', ?)`
      ).run(`a2a_agent:${runId}`, row.avatar_id, row.partner_id, row.partner_revision_id, runId, now);
    });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.run.created", {
      actionId: row.action_id,
      ...(row.kind === "A2A" ? { agentId: `a2a_agent:${runId}` } : {}),
      avatarId: row.avatar_id,
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
  }): Promise<void> {
    const current = this.#load(row.dispatch_attempt_id);
    if (current !== undefined && attemptTerminal(current.status)) return;
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
            contextSnapshotId: row.context_snapshot_id,
          });
      if (verification.status !== "PASSED") committedStatus = "FAILED";
    }
    const eventId = `partner_result:${runId}:${committedStatus}`;
    const recorded = await this.dependencies.results.record(createWorkResult({
      actionId: row.action_id,
      artifacts: output.artifacts,
      avatarId: row.avatar_id,
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
      avatarId: row.avatar_id,
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
    const sessionDataSource = row.kind === "LOCAL_PI"
      ? (row.instance_id !== null ? `partner_instance_messages:${row.instance_id}` : `local_pi:${row.action_id}`)
      : (row.invocation_id !== null ? `a2a_invocations:${row.invocation_id}` : `a2a:${row.action_id}`);
    if (recorded.isAuthoritative) await this.dependencies.onResult?.({
      avatarId: row.avatar_id,
      committedEvent: recorded.event,
      eventId,
      isLate: recorded.result.isLate,
      partnerId: row.partner_id,
      resultId: recorded.result.resultId,
      sessionDataSource,
      status: committedStatus,
      summary: recorded.result.summary,
      title: row.title,
      workId: row.work_id,
    });
  }
}
