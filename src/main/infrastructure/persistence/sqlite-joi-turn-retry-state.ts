import type { DatabaseSync } from "node:sqlite";
import type { JoiTurnRetryState } from "../../application/ports/joi-task.js";

export function joiTurnRetryState(row: Record<string, unknown>): JoiTurnRetryState {
  return {
    failureCount: Number(row.turn_failure_count ?? 0),
    sessionGeneration: Number(row.session_generation ?? 0),
    epoch: Number(row.turn_retry_epoch ?? 0),
    queued: row.status === "PENDING",
    ...(typeof row.turn_failed_at === "string" ? { failedAt: row.turn_failed_at } : {}),
    ...(typeof row.turn_failure_reason_code === "string" ? { reasonCode: row.turn_failure_reason_code } : {}),
    ...(typeof row.turn_retry_at === "string" ? { retryAt: row.turn_retry_at } : {}),
  };
}

export function clearJoiTurnRetryState(connection: DatabaseSync, inputId: string, advanceEpoch = false): void {
  connection.prepare(`UPDATE joi_inbox_messages SET turn_failure_count=0,turn_failed_at=NULL,
    turn_failure_reason_code=NULL,turn_retry_at=NULL,turn_retry_epoch=turn_retry_epoch+?
    WHERE input_id=? AND (turn_failure_count>0 OR ?=1)`).run(advanceEpoch?1:0,inputId,advanceEpoch?1:0);
}
