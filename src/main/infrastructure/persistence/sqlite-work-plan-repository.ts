/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import { assertGoalEvidenceReferences } from "./sqlite-goal-evidence-repository.js";

import type {
  CommittedWorkPlan,
  GoalWorkListQuery,
  GoalWorkListPage,
  PlannedDispatchAttempt,
  ReassignedWorkPlan,
  WorkAcceptanceCheck,
  WorkPlanRepository,
  WorkQuery,
  WorkRecoveryRepository,
  WorkSupplementContext,
  WorkReassignmentContext,
  WorkReassignmentRepository,
  SupplementReference,
} from "../../application/ports/work-orchestration.js";
import { assertExecutionAccess, localExecutionCapabilities, readExecutionNeeds, type WorkExecutionNeed } from "../../domain/work/work-execution-needs.js";
import { readStoredPartnerRevision } from "./sqlite-partner-registry-repository.js";
import type { WorkAccessMode } from "../../domain/work/work.js";
import type { WorkItemDto } from "../../../shared/joi.js";
import { cascadeDependencyCancellation } from "./sqlite-work-dependency-cascade.js";
import { assertGoalRequirementsReady } from "./sqlite-goal-requirements-repository.js";
import { DomainError } from "../../domain/errors.js";
import { renderGoalRequirements } from "../../domain/work/goal-requirements.js";
import { consumeSatisfiedRequirementsReviews } from "./sqlite-goal-requirements-review.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

function goalPausedError(): Error & { code: string } {
  return Object.assign(new Error("goal_execution_paused"), { code: "goal_execution_paused" });
}

function assertGoalOpen(connection: DatabaseSync, goalInputId: string): void {
  const blocked = connection.prepare(
    "SELECT 1 FROM joi_goal_execution_gates WHERE goal_input_id = ? AND status <> 'OPEN'",
  ).get(goalInputId);
  if (blocked !== undefined) throw goalPausedError();
}

function assertWorkGoalOpen(connection: DatabaseSync, workId: string): void {
  const blocked = connection.prepare(`SELECT 1 FROM work_items w
    JOIN joi_inbox_messages i ON i.input_id = w.input_id
    JOIN joi_goal_execution_gates gate ON gate.goal_input_id = COALESCE(i.goal_input_id, i.input_id)
    WHERE w.work_id = ? AND gate.status <> 'OPEN'`).get(workId);
  if (blocked !== undefined) throw goalPausedError();
}

function workAcceptanceChecks(intentJson: string): WorkAcceptanceCheck[] {
  let candidate: unknown;
  try {
    candidate = JSON.parse(intentJson);
  } catch {
    throw Object.assign(new Error("work_recovery_contract_invalid"), { code: "work_recovery_contract_invalid" });
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw Object.assign(new Error("work_recovery_contract_invalid"), { code: "work_recovery_contract_invalid" });
  }
  const values = (candidate as { acceptanceChecks?: unknown }).acceptanceChecks;
  if (!Array.isArray(values)) {
    throw Object.assign(new Error("work_recovery_contract_invalid"), { code: "work_recovery_contract_invalid" });
  }
  return values.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw Object.assign(new Error("work_recovery_contract_invalid"), { code: "work_recovery_contract_invalid" });
    }
    const check = value as Record<string, unknown>;
    if (check.kind === "BODY_PRESENT") return { kind: "BODY_PRESENT" };
    if (check.kind === "ARTIFACT_PRESENT" && typeof check.name === "string" && check.name.trim() !== "" && check.name.length <= 240) {
      return { kind: "ARTIFACT_PRESENT", name: check.name };
    }
    if (check.kind === "FILE_EXISTS" && typeof check.relativePath === "string") {
      return { kind: "FILE_EXISTS", relativePath: check.relativePath };
    }
    if (check.kind === "FILE_CONTAINS_EXACT" && typeof check.relativePath === "string" && typeof check.expectedText === "string") {
      return { expectedText: check.expectedText, kind: "FILE_CONTAINS_EXACT", relativePath: check.relativePath };
    }
    throw Object.assign(new Error("work_recovery_contract_invalid"), { code: "work_recovery_contract_invalid" });
  });
}

function plannedAttemptFromRow(row: Record<string, unknown> | undefined, workId: string): PlannedDispatchAttempt | null {
  if (row === undefined) return null;
  if (typeof row.action_id !== "string" || typeof row.dispatch_attempt_id !== "string"
    || typeof row.partner_revision_id !== "string" || typeof row.registry_revision !== "number"
    || typeof row.available_at !== "string" || row.kind !== "partner.dispatch"
    || typeof row.outbox_id !== "string" || typeof row.payload_json !== "string"
    || typeof row.partner_id !== "string") throw new Error("work_resume_attempt_invalid");
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  if (payload.actionId !== row.action_id || payload.dispatchAttemptId !== row.dispatch_attempt_id || payload.workId !== workId) {
    throw new Error("work_resume_attempt_invalid");
  }
  return {
    actionId: row.action_id,
    dispatchAttemptId: row.dispatch_attempt_id,
    outbox: {
      availableAt: row.available_at,
      kind: "partner.dispatch",
      outboxId: row.outbox_id,
      payload: {
        actionId: row.action_id,
        dispatchAttemptId: row.dispatch_attempt_id,
        ...(typeof payload.instanceId === "string" ? { instanceId: payload.instanceId } : {}),
        ...(payload.sessionPolicy === "EPHEMERAL" || payload.sessionPolicy === "RESIDENT" ? { sessionPolicy: payload.sessionPolicy } : {}),
        workId,
      },
    },
    partnerId: row.partner_id,
    partnerRevisionId: row.partner_revision_id,
    registryRevision: row.registry_revision,
    workId,
  };
}

