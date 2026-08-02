/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type {
  CommittedWorkPlan,
  ReassignedWorkPlan,
  WorkPlanRepository,
  WorkQuery,
  WorkReassignmentContext,
  WorkReassignmentRepository,
} from "../../application/ports/work-orchestration.js";
import type { WorkItemDto } from "../../../shared/joi.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

export class SqliteWorkPlanRepository implements WorkPlanRepository, WorkQuery, WorkReassignmentRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async commit(plan: CommittedWorkPlan): Promise<void> {
    this.database.transaction((connection) => {
      const insertWork = connection.prepare(`INSERT INTO work_items
        (work_id, avatar_id, title, intent_json, access_mode, workspace_ref, status, created_at, updated_at)
        VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?)`);
      for (const item of plan.items) insertWork.run(
        item.workId, item.avatarId, item.title, item.accessMode === "NONE" ? "READ" : item.accessMode, null,
        item.status, item.createdAt, item.updatedAt,
      );
      const insertAccess = connection.prepare("INSERT INTO work_access_policies (work_id, access_mode) VALUES (?, ?)");
      for (const item of plan.items) insertAccess.run(item.workId, item.accessMode);
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
      const avatarId = plan.items[0]?.avatarId;
      if (avatarId !== undefined) {
        const active = connection.prepare(`SELECT work_id AS workId, title, status FROM work_items
          WHERE avatar_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING') ORDER BY created_at, work_id`).all(avatarId);
        connection.prepare(`INSERT INTO avatar_task_projections (avatar_id, active_work_json, recent_results_json, updated_at)
          VALUES (?, ?, '[]', ?) ON CONFLICT(avatar_id) DO UPDATE SET active_work_json = excluded.active_work_json,
            updated_at = excluded.updated_at`).run(avatarId, JSON.stringify(active), plan.createdAt);
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

  async loadForReassignment(workId: string): Promise<WorkReassignmentContext | null> {
    const row = this.database.transaction((connection) => connection.prepare(`
      SELECT w.work_id, w.avatar_id, w.title, COALESCE(p.access_mode, w.access_mode) AS access_mode, w.status,
             w.created_at, w.updated_at, a.partner_revision_id
        FROM work_items w
        LEFT JOIN work_access_policies p ON p.work_id = w.work_id
        JOIN dispatch_attempts a ON a.dispatch_attempt_id = (
          SELECT latest.dispatch_attempt_id FROM dispatch_attempts latest
           WHERE latest.work_id = w.work_id ORDER BY latest.created_at DESC, latest.dispatch_attempt_id DESC LIMIT 1
        )
       WHERE w.work_id = ?`).get(workId)) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const required = ["work_id", "avatar_id", "title", "access_mode", "status", "created_at", "updated_at", "partner_revision_id"] as const;
    if (required.some((key) => typeof row[key] !== "string")) throw new Error("work_reassignment_record_invalid");
    return {
      item: {
        accessMode: row.access_mode as WorkReassignmentContext["item"]["accessMode"],
        avatarId: row.avatar_id as string,
        createdAt: row.created_at as string,
        status: row.status as WorkReassignmentContext["item"]["status"],
        title: row.title as string,
        updatedAt: row.updated_at as string,
        workId: row.work_id as string,
      },
      lastPartnerRevisionId: row.partner_revision_id as string,
    };
  }

  async reassign(plan: ReassignedWorkPlan): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO dispatch_plans
        (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        plan.dispatchPlanId, plan.turnId, JSON.stringify({ reassignWorkId: plan.workId }),
        JSON.stringify([{ allowed: true, workId: plan.workId }]), plan.createdAt,
      );
      connection.prepare(`INSERT INTO outbox
        (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
        VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`).run(
        plan.attempt.outbox.outboxId, plan.attempt.outbox.kind, JSON.stringify(plan.attempt.outbox.payload),
        plan.attempt.outbox.availableAt, plan.createdAt,
      );
      connection.prepare(`INSERT INTO dispatch_attempts
        (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision,
         action_id, outbox_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`).run(
        plan.attempt.dispatchAttemptId, plan.dispatchPlanId, plan.workId, plan.attempt.partnerRevisionId,
        plan.attempt.registryRevision, plan.attempt.actionId, plan.attempt.outbox.outboxId, plan.createdAt, plan.createdAt,
      );
      connection.prepare("UPDATE work_items SET status = 'READY', updated_at = ? WHERE work_id = ?")
        .run(plan.createdAt, plan.workId);
    });
  }
}
