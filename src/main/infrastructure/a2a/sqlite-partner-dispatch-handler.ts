import type { DatabaseSync } from "node:sqlite";

import type { A2aGatewayService } from "../../application/a2a/a2a-gateway-service.js";
import type { PartnerInstanceManager } from "../../application/partners/partner-instance-manager.js";
import type { InvocationStatus } from "../../application/ports/a2a-ports.js";
import type { PartnerExecutor, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerRegistryRepository } from "../../application/ports/partner-registry.js";
import type { Clock, OutboxRecord } from "../../application/ports/runtime-store.js";
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
  dispatch_attempt_id: string;
  instance_id: string | null;
  invocation_id: string | null;
  kind: "A2A" | "LOCAL_PI";
  partner_id: string;
  partner_revision_id: string;
  run_id: string | null;
  run_status: PartnerRunStatus | "RUNNING" | null;
  status: string;
  title: string;
  work_id: string;
  workspace_ref: string | null;
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

function workStatus(status: PartnerRunStatus): "COMPLETED" | "FAILED" | "WAITING" {
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "FAILED") return "FAILED";
  return "WAITING";
}

export class SqliteA2aPartnerDispatchHandler {
  constructor(private readonly dependencies: {
    clock: Clock;
    database: TransactionalDatabase;
    gateway: Pick<A2aGatewayService, "recover" | "startWithResult">;
    instances?: Pick<PartnerInstanceManager, "dispatch">;
    leases: Pick<SqliteWorkspaceLeaseManager, "acquire" | "release">;
    local: PartnerExecutor;
    onResult?: (event: { avatarId: string; eventId: string; partnerId: string; sessionDataSource: string; status: PartnerRunStatus; title: string; workId: string }) => Promise<void>;
    partners: Pick<PartnerRegistryRepository, "getRevision">;
  }) {}

  async handle(record: OutboxRecord): Promise<void> {
    const dispatchAttemptId = record.payload.dispatchAttemptId;
    const actionId = record.payload.actionId;
    if (typeof dispatchAttemptId !== "string" || typeof actionId !== "string") throw new Error("partner_dispatch_payload_invalid");
    let row = this.#load(dispatchAttemptId);
    if (row?.action_id !== actionId) throw new Error("partner_dispatch_attempt_invalid");
    if (attemptTerminal(row.status)) return;

    if (row.workspace_ref !== null) {
      const lease = await this.dependencies.leases.acquire({
        accessMode: row.access_mode,
        workId: row.work_id,
        workspaceRef: row.workspace_ref,
      });
      if (lease === null) throw new Error("workspace_lease_conflict");
    }

    const revision = await this.dependencies.partners.getRevision(row.partner_revision_id);
    if (revision === null) {
      await this.#complete(row, "FAILED");
      return;
    }
    const runWasPresent = row.run_id !== null;
    if (!runWasPresent) {
      this.#createRun(row);
      row = this.#load(dispatchAttemptId);
      if (row?.run_id === undefined || row.run_id === null) throw new Error("partner_run_create_failed");
    }

    if (runWasPresent && row.run_status === "RUNNING" && row.kind === "LOCAL_PI" && row.instance_id === null) {
      // A crashed legacy single-shot run is not resumable; instance-linked attempts resume via the manager below.
      await this.#complete(row, "UNKNOWN");
      return;
    }

    if (row.kind === "LOCAL_PI") {
      const payloadInstance = record.payload.instanceId;
      const payloadPolicy = record.payload.sessionPolicy;
      const instanceId = typeof payloadInstance === "string" ? payloadInstance : undefined;
      const sessionPolicy = payloadPolicy === "EPHEMERAL" || payloadPolicy === "RESIDENT" ? payloadPolicy : undefined;
      if (this.dependencies.instances !== undefined && (instanceId !== undefined || sessionPolicy !== undefined)) {
        try {
          const result = await this.dependencies.instances.dispatch({
            dispatchAttemptId: row.dispatch_attempt_id,
            ...(instanceId === undefined ? {} : { instanceId }),
            request: { actionId: row.action_id, avatarId: row.avatar_id, taskProjection: row.title, workId: row.work_id },
            revision,
            ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
          });
          // The instance manager links dispatch_attempts.instance_id during dispatch; reload so the
          // result event records the real session data source instead of the pre-dispatch snapshot.
          const linked = this.#load(row.dispatch_attempt_id);
          await this.#complete(linked ?? row, result.status);
        } catch {
          await this.#complete(row, "UNKNOWN");
        }
        return;
      }
      try {
        const result = await this.dependencies.local.run({
          actionId: row.action_id,
          avatarId: row.avatar_id,
          taskProjection: row.title,
          workId: row.work_id,
        }, revision);
        await this.#complete(row, result.status);
      } catch {
        await this.#complete(row, "UNKNOWN");
      }
      return;
    }

    if (row.agent_connection_id === null) {
      await this.#complete(row, "FAILED");
      return;
    }
    const invocation = row.invocation_id === null
      ? (await this.dependencies.gateway.startWithResult({
        agentConnectionId: row.agent_connection_id,
        capacity: { lane: "collaborator", lifeId: row.avatar_id },
        messageId: row.action_id,
        parts: [
          { kind: "text", text: row.title },
          { data: { actionId: row.action_id, avatarId: row.avatar_id, sourceBoundary: "joi-work", workId: row.work_id }, kind: "data" },
        ],
      })).invocation
      : await this.dependencies.gateway.recover(row.invocation_id);
    const terminal = terminalInvocation(invocation.status);
    if (terminal === null) throw new Error("partner_dispatch_not_terminal");
    await this.#complete(row, terminal);
  }

