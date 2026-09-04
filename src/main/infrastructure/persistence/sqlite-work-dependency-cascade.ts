import type { DatabaseSync } from "node:sqlite";

/**
 * Deterministically cancels the downstream closure of a Work that ended in FAILED or
 * CANCELED: a declared successor can never run once its predecessor has failed. Also
 * settles the canceled Works' dispatch rows so no claimable residue remains. Runs
 * inside the caller's transaction and returns the canceled work ids (bounded).
 */
export function cascadeDependencyCancellation(
  connection: DatabaseSync,
  input: { cancelReason: string; now: string; workId: string },
): string[] {
  const cancellable = (connection.prepare(`
    WITH RECURSIVE downstream(work_id) AS (
      SELECT work_id FROM work_dependencies WHERE depends_on_work_id = ?
      UNION
      SELECT d.work_id FROM work_dependencies d
      JOIN downstream ON downstream.work_id = d.depends_on_work_id
    )
    SELECT ds.work_id AS work_id
      FROM downstream ds
      JOIN work_items w ON w.work_id = ds.work_id
     WHERE w.status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING')`).all(input.workId) as { work_id?: unknown }[])
    .map((row) => String(row.work_id));
  if (cancellable.length === 0) return [];
  const placeholders = cancellable.map(() => "?").join(", ");
  connection.prepare(`UPDATE work_items
    SET status = 'CANCELED', cancel_reason = ?, updated_at = ?
  WHERE work_id IN (${placeholders})`).run(input.cancelReason, input.now, ...cancellable);
  connection.prepare(`UPDATE dispatch_attempts
    SET status = 'FAILED', updated_at = ?
  WHERE work_id IN (${placeholders}) AND status NOT IN ('COMPLETED', 'FAILED', 'UNKNOWN')`).run(
    input.now, ...cancellable,
  );
  connection.prepare(`UPDATE outbox SET status = 'DONE', claim_owner = NULL, claim_until = NULL
  WHERE outbox_id IN (
    SELECT a.outbox_id FROM dispatch_attempts a
    WHERE a.work_id IN (${placeholders}) AND a.outbox_id IS NOT NULL
  ) AND status IN ('PENDING', 'CLAIMED')`).run(...cancellable);
  return cancellable.slice(0, 32);
}
