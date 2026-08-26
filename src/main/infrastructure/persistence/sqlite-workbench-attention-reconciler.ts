/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { WorkbenchAttentionReconciler } from "../../application/ports/workbench-attention.js";

interface TransactionalDatabase { transaction<T>(operation: (database: DatabaseSync) => T): T }

/** Repairs the invariant WAITING_INPUT => one persisted OPEN user action. */
export class SqliteWorkbenchAttentionReconciler implements WorkbenchAttentionReconciler {
  constructor(private readonly database: TransactionalDatabase) {}

  async reconcile(input: { prompt: string; reasonCode: string; workbenchId: string }): Promise<number> {
    return this.database.transaction((connection) => {
      const now = new Date().toISOString();
      const candidates = connection.prepare(`SELECT w.input_id, w.work_id, pr.run_id, pr.status AS run_status
        FROM work_items w
        JOIN partner_runs pr ON pr.work_id = w.work_id
        JOIN joi_inbox_messages i ON i.input_id = w.input_id
        WHERE w.workbench_id = ? AND w.status = 'WAITING'
          AND pr.status IN ('WAITING_INPUT', 'WAITING_AUTH')
          AND i.dismissed_at IS NULL AND i.canceled_at IS NULL AND i.failed_at IS NULL
          AND pr.run_id = (
            SELECT pr2.run_id FROM partner_runs pr2
            JOIN work_items w2 ON w2.work_id = pr2.work_id
            WHERE w2.input_id = w.input_id AND w2.status = 'WAITING'
              AND pr2.status IN ('WAITING_INPUT', 'WAITING_AUTH')
            ORDER BY pr2.updated_at DESC, pr2.run_id DESC LIMIT 1
          )
          AND NOT EXISTS (SELECT 1 FROM joi_user_action_requests a
            WHERE a.input_id = w.input_id AND a.status IN ('OPEN', 'RESOLVED'))
        ORDER BY pr.updated_at, pr.run_id LIMIT 20`).all(input.workbenchId) as {
          input_id?: unknown;
          run_id?: unknown;
          run_status?: unknown;
          work_id?: unknown;
        }[];
      const insert = connection.prepare(`INSERT OR IGNORE INTO joi_user_action_requests
        (action_id, input_id, work_id, run_id, kind, status, reason_code, prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'RECOVERY_DECISION', 'OPEN', ?, ?, ?, ?)`);
      let created = 0;
      for (const candidate of candidates) {
        if (typeof candidate.input_id !== "string" || typeof candidate.work_id !== "string" || typeof candidate.run_id !== "string"
          || (candidate.run_status !== "WAITING_INPUT" && candidate.run_status !== "WAITING_AUTH")) {
          throw new Error("workbench_attention_candidate_invalid");
        }
        const requiresAuth = candidate.run_status === "WAITING_AUTH";
        const reasonCode = requiresAuth ? "partner_auth_required" : input.reasonCode;
        const prompt = requiresAuth
          ? "搭档需要重新授权。请先在搭档设置完成授权，然后点击“继续原工作”。"
          : input.prompt;
        const result = insert.run(
          `joi_action:recovery:${candidate.run_id}`,
          candidate.input_id,
          candidate.work_id,
          candidate.run_id,
          reasonCode,
          prompt,
          now,
          now,
        );
        if (result.changes === 0) continue;
        connection.prepare(`UPDATE joi_inbox_messages
          SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = ?, clarification_prompt = ?, updated_at = ?
          WHERE input_id = ? AND dismissed_at IS NULL AND canceled_at IS NULL AND failed_at IS NULL`).run(
          reasonCode, prompt, now, candidate.input_id,
        );
        created += 1;
      }
      return created;
    });
  }
}
