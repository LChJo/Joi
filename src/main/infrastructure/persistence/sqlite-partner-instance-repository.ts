/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { PartnerInstanceRecord, PartnerInstanceRepository, PartnerInstanceStatus, SessionPolicy } from "../../application/ports/partner-instances.js";
import type { PartnerEngine } from "../../domain/partners/partner.js";
import { mapStoredEngine, storageCliProtocol, storageEngine } from "./partner-engine-storage.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function mapRow(row: Row): PartnerInstanceRecord {
  if (typeof row.instance_id !== "string" || typeof row.workbench_id !== "string" || typeof row.partner_id !== "string" || typeof row.partner_revision_id !== "string"
    || typeof row.session_policy !== "string" || typeof row.status !== "string" || typeof row.engine !== "string"
    || typeof row.created_at !== "string" || typeof row.last_used_at !== "string") throw new Error("partner_instance_record_invalid");
  return {
    workbenchId: row.workbench_id,
    createdAt: row.created_at,
    ...(typeof row.disposed_at === "string" ? { disposedAt: row.disposed_at } : {}),
    ...(typeof row.disposal_reason === "string" ? { disposalReason: row.disposal_reason } : {}),
    engine: mapStoredEngine(row.engine, row.cli_protocol),
    ...(typeof row.external_session_ref === "string" ? { externalSessionRef: row.external_session_ref } : {}),
    instanceId: row.instance_id,
    lastUsedAt: row.last_used_at,
    partnerId: row.partner_id,
    partnerRevisionId: row.partner_revision_id,
    sessionPolicy: row.session_policy as SessionPolicy,
    status: row.status as PartnerInstanceStatus,
  };
}

const SELECT_INSTANCES = `SELECT instance_id, workbench_id, partner_id, partner_revision_id, session_policy, status, engine, cli_protocol,
  external_session_ref, created_at, last_used_at, disposed_at, disposal_reason FROM partner_instances`;

export class SqlitePartnerInstanceRepository implements PartnerInstanceRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  // Both caps bound RESIDENT instances only (see PartnerInstanceManager limits); EPHEMERAL
  // instances are created freely for one-shot dispatch and must not consume the resident
  // quota, so only RESIDENT rows are counted.
  async countActive(workbenchId: string, partnerId: string): Promise<number> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT COUNT(*) AS count FROM partner_instances WHERE workbench_id = ? AND partner_id = ? AND session_policy = 'RESIDENT' AND status <> 'DISPOSED'",
    ).get(workbenchId, partnerId)) as { count: number };
    return row.count;
  }

  async countActiveGlobal(): Promise<number> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT COUNT(*) AS count FROM partner_instances WHERE session_policy = 'RESIDENT' AND status <> 'DISPOSED'",
    ).get()) as { count: number };
    return row.count;
  }

  async create(input: { workbenchId: string; createdAt: string; engine: PartnerEngine; instanceId: string; partnerId: string; partnerRevisionId: string; sessionPolicy: SessionPolicy }): Promise<PartnerInstanceRecord> {
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO partner_instances
        (instance_id, workbench_id, partner_id, partner_revision_id, session_policy, status, engine, cli_protocol, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, 'IDLE', ?, ?, ?, ?)`).run(
        input.instanceId, input.workbenchId, input.partnerId, input.partnerRevisionId, input.sessionPolicy,
        storageEngine(input.engine), storageCliProtocol(input.engine), input.createdAt, input.createdAt,
      );
      connection.prepare(`INSERT INTO workbench_agent_sessions
        (agent_id, workbench_id, partner_id, partner_revision_id, backing_kind, backing_id, session_policy, created_at)
        VALUES (?, ?, ?, ?, 'LOCAL_INSTANCE', ?, ?, ?)`).run(
        input.instanceId, input.workbenchId, input.partnerId, input.partnerRevisionId,
        input.instanceId, input.sessionPolicy, input.createdAt,
      );
    });
    const record = await this.get(input.instanceId);
    if (record === null) throw new Error("partner_instance_create_failed");
    return record;
  }

  async get(instanceId: string): Promise<PartnerInstanceRecord | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      `${SELECT_INSTANCES} WHERE instance_id = ?`,
    ).get(instanceId)) as Row | undefined;
    return row === undefined ? null : mapRow(row);
  }

  async linkDispatch(dispatchAttemptId: string, instanceId: string): Promise<void> {
    this.database.transaction((connection) => connection.prepare(
      "UPDATE dispatch_attempts SET instance_id = ? WHERE dispatch_attempt_id = ?",
    ).run(instanceId, dispatchAttemptId));
  }

  async listActive(filter?: { workbenchId?: string; partnerId?: string }): Promise<PartnerInstanceRecord[]> {
    const clauses = ["status <> 'DISPOSED'"];
    const values: string[] = [];
    if (filter?.workbenchId !== undefined) { clauses.push("workbench_id = ?"); values.push(filter.workbenchId); }
    if (filter?.partnerId !== undefined) { clauses.push("partner_id = ?"); values.push(filter.partnerId); }
    const rows = this.database.transaction((connection) => connection.prepare(
      `${SELECT_INSTANCES} WHERE ${clauses.join(" AND ")} ORDER BY created_at`,
    ).all(...values));
    return rows.map((row) => mapRow(row as Row));
  }

  async markDisposed(instanceId: string, reason: string, at: string): Promise<void> {
    this.database.transaction((connection) => connection.prepare(
      "UPDATE partner_instances SET status = 'DISPOSED', disposal_reason = ?, disposed_at = ?, last_used_at = ? WHERE instance_id = ?",
    ).run(reason, at, at, instanceId));
  }

  async markTurnComplete(instanceId: string, at: string, externalSessionRef?: string): Promise<void> {
    this.database.transaction((connection) => {
      if (externalSessionRef === undefined) {
        connection.prepare("UPDATE partner_instances SET status = 'IDLE', last_used_at = ? WHERE instance_id = ?").run(at, instanceId);
      } else {
        connection.prepare("UPDATE partner_instances SET status = 'IDLE', last_used_at = ?, external_session_ref = ? WHERE instance_id = ?").run(at, externalSessionRef, instanceId);
      }
    });
  }

  async recoverCrashed(at: string): Promise<{ ephemeralDisposed: number; residentRecovered: number }> {
    return this.database.transaction((connection) => {
      const recovered = connection.prepare(
        "UPDATE partner_instances SET status = 'IDLE', last_used_at = ? WHERE status = 'BUSY' AND session_policy = 'RESIDENT'",
      ).run(at).changes;
      const disposed = connection.prepare(
        "UPDATE partner_instances SET status = 'DISPOSED', disposal_reason = 'crash', disposed_at = ?, last_used_at = ? WHERE status = 'BUSY' AND session_policy = 'EPHEMERAL'",
      ).run(at, at).changes;
      return { ephemeralDisposed: Number(disposed), residentRecovered: Number(recovered) };
    });
  }

  async setStatusBusy(instanceId: string, at: string): Promise<boolean> {
    return this.database.transaction((connection) => connection.prepare(
      "UPDATE partner_instances SET status = 'BUSY', last_used_at = ? WHERE instance_id = ? AND status = 'IDLE'",
    ).run(at, instanceId).changes === 1);
  }
}