  #load(dispatchAttemptId: string): DispatchRow | undefined {
    return this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT a.dispatch_attempt_id, a.action_id, a.status, a.partner_revision_id, a.instance_id,
             w.work_id, w.avatar_id, w.title, w.access_mode, w.workspace_ref,
             p.partner_id, p.kind, p.legacy_agent_connection_id AS agent_connection_id,
             (SELECT invocation_id FROM invocations WHERE message_id = a.action_id) AS invocation_id,
             pr.run_id, pr.status AS run_status
        FROM dispatch_attempts a
        JOIN work_items w ON w.work_id = a.work_id
        JOIN partner_revisions r ON r.partner_revision_id = a.partner_revision_id
        JOIN partners p ON p.partner_id = r.partner_id
        LEFT JOIN partner_runs pr ON pr.dispatch_attempt_id = a.dispatch_attempt_id
       WHERE a.dispatch_attempt_id = ?`).get(dispatchAttemptId)) as DispatchRow | undefined;
  }

  #createRun(row: DispatchRow): void {
    const now = this.dependencies.clock.now().toISOString();
    const runId = `partner_run:${row.action_id}`;
    const externalRunId = row.kind === "LOCAL_PI" ? `local_pi:${row.action_id}` : `a2a:${row.action_id}`;
    this.dependencies.database.transaction((connection) => connection.prepare(`INSERT INTO partner_runs
      (run_id, dispatch_attempt_id, action_id, avatar_id, work_id, partner_revision_id, kind,
       external_run_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)`
    ).run(
      runId, row.dispatch_attempt_id, row.action_id, row.avatar_id, row.work_id, row.partner_revision_id,
      row.kind, externalRunId, now, now,
    ));
  }

  async #complete(row: DispatchRow, status: PartnerRunStatus): Promise<void> {
    const now = this.dependencies.clock.now().toISOString();
    const runId = row.run_id ?? `partner_run:${row.action_id}`;
    const eventId = `partner_result:${runId}:${status}`;
    this.dependencies.database.transaction((connection) => {
      connection.prepare("UPDATE partner_runs SET status = ?, updated_at = ? WHERE run_id = ?").run(status, now, runId);
      connection.prepare("UPDATE dispatch_attempts SET status = ?, updated_at = ? WHERE dispatch_attempt_id = ?")
        .run(status, now, row.dispatch_attempt_id);
      connection.prepare("UPDATE work_items SET status = ?, updated_at = ? WHERE work_id = ?")
        .run(workStatus(status), now, row.work_id);
      connection.prepare(`INSERT OR IGNORE INTO partner_result_events
        (event_id, run_id, avatar_id, work_id, partner_revision_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(eventId, runId, row.avatar_id, row.work_id, row.partner_revision_id, status, now);
    });
    await this.dependencies.leases.release(row.work_id);
    const sessionDataSource = row.kind === "LOCAL_PI"
      ? (row.instance_id !== null ? `partner_instance_messages:${row.instance_id}` : `local_pi:${row.action_id}`)
      : (row.invocation_id !== null ? `a2a_invocations:${row.invocation_id}` : `a2a:${row.action_id}`);
    await this.dependencies.onResult?.({
      avatarId: row.avatar_id,
      eventId,
      partnerId: row.partner_id,
      sessionDataSource,
      status,
      title: row.title,
      workId: row.work_id,
    });
  }
}
