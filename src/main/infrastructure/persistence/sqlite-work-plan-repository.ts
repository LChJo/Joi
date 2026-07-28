/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { CommittedWorkPlan, WorkPlanRepository, WorkQuery } from "../../application/ports/work-orchestration.js";
import type { WorkItemDto } from "../../../shared/joi.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

export class SqliteWorkPlanRepository implements WorkPlanRepository, WorkQuery {
  constructor(private readonly database: TransactionalDatabase) {}

  async commit(plan: CommittedWorkPlan): Promise<void> {
    this.database.transaction((connection) => {
      const insertWork = connection.prepare(`INSERT INTO work_items
        (work_id, avatar_id, title, intent_json, access_mode, workspace_ref, status, created_at, updated_at)
        VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?)`);
      for (const item of plan.items) insertWork.run(
        item.workId, item.avatarId, item.title, item.accessMode, item.workspaceRef ?? null,
        item.status, item.createdAt, item.updatedAt,
      );
      const insertDependency = connection.prepare("INSERT INTO work_dependencies (work_id, depends_on_work_id) VALUES (?, ?)");
      for (const dependency of plan.dependencies) insertDependency.run(dependency.workId, dependency.dependsOnWorkId);
      connection.prepare(`INSERT INTO dispatch_plans
        (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        plan.dispatchPlanId, plan.turnId,
        JSON.stringify({ workIds: plan.items.map((item) => item.workId), waves: plan.waves }),
        JSON.stringify(plan.policyResults), plan.createdAt,
      );
      const insertOutbox = connection.prepare(`INSERT INTO outbox
        (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
        VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`);
      const insertAttempt = connection.prepare(`INSERT INTO dispatch_attempts
        (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision,
         action_id, outbox_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`);
      for (const attempt of plan.attempts) {
        insertOutbox.run(
          attempt.outbox.outboxId, attempt.outbox.kind, JSON.stringify(attempt.outbox.payload),
          attempt.outbox.availableAt, plan.createdAt,
        );
        insertAttempt.run(
          attempt.dispatchAttemptId, plan.dispatchPlanId, attempt.workId, attempt.partnerRevisionId,
          attempt.registryRevision, attempt.actionId, attempt.outbox.outboxId, plan.createdAt, plan.createdAt,
        );
      }
    });
  }

  async listActive(): Promise<WorkItemDto[]> {
    return this.database.transaction((connection) => connection.prepare(`
      SELECT work_id, avatar_id, title, status FROM work_items
       WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELED')
       ORDER BY created_at, work_id`).all()).map((value) => {
      const row = value as Record<string, unknown>;
      if (typeof row.work_id !== "string" || typeof row.avatar_id !== "string"
        || typeof row.title !== "string" || typeof row.status !== "string") throw new Error("work_item_record_invalid");
      return { avatarId: row.avatar_id, status: row.status as WorkItemDto["status"], title: row.title, workId: row.work_id };
    });
  }
}