export class SqliteWorkPlanRepository implements WorkPlanRepository, WorkQuery, WorkReassignmentRepository, WorkRecoveryRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async assertOpen(goalInputId: string): Promise<void> {
    const blocked = this.database.transaction((connection) => connection.prepare(
      "SELECT 1 FROM joi_goal_execution_gates WHERE goal_input_id = ? AND status <> 'OPEN'",
    ).get(goalInputId));
    if (blocked !== undefined) throw goalPausedError();
  }

  async assertWorkOpen(workId: string): Promise<void> {
    const blocked = this.database.transaction((connection) => connection.prepare(`SELECT 1 FROM work_items w
      JOIN joi_inbox_messages i ON i.input_id = w.input_id
      JOIN joi_goal_execution_gates gate ON gate.goal_input_id = COALESCE(i.goal_input_id, i.input_id)
      WHERE w.work_id = ? AND gate.status <> 'OPEN'`).get(workId));
    if (blocked !== undefined) throw goalPausedError();
  }

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Ordinary commits have no result; duplicate supplements return their persisted reference.
  async commit(plan: CommittedWorkPlan): Promise<void | SupplementReference> {
    return this.database.transaction((connection) => {
      assertGoalOpen(connection, plan.inputId);
      if (plan.recovery !== undefined) {
        const source = connection.prepare("SELECT input_id,workbench_id,status FROM work_items WHERE work_id=?").get(plan.recovery.sourceWorkId);
        if (source?.input_id !== plan.inputId || source.workbench_id !== plan.items[0]?.workbenchId || source.status !== "FAILED") {
          throw new DomainError("work_recovery_status_invalid", "The source Work is not a failed Work in this goal.");
        }
        const existing = this.#findSupplement(connection, plan.recovery.sourceWorkId, plan.turnId);
        if (existing !== null) return existing;
        const count = connection.prepare("SELECT COUNT(*) AS n FROM work_recovery_attempts WHERE source_work_id=?").get(plan.recovery.sourceWorkId)?.n;
        if (typeof count !== "number" || count >= 2) throw new DomainError("work_recovery_exhausted", "Work recovery is limited to two rounds.");
        if (plan.recovery.attemptNo !== count + 1) throw new DomainError("work_recovery_conflict", "The recovery generation has changed.");
      }
      const workbenchIds = [...new Set(plan.items.map((item) => item.workbenchId))];
      if (workbenchIds.length !== 1) throw new Error("work_plan_workbench_invalid");
      const workbenchId = workbenchIds[0];
      if (workbenchId === undefined) throw new Error("work_plan_workbench_invalid");
      // A turn dispatches on behalf of the goal it serves: its own input is the goal, or a
      // derived row (harness review / synthesis) whose goal_input_id points back at the goal.
      const binding = connection.prepare(`SELECT 1 FROM joi_turns t
        WHERE t.turn_id = ? AND t.workbench_id = ?
          AND (t.input_id = ? OR EXISTS (
            SELECT 1 FROM joi_inbox_messages i
             WHERE i.input_id = t.input_id AND i.goal_input_id = ?
          ))`).get(plan.turnId, workbenchId, plan.inputId, plan.inputId);
      if (binding === undefined) throw new Error("work_plan_goal_binding_invalid");
      for (const brief of plan.briefs) assertGoalEvidenceReferences(connection, { goalInputId: plan.inputId, workbenchId, resultIds: brief.evidenceResultIds ?? [] });
      const insertWork = connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, workspace_ref, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const briefs = new Map(plan.briefs.map((brief) => [brief.workId, brief]));
      for (const item of plan.items) {
        const brief = briefs.get(item.workId);
        if (brief === undefined) throw new Error("work_brief_missing");
        const attempt = plan.attempts.find(candidate => candidate.workId === item.workId);
        const revision = attempt === undefined ? null : readStoredPartnerRevision(connection,attempt.partnerRevisionId);
        if (revision !== null) assertExecutionAccess(item.accessMode,readExecutionNeeds(brief.executionNeeds),localExecutionCapabilities(revision));
        const contract = assertGoalRequirementsReady(connection, plan.inputId, brief.requirementsRevision);
        if (contract !== null) {
          if (brief.briefVersion !== 3) throw new DomainError("goal_requirements_stale", "Refresh the task contract.");
          renderGoalRequirements(contract, brief.requirementIds ?? [], brief.allRequirements ?? false);
        }
        insertWork.run(
        item.workId, item.workbenchId, plan.inputId, item.title, JSON.stringify({
          acceptanceChecks: brief.acceptanceChecks,
          ...(brief.briefVersion === undefined ? {} : { briefVersion: brief.briefVersion }),
          ...(brief.evidenceResultIds === undefined ? {} : { evidenceResultIds: brief.evidenceResultIds }),
          ...(brief.instructions === undefined ? {} : { instructions: brief.instructions }),
          ...(brief.executionNeeds === undefined ? {} : { executionNeeds: readExecutionNeeds(brief.executionNeeds) }),
          ...(brief.requirementsRevision === undefined ? {} : { requirementsRevision: brief.requirementsRevision, requirementIds: brief.requirementIds ?? [], allRequirements: brief.allRequirements ?? false }),
        }), item.accessMode === "NONE" ? "READ" : item.accessMode, null,
        item.status, item.createdAt, item.updatedAt,
      );
      }
      const insertAccess = connection.prepare("INSERT INTO work_access_policies (work_id, access_mode) VALUES (?, ?)");
      for (const item of plan.items) insertAccess.run(item.workId, item.accessMode);
      const insertDependency = connection.prepare("INSERT INTO work_dependencies (work_id, depends_on_work_id) VALUES (?, ?)");
      for (const dependency of plan.dependencies) insertDependency.run(dependency.workId, dependency.dependsOnWorkId);
      // A dependency declared against an already terminal-failed predecessor is canceled on
      // arrival: the claim gate would keep it unclaimable forever otherwise.
      for (const dependency of plan.dependencies) {
        const target = connection.prepare("SELECT status FROM work_items WHERE work_id = ?")
          .get(dependency.dependsOnWorkId) as { status?: unknown } | undefined;
        if (target?.status === "FAILED" || target?.status === "CANCELED") {
          cascadeDependencyCancellation(connection, {
            cancelReason: target.status === "FAILED" ? "dependency_failed" : "dependency_canceled",
            now: plan.createdAt,
            workId: dependency.dependsOnWorkId,
          });
        }
      }
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
      if (plan.recovery !== undefined) {
        if (plan.items.length !== 1) throw new Error("work_recovery_plan_invalid");
        const replacementWorkId = plan.items[0]?.workId;
        if (replacementWorkId === undefined) throw new Error("work_recovery_plan_invalid");
        connection.prepare(`INSERT INTO work_recovery_attempts
          (recovery_id, source_work_id, replacement_work_id, attempt_no, strategy, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'PLANNED', ?, ?)`).run(
          plan.recovery.recoveryId, plan.recovery.sourceWorkId, replacementWorkId,
          plan.recovery.attemptNo, plan.recovery.strategy, plan.createdAt, plan.createdAt,
        );
        const evidence = connection.prepare(`INSERT INTO work_recovery_evidence (recovery_id, result_id) VALUES (?, ?)`);
        for (const resultId of plan.briefs[0]?.evidenceResultIds ?? []) evidence.run(plan.recovery.recoveryId, resultId);
      }
      const active = connection.prepare(`SELECT work_id AS workId, title, status FROM work_items
        WHERE workbench_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING') ORDER BY created_at, work_id`).all(workbenchId);
      connection.prepare(`INSERT INTO workbench_task_projections (workbench_id, active_work_json, recent_results_json, updated_at)
        VALUES (?, ?, '[]', ?) ON CONFLICT(workbench_id) DO UPDATE SET active_work_json = excluded.active_work_json,
          updated_at = excluded.updated_at`).run(workbenchId, JSON.stringify(active), plan.createdAt);
      return undefined;
    });
  }

  #findSupplement(connection: DatabaseSync, sourceWorkId: string, turnId: string): SupplementReference | null {
    // The first persisted attempt owns the supplement receipt; later attempts only identify replay Turns.
    const row = connection.prepare(`SELECT recovery.recovery_id,recovery.attempt_no,a.dispatch_plan_id,p.candidate_json
      FROM work_recovery_attempts recovery JOIN work_items w ON w.work_id=recovery.replacement_work_id
      JOIN dispatch_attempts a ON a.rowid=(SELECT first.rowid FROM dispatch_attempts first
        WHERE first.work_id=w.work_id ORDER BY first.rowid LIMIT 1)
      JOIN dispatch_plans p ON p.dispatch_plan_id=a.dispatch_plan_id
      WHERE recovery.source_work_id=? AND (EXISTS (
        SELECT 1 FROM dispatch_attempts replay JOIN dispatch_plans rp ON rp.dispatch_plan_id=replay.dispatch_plan_id
        WHERE replay.work_id=w.work_id AND rp.turn_id=?) OR w.status IN ('PLANNED','READY','RUNNING','WAITING')
        OR EXISTS (SELECT 1 FROM partner_runs r WHERE r.work_id=w.work_id AND r.status IN ('RUNNING','WAITING_INPUT','WAITING_AUTH')))
      ORDER BY CASE WHEN EXISTS (
        SELECT 1 FROM dispatch_attempts replay JOIN dispatch_plans rp ON rp.dispatch_plan_id=replay.dispatch_plan_id
        WHERE replay.work_id=w.work_id AND rp.turn_id=?) THEN 0 ELSE 1 END,recovery.attempt_no DESC LIMIT 1`).get(sourceWorkId,turnId,turnId);
    if (row === undefined) return null;
    if (typeof row.attempt_no !== "number" || typeof row.dispatch_plan_id !== "string" || typeof row.candidate_json !== "string") throw new Error("work_recovery_record_invalid");
    const candidate = JSON.parse(row.candidate_json) as { waves?: unknown };
    if (!Array.isArray(candidate.waves) || candidate.waves.some(wave => !Array.isArray(wave) || wave.some(id => typeof id !== "string"))) throw new Error("work_recovery_record_invalid");
    const evidence = connection.prepare("SELECT result_id FROM work_recovery_evidence WHERE recovery_id=? ORDER BY result_id").all(row.recovery_id as string);
    return { attemptNo: row.attempt_no, dispatchPlanId: row.dispatch_plan_id, waves: candidate.waves as string[][],
      evidenceResultIds: evidence.map(item => item.result_id as string) };
  }

  async findSupplement(sourceWorkId: string, turnId: string): Promise<SupplementReference | null> {
    return this.database.transaction(connection => this.#findSupplement(connection,sourceWorkId,turnId));
  }

  async readBrief(goalInputId: string, workbenchId: string, workId: string) {
    return this.database.transaction(db => {
      const row = db.prepare("SELECT w.title,w.intent_json,COALESCE(p.access_mode,w.access_mode) AS access_mode FROM work_items w LEFT JOIN work_access_policies p ON p.work_id=w.work_id WHERE w.work_id = ? AND w.input_id = ? AND w.workbench_id = ?")
        .get(workId, goalInputId, workbenchId);
      if (typeof row?.intent_json !== "string" || typeof row.title !== "string") return null;
      const brief = JSON.parse(row.intent_json) as { instructions?: string; requirementsRevision?: number };
      return { workId, title: row.title, accessMode: row.access_mode as WorkAccessMode, executionNeeds: readExecutionNeeds((brief as { executionNeeds?: unknown }).executionNeeds) ?? null, instructions: brief.instructions ?? "", ...(brief.requirementsRevision === undefined ? {} : { requirementsRevision: brief.requirementsRevision }) };
    });
  }

  async listForGoal(goalInputId: string, workbenchId: string) {
    return this.database.transaction(db => (db.prepare("SELECT work_id, title, status, intent_json FROM work_items WHERE input_id = ? AND workbench_id = ? ORDER BY created_at, work_id")
      .all(goalInputId, workbenchId) as { work_id: string; title: string; status: string; intent_json: string }[]).map(row => {
        const brief = JSON.parse(row.intent_json) as { requirementsRevision?: number };
        return { workId: row.work_id, title: row.title, status: row.status, ...(brief.requirementsRevision === undefined ? {} : { requirementsRevision: brief.requirementsRevision }) };
      }));
  }

  async listGoalPage(input: GoalWorkListQuery): Promise<GoalWorkListPage> {
    const limit = input.limit ?? 20;
    const statuses = [...new Set(input.statuses ?? [])].sort();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || statuses.some(status => !["PLANNED","READY","RUNNING","WAITING","COMPLETED","FAILED","CANCELED"].includes(status))
      || [input.requirementsRevision,input.requirementsRevisionNot].some(revision => revision !== undefined && revision !== null && (!Number.isSafeInteger(revision) || revision < 0))) {
      throw new DomainError("work_list_query_invalid", "Work list filters are invalid.");
    }
    const binding = JSON.stringify([input.goalInputId,input.workbenchId,statuses,input.requirementsRevision ?? null,
      input.requirementsRevisionNot === undefined ? "unset" : input.requirementsRevisionNot,input.workId ?? null,input.excludeWorkId ?? null]);
    return this.database.transaction(db => {
      let snapshot: number;
      let after: [string,string] | undefined;
      if (input.cursor === undefined) {
        snapshot = db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM work_items WHERE input_id=? AND workbench_id=?").get(input.goalInputId,input.workbenchId)?.n as number;
      } else {
        let cursor: unknown;
        try { cursor = JSON.parse(Buffer.from(input.cursor.replace(/^w1:/u,""),"base64url").toString("utf8")) as unknown; } catch { /* Invalid cursors share one public error. */ }
        if (!input.cursor.startsWith("w1:") || cursor === null || typeof cursor !== "object") throw new DomainError("work_list_cursor_invalid", "Work list cursor is invalid.");
        const value = cursor as { binding?: unknown; snapshot?: unknown; after?: unknown };
        if (value.binding !== binding || typeof value.snapshot !== "number" || !Number.isSafeInteger(value.snapshot) || value.snapshot < 0
          || !Array.isArray(value.after) || value.after.length !== 2 || value.after.some(part => typeof part !== "string")) throw new DomainError("work_list_cursor_invalid", "Work list cursor is invalid.");
        snapshot = value.snapshot; after = value.after as [string,string];
      }
      const revision = "json_extract(intent_json,'$.requirementsRevision')";
      const clauses = ["input_id=?","workbench_id=?","rowid<=?"];
      const parameters: (string | number)[] = [input.goalInputId,input.workbenchId,snapshot];
      if (statuses.length > 0) { clauses.push(`status IN (${statuses.map(() => "?").join(",")})`); parameters.push(...statuses); }
      if (input.requirementsRevision !== undefined) { clauses.push(`${revision}=?`); parameters.push(input.requirementsRevision); }
      if (input.requirementsRevisionNot === null) clauses.push(`${revision} IS NOT NULL`);
      else if (input.requirementsRevisionNot !== undefined) { clauses.push(`(${revision} IS NULL OR ${revision}<>?)`); parameters.push(input.requirementsRevisionNot); }
      if (input.workId !== undefined) { clauses.push("work_id=?"); parameters.push(input.workId); }
      if (input.excludeWorkId !== undefined) { clauses.push("work_id<>?"); parameters.push(input.excludeWorkId); }
      if (after !== undefined) { clauses.push("(created_at,work_id)>(?,?)"); parameters.push(...after); }
      const rows = db.prepare(`SELECT work_id,title,status,created_at,${revision} AS requirements_revision FROM work_items
        WHERE ${clauses.join(" AND ")} ORDER BY created_at,work_id LIMIT ?`).all(...parameters,limit + 1) as { work_id: string; title: string; status: string; created_at: string; requirements_revision: number | null }[];
      const selected = rows.slice(0,limit);
      const last = selected.at(-1);
      return { items: selected.map(row => ({ workId: row.work_id,title: row.title,status: row.status,
        ...(row.requirements_revision === null ? {} : { requirementsRevision: row.requirements_revision }) })),
        ...(rows.length > limit && last !== undefined ? { nextCursor: `w1:${Buffer.from(JSON.stringify({ binding,snapshot,after: [last.created_at,last.work_id] })).toString("base64url")}` } : {}) };
    });
  }

  async refreshBrief(input: { executionNeeds?: WorkExecutionNeed[]; goalInputId: string; workbenchId: string; workId: string; turnId: string; actionId: string; instructions: string; requirementsRevision: number; requirementIds: string[]; allRequirements: boolean }): Promise<void> {
    this.database.transaction(db => {
      const duplicate = db.prepare("SELECT work_id FROM joi_work_brief_updates WHERE action_id = ?").get(input.actionId);
      if (duplicate !== undefined) {
        if (duplicate.work_id !== input.workId) throw new DomainError("work_brief_update_conflict", "The update action belongs to another Work.");
        return;
      }
      assertGoalOpen(db, input.goalInputId);
      const contract = assertGoalRequirementsReady(db, input.goalInputId, input.requirementsRevision);
      if (contract === null) throw new DomainError("goal_requirements_unavailable", "The goal contract is unavailable.");
      renderGoalRequirements(contract, input.requirementIds, input.allRequirements);
      const row = db.prepare(`SELECT w.intent_json,COALESCE(ap.access_mode,w.access_mode) AS access_mode,a.partner_revision_id FROM work_items w LEFT JOIN work_access_policies ap ON ap.work_id=w.work_id JOIN dispatch_attempts a ON a.dispatch_attempt_id=(SELECT dispatch_attempt_id FROM dispatch_attempts WHERE work_id=w.work_id ORDER BY created_at DESC,dispatch_attempt_id DESC LIMIT 1) JOIN partner_revisions rev ON rev.partner_revision_id=a.partner_revision_id JOIN joi_turns t ON t.turn_id = ?
        JOIN joi_inbox_messages i ON i.input_id = t.input_id
        WHERE w.work_id = ? AND w.input_id = ? AND w.workbench_id = ? AND t.workbench_id = w.workbench_id
          AND COALESCE(i.goal_input_id, i.input_id) = w.input_id AND t.status = 'RUNNING'
          AND w.status IN ('PLANNED', 'READY')
          AND NOT EXISTS (SELECT 1 FROM partner_runs r WHERE r.work_id = w.work_id AND r.status = 'RUNNING')
          AND NOT EXISTS (SELECT 1 FROM partner_runs r WHERE r.dispatch_attempt_id = (
            SELECT a.dispatch_attempt_id FROM dispatch_attempts a WHERE a.work_id = w.work_id
            ORDER BY a.created_at DESC, a.dispatch_attempt_id DESC LIMIT 1))`)
        .get(input.turnId, input.workId, input.goalInputId, input.workbenchId);
      if (typeof row?.intent_json !== "string") throw new DomainError("work_brief_update_not_allowed", "Only unstarted Work in this goal can be refreshed.");
      const brief = JSON.parse(row.intent_json) as Record<string, unknown>;
      const executionNeeds = readExecutionNeeds(input.executionNeeds ?? brief.executionNeeds);
      const revision = readStoredPartnerRevision(db, row.partner_revision_id as string);
      if (revision !== null) assertExecutionAccess(row.access_mode as WorkAccessMode, executionNeeds, localExecutionCapabilities(revision));
      db.prepare("UPDATE work_items SET intent_json = ? WHERE work_id = ?")
        .run(JSON.stringify({ ...brief, briefVersion: 3, instructions: input.instructions, requirementsRevision: input.requirementsRevision,
          requirementIds: input.requirementIds, allRequirements: input.allRequirements, ...(executionNeeds === undefined ? {} : { executionNeeds }) }), input.workId);
      db.prepare("INSERT INTO joi_work_brief_updates (action_id, work_id) VALUES (?, ?)").run(input.actionId, input.workId);
      const turn = db.prepare("SELECT updated_at FROM joi_turns WHERE turn_id = ?").get(input.turnId);
      if (typeof turn?.updated_at === "string") {
        db.prepare(`UPDATE outbox SET available_at = MIN(available_at, ?)
          WHERE status = 'PENDING' AND kind = 'partner.dispatch' AND outbox_id = (
            SELECT outbox_id FROM dispatch_attempts WHERE work_id = ?
            ORDER BY created_at DESC, dispatch_attempt_id DESC LIMIT 1)`)
          .run(turn.updated_at, input.workId);
        consumeSatisfiedRequirementsReviews(db, contract, turn.updated_at);
      }
    });
  }

  async listActive(): Promise<WorkItemDto[]> {
    return this.database.transaction((connection) => connection.prepare(`
      SELECT w.work_id, w.workbench_id, w.title, w.status, e.phase, e.wait_reason FROM work_items w
       LEFT JOIN dispatch_attempts a ON a.dispatch_attempt_id = (SELECT latest.dispatch_attempt_id FROM dispatch_attempts latest
         WHERE latest.work_id = w.work_id ORDER BY latest.created_at DESC, latest.dispatch_attempt_id DESC LIMIT 1)
       LEFT JOIN local_work_execution e ON e.dispatch_attempt_id = a.dispatch_attempt_id
       WHERE w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED')
       ORDER BY w.created_at, w.work_id`).all()).map((value) => {
      const row = value as Record<string, unknown>;
      if (typeof row.work_id !== "string" || typeof row.workbench_id !== "string"
        || typeof row.title !== "string" || typeof row.status !== "string") throw new Error("work_item_record_invalid");
      return { workbenchId: row.workbench_id, status: row.status as WorkItemDto["status"], title: row.title, workId: row.work_id,
        ...(typeof row.phase === "string" ? { executionPhase: row.phase as NonNullable<WorkItemDto["executionPhase"]> } : {}),
        ...(typeof row.wait_reason === "string" ? { waitReason: row.wait_reason as NonNullable<WorkItemDto["waitReason"]> } : {}),
      };
    });
  }

  async loadForReassignment(workId: string): Promise<WorkReassignmentContext | null> {
    const row = this.database.transaction((connection) => connection.prepare(`
      SELECT w.work_id, w.workbench_id, w.input_id, w.title, COALESCE(p.access_mode, w.access_mode) AS access_mode, w.status,
             w.created_at, w.updated_at, w.intent_json, a.partner_revision_id, a.instance_id, rev.partner_id
        FROM work_items w
        LEFT JOIN work_access_policies p ON p.work_id = w.work_id
        JOIN dispatch_attempts a ON a.dispatch_attempt_id = (
          SELECT latest.dispatch_attempt_id FROM dispatch_attempts latest
           WHERE latest.work_id = w.work_id ORDER BY latest.created_at DESC, latest.dispatch_attempt_id DESC LIMIT 1
        )
        JOIN partner_revisions rev ON rev.partner_revision_id = a.partner_revision_id
       WHERE w.work_id = ?`).get(workId)) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const required = ["work_id", "workbench_id", "title", "access_mode", "status", "created_at", "updated_at", "partner_revision_id", "partner_id"] as const;
    if (required.some((key) => typeof row[key] !== "string")) throw new Error("work_reassignment_record_invalid");
    const executionNeeds = readExecutionNeeds((JSON.parse(row.intent_json as string) as { executionNeeds?: unknown }).executionNeeds);
    return {
      inputId: row.input_id as string,
      ...(executionNeeds === undefined ? {} : { executionNeeds }),
      item: {
        accessMode: row.access_mode as WorkReassignmentContext["item"]["accessMode"],
        workbenchId: row.workbench_id as string,
        createdAt: row.created_at as string,
        status: row.status as WorkReassignmentContext["item"]["status"],
        title: row.title as string,
        updatedAt: row.updated_at as string,
        workId: row.work_id as string,
      },
      ...(typeof row.instance_id === "string" ? { lastInstanceId: row.instance_id } : {}),
      lastPartnerId: row.partner_id as string,
      lastPartnerRevisionId: row.partner_revision_id as string,
    };
  }

  async loadForSupplement(workId: string): Promise<WorkSupplementContext | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare(`SELECT w.work_id, w.workbench_id, w.input_id, w.title, w.intent_json,
        COALESCE(p.access_mode, w.access_mode) AS access_mode, w.status, w.created_at, w.updated_at,
        (SELECT COUNT(*) FROM work_recovery_attempts a WHERE a.source_work_id = w.work_id) AS attempt_count
        FROM work_items w LEFT JOIN work_access_policies p ON p.work_id = w.work_id
        WHERE w.work_id = ?`).get(workId) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      const required = ["work_id", "workbench_id", "input_id", "title", "intent_json", "access_mode", "status", "created_at", "updated_at"] as const;
      if (required.some((key) => typeof row[key] !== "string") || typeof row.attempt_count !== "number") {
        throw new Error("work_recovery_record_invalid");
      }
      const inputId = row.input_id as string;
      const evidenceRows = connection.prepare(`SELECT r.result_id FROM work_results r
        JOIN work_items evidence_work ON evidence_work.work_id = r.work_id
        WHERE evidence_work.input_id = ? AND evidence_work.work_id <> ?
          AND r.is_authoritative = 1 AND r.status = 'COMPLETED'
        ORDER BY r.created_at DESC, r.result_id DESC LIMIT 12`).all(inputId, workId) as Record<string, unknown>[];
      const evidenceResultIds = evidenceRows.map((candidate) => {
        if (typeof candidate.result_id !== "string") throw new Error("work_recovery_evidence_invalid");
        return candidate.result_id;
      });
      const executionNeeds = readExecutionNeeds((JSON.parse(row.intent_json as string) as { executionNeeds?: unknown }).executionNeeds);
      return {
        attemptCount: row.attempt_count,
        evidenceResultIds,
        inputId,
        item: {
          accessMode: row.access_mode as WorkSupplementContext["item"]["accessMode"],
          workbenchId: row.workbench_id as string,
          createdAt: row.created_at as string,
          status: row.status as WorkSupplementContext["item"]["status"],
          title: row.title as string,
          updatedAt: row.updated_at as string,
          workId: row.work_id as string,
        },
        sourceAcceptanceChecks: workAcceptanceChecks(row.intent_json as string),
        ...(executionNeeds === undefined ? {} : { executionNeeds }),
      };
    });
  }

  async countRecoveryAttempts(workId: string): Promise<number> {
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT COUNT(*) AS n FROM work_recovery_attempts WHERE source_work_id = ?").get(workId) as Record<string, unknown>;
      if (typeof row.n !== "number") throw new Error("work_recovery_record_invalid");
      return row.n;
    });
  }

  /** Suspended execution can be canceled because no tool is in flight. */
  async cancel(workId: string, at: string): Promise<{ canceled: boolean; cascadedWorkIds: string[] }> {
    return this.database.transaction((connection) => {
      const canceled = connection.prepare(`
        UPDATE work_items SET status = 'CANCELED', updated_at = ?
         WHERE work_id = ? AND status IN ('PLANNED', 'READY', 'WAITING', 'FAILED', 'RUNNING')
           AND (status <> 'RUNNING' OR EXISTS (SELECT 1 FROM dispatch_attempts a
             JOIN local_work_execution e ON e.dispatch_attempt_id = a.dispatch_attempt_id
             WHERE a.work_id = work_items.work_id AND a.status = 'RUNNING' AND e.phase = 'WRITE_QUEUED'))
           AND NOT EXISTS (SELECT 1 FROM partner_runs r
             LEFT JOIN local_work_execution e ON e.dispatch_attempt_id = r.dispatch_attempt_id
             WHERE r.work_id = work_items.work_id AND r.status = 'RUNNING'
               AND COALESCE(e.phase, '') <> 'WRITE_QUEUED')`).run(at, workId).changes > 0;
      if (!canceled) return { canceled: false, cascadedWorkIds: [] };
      connection.prepare("DELETE FROM workspace_write_waiters WHERE work_id = ?").run(workId);
      connection.prepare("DELETE FROM workspace_leases WHERE work_id = ?").run(workId);
      connection.prepare(`UPDATE partner_instances SET status = 'DISPOSED', disposed_at = ?, last_used_at = ?, disposal_reason = 'work_canceled'
        WHERE status = 'SUSPENDED' AND instance_id IN (SELECT instance_id FROM dispatch_attempts WHERE work_id = ?)`).run(at, at, workId);
      connection.prepare(`UPDATE outbox SET status = 'DONE', claim_owner = NULL, claim_until = NULL
        WHERE kind = 'partner.continue' AND json_extract(payload_json, '$.workId') = ?`).run(workId);
      connection.prepare("UPDATE partner_runs SET status = 'FAILED', updated_at = ? WHERE work_id = ? AND status = 'RUNNING'").run(at, workId);
      connection.prepare("UPDATE dispatch_attempts SET status = 'FAILED', updated_at = ? WHERE work_id = ? AND status = 'RUNNING'").run(at, workId);
      connection.prepare("DELETE FROM local_work_execution WHERE dispatch_attempt_id IN (SELECT dispatch_attempt_id FROM dispatch_attempts WHERE work_id = ?)").run(workId);
      const cascadedWorkIds = cascadeDependencyCancellation(connection, {
        cancelReason: "dependency_canceled",
        now: at,
        workId,
      });
      return { canceled: true, cascadedWorkIds };
    });
  }

  /** True when the Work's owning goal was canceled; in-flight runs of it must abort. */
  async isGoalCanceled(workId: string): Promise<boolean> {
    return this.database.transaction((connection) => connection.prepare(`SELECT 1 AS hit
      FROM work_items w JOIN joi_inbox_messages i ON i.input_id = w.input_id
      WHERE w.work_id = ? AND i.canceled_at IS NOT NULL LIMIT 1`).get(workId)) !== undefined;
  }

  async loadAttemptForTurn(workId: string, turnId: string): Promise<PlannedDispatchAttempt | null> {
    const row = this.database.transaction((connection) => connection.prepare(`SELECT
      a.action_id, a.dispatch_attempt_id, a.partner_revision_id, a.registry_revision,
      o.available_at, o.kind, o.outbox_id, o.payload_json, rev.partner_id
      FROM dispatch_attempts a
      JOIN dispatch_plans p ON p.dispatch_plan_id = a.dispatch_plan_id
      JOIN outbox o ON o.outbox_id = a.outbox_id
      JOIN partner_revisions rev ON rev.partner_revision_id = a.partner_revision_id
      WHERE a.work_id = ? AND p.turn_id = ?
      ORDER BY a.created_at DESC, a.dispatch_attempt_id DESC LIMIT 1`).get(workId, turnId)) as Record<string, unknown> | undefined;
    return plannedAttemptFromRow(row, workId);
  }

  async loadAttemptForAction(workId: string, actionId: string): Promise<PlannedDispatchAttempt | null> {
    const row = this.database.transaction((connection) => connection.prepare(`SELECT
      a.action_id, a.dispatch_attempt_id, a.partner_revision_id, a.registry_revision,
      o.available_at, o.kind, o.outbox_id, o.payload_json, rev.partner_id
      FROM dispatch_attempts a
      JOIN outbox o ON o.outbox_id = a.outbox_id
      JOIN partner_revisions rev ON rev.partner_revision_id = a.partner_revision_id
      WHERE a.work_id = ? AND a.action_id = ?
      ORDER BY a.created_at DESC, a.dispatch_attempt_id DESC LIMIT 1`).get(workId, actionId)) as Record<string, unknown> | undefined;
    return plannedAttemptFromRow(row, workId);
  }

  async reassign(plan: ReassignedWorkPlan): Promise<void> {
    this.database.transaction((connection) => {
      assertWorkGoalOpen(connection, plan.workId);
      const owner = connection.prepare("SELECT w.input_id,w.workbench_id,w.intent_json,COALESCE(ap.access_mode,w.access_mode) AS access_mode FROM work_items w LEFT JOIN work_access_policies ap ON ap.work_id=w.work_id WHERE w.work_id = ?").get(plan.workId);
      if (typeof owner?.input_id !== "string" || typeof owner.intent_json !== "string") throw new Error("work_brief_missing");
      if (plan.evidenceResultIds !== undefined) assertGoalEvidenceReferences(connection, { goalInputId: owner.input_id, workbenchId: owner.workbench_id as string, resultIds: plan.evidenceResultIds });
      const revision = readStoredPartnerRevision(connection,plan.attempt.partnerRevisionId);
      const executionNeeds = readExecutionNeeds(plan.executionNeeds ?? (JSON.parse(owner.intent_json) as { executionNeeds?: unknown }).executionNeeds);
      if (revision !== null) assertExecutionAccess(plan.accessMode ?? owner.access_mode as WorkAccessMode,executionNeeds,localExecutionCapabilities(revision));
      const contract = assertGoalRequirementsReady(connection, owner.input_id, plan.requirementsRevision);
      if (contract !== null) {
        const binding = connection.prepare(`SELECT 1 FROM joi_turns t JOIN joi_inbox_messages i ON i.input_id = t.input_id
          WHERE t.turn_id = ? AND t.workbench_id = ? AND COALESCE(i.goal_input_id, i.input_id) = ? AND t.status = 'RUNNING'`)
          .get(plan.turnId, contract.workbenchId, contract.goalInputId);
        if (binding === undefined) throw new DomainError("goal_requirements_scope_invalid", "The reassignment turn belongs to another goal.");
        if (plan.instructions === undefined) throw new DomainError("work_instructions_invalid", "Provide current complete instructions.");
        renderGoalRequirements(contract, plan.requirementIds ?? [], plan.allRequirements ?? false);
      }
      if (plan.instructions !== undefined || plan.executionNeeds !== undefined || plan.evidenceResultIds !== undefined) {
        const row = connection.prepare("SELECT intent_json FROM work_items WHERE work_id = ?").get(plan.workId);
        if (typeof row?.intent_json !== "string") throw new Error("work_brief_missing");
        const brief = JSON.parse(row.intent_json) as unknown;
        if (brief === null || typeof brief !== "object" || Array.isArray(brief)) throw new Error("work_brief_invalid");
        connection.prepare("UPDATE work_items SET intent_json = ? WHERE work_id = ?")
          .run(JSON.stringify({ ...brief, ...(plan.evidenceResultIds === undefined ? {} : { evidenceResultIds: plan.evidenceResultIds }), briefVersion: contract === null ? 2 : 3, ...(plan.instructions === undefined ? {} : { instructions: plan.instructions }),
            ...(plan.executionNeeds === undefined ? {} : { executionNeeds: readExecutionNeeds(plan.executionNeeds) }),
            ...(contract === null ? {} : { requirementsRevision: contract.revision, requirementIds: plan.requirementIds ?? [], allRequirements: plan.allRequirements ?? false }),
          }), plan.workId);
      }
      if (plan.accessMode !== undefined) {
        connection.prepare("UPDATE work_items SET access_mode = ? WHERE work_id = ?")
          .run(plan.accessMode === "NONE" ? "READ" : plan.accessMode, plan.workId);
        connection.prepare(`INSERT INTO work_access_policies (work_id, access_mode) VALUES (?, ?)
          ON CONFLICT(work_id) DO UPDATE SET access_mode = excluded.access_mode`).run(plan.workId, plan.accessMode);
      }
      // A resumed/reassigned Work supersedes its paused run. Leaving the old run in
      // WAITING_INPUT would keep Agent and goal projections permanently active.
      connection.prepare(`UPDATE partner_runs SET status = 'FAILED', updated_at = ?
        WHERE work_id = ? AND status IN ('WAITING_INPUT', 'WAITING_AUTH')`).run(plan.createdAt, plan.workId);
      connection.prepare(`UPDATE dispatch_attempts SET status = 'FAILED', updated_at = ?
        WHERE work_id = ? AND status IN ('WAITING_INPUT', 'WAITING_AUTH')`).run(plan.createdAt, plan.workId);
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
      connection.prepare(`UPDATE joi_user_action_requests SET status = 'APPLIED', applied_at = COALESCE(applied_at, ?), updated_at = ?
        WHERE action_id = ? AND work_id = ? AND status IN ('RESOLVED', 'APPLIED')`).run(
        plan.createdAt, plan.createdAt, plan.attempt.actionId, plan.workId,
      );
      connection.prepare("UPDATE work_items SET status = 'READY', updated_at = ? WHERE work_id = ?")
        .run(plan.createdAt, plan.workId);
      if (plan.recovery !== undefined) connection.prepare(`INSERT INTO work_recovery_attempts
        (recovery_id, source_work_id, replacement_work_id, attempt_no, strategy, status, created_at, updated_at)
        VALUES (?, ?, NULL, ?, 'REASSIGN', 'PLANNED', ?, ?)`).run(
        plan.recovery.recoveryId, plan.workId, plan.recovery.attemptNo, plan.createdAt, plan.createdAt,
      );
    });
  }
}
