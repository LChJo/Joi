/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { SseEvent } from "../../application/ports/runtime-store.js";
import type { RecordedWorkResult, WorkResultRepository } from "../../application/ports/work-results.js";
import type { WorkResult } from "../../domain/work/work-result.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

const MANAGED_BODY_THRESHOLD_BYTES = 2_000_000;

function workStatus(status: WorkResult["status"]): "COMPLETED" | "FAILED" | "WAITING" {
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "FAILED") return "FAILED";
  return "WAITING";
}

export class SqliteWorkResultRepository implements WorkResultRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async record(result: WorkResult): Promise<RecordedWorkResult> {
    return this.database.transaction((connection) => {
      const current = connection.prepare("SELECT status FROM work_items WHERE work_id = ? AND workbench_id = ?")
        .get(result.workId, result.workbenchId) as { status?: unknown } | undefined;
      if (typeof current?.status !== "string") throw new Error("work_result_work_not_found");
      const isLate = current.status === "CANCELED";
      const authoritativeTerminal = connection.prepare(`SELECT 1 FROM work_results
        WHERE run_id = ? AND is_authoritative = 1 AND status IN ('COMPLETED', 'FAILED', 'UNKNOWN') LIMIT 1`)
        .get(result.runId);
      const isAuthoritative = authoritativeTerminal === undefined;
      const bodySize = Buffer.byteLength(result.body, "utf8");
      const managedBody = bodySize > MANAGED_BODY_THRESHOLD_BYTES;
      const bodyRef = `${managedBody ? "work_result_artifact" : "work_result_body"}:${result.resultId}`;
      const artifacts = managedBody ? [...result.artifacts, {
        artifactRef: bodyRef,
        mimeType: "text/plain; charset=utf-8",
        name: "partner-result.txt",
        size: bodySize,
      }] : result.artifacts;
      connection.prepare("INSERT INTO work_result_bodies (body_ref, body, created_at) VALUES (?, ?, ?)")
        .run(bodyRef, result.body, result.createdAt);
      if (isAuthoritative) connection.prepare("UPDATE work_results SET is_authoritative = 0 WHERE run_id = ?")
        .run(result.runId);
      connection.prepare(`INSERT INTO work_results
        (result_id, run_id, action_id, workbench_id, work_id, partner_revision_id, instance_id, status,
         summary, body_ref, artifacts_json, is_late, is_authoritative, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        result.resultId, result.runId, result.actionId, result.workbenchId, result.workId, result.partnerRevisionId,
        result.instanceId ?? null, result.status, result.summary, bodyRef, JSON.stringify(artifacts), isLate ? 1 : 0,
        isAuthoritative ? 1 : 0, result.createdAt,
      );
      connection.prepare(`INSERT INTO work_result_verifications
        (result_id, status, reason_code, created_at) VALUES (?, ?, ?, ?)`)
        .run(result.resultId, result.verification.status, result.verification.reasonCode ?? null, result.createdAt);
      if (isAuthoritative) {
        connection.prepare("UPDATE partner_runs SET status = ?, updated_at = ? WHERE run_id = ?").run(result.status, result.createdAt, result.runId);
        connection.prepare("UPDATE dispatch_attempts SET status = ?, updated_at = ? WHERE action_id = ?")
          .run(result.status, result.createdAt, result.actionId);
        if (!isLate) connection.prepare("UPDATE work_items SET status = ?, updated_at = ? WHERE work_id = ?")
          .run(workStatus(result.status), result.createdAt, result.workId);
      }
      const active = connection.prepare(`SELECT work_id AS workId, title, status FROM work_items
        WHERE workbench_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING') ORDER BY created_at, work_id`).all(result.workbenchId);
      const recent = connection.prepare(`SELECT result_id AS resultId, work_id AS workId, status, summary FROM work_results
        WHERE workbench_id = ? AND is_authoritative = 1 ORDER BY created_at DESC, result_id DESC LIMIT 10`).all(result.workbenchId);
      connection.prepare(`INSERT INTO workbench_task_projections (workbench_id, active_work_json, recent_results_json, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(workbench_id) DO UPDATE SET active_work_json = excluded.active_work_json,
          recent_results_json = excluded.recent_results_json, updated_at = excluded.updated_at`).run(
        result.workbenchId, JSON.stringify(active), JSON.stringify(recent), result.createdAt,
      );
      const eventId = `partner_result:${result.runId}:${result.status}`;
      if (isAuthoritative) connection.prepare(`INSERT OR IGNORE INTO partner_result_events
          (event_id, run_id, workbench_id, work_id, partner_revision_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(eventId, result.runId, result.workbenchId, result.workId, result.partnerRevisionId, result.status, result.createdAt);
      const payload = {
        workbenchId: result.workbenchId,
        isAuthoritative,
        isLate,
        resultId: result.resultId,
        status: result.status,
        summary: result.summary,
        workId: result.workId,
      };
      // SSE projection frozen (ADR 0009); the event shape is retained for port compatibility.
      const event: SseEvent = {
        createdAt: result.createdAt,
        entityId: result.resultId,
        payload,
        sequence: 0,
        type: "work.result.recorded",
      };
      return { event, isAuthoritative, result: { ...result, artifacts, isLate } };
    });
  }

  async readBody(input: { workbenchId: string; limit: number; offset: number; resultId: string }): Promise<{ body: string; total: number } | null> {
    const row = this.database.transaction((connection) => connection.prepare(`SELECT substr(b.body, ? + 1, ?) AS chunk,
      length(b.body) AS total FROM work_results r JOIN work_result_bodies b ON b.body_ref = r.body_ref
      WHERE r.result_id = ? AND r.workbench_id = ?`).get(input.offset, input.limit, input.resultId, input.workbenchId)) as {
        chunk?: unknown; total?: unknown;
      } | undefined;
    if (typeof row?.chunk !== "string" || typeof row.total !== "number") return null;
    return { body: row.chunk, total: row.total };
  }
}
