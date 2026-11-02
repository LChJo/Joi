/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import { nextGoalReopenTime } from "./sqlite-goal-reopen-time.js";

import type { AutomationGoalInspection, AutomationRecord, AutomationRunRecord, AutomationStore, AutomationTrigger } from "../../application/ports/automation.js";
import { createRoutine, nextRoutineOccurrence, type RoutineFrequency } from "../../domain/automation/routine.js";
import { DomainError } from "../../domain/errors.js";

interface TransactionalDatabase { transaction<T>(operation: (database: DatabaseSync) => T): T }
type Row = Record<string, unknown>;

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw new Error("automation_record_invalid");
  return value;
};
const optionalText = (row: Row, key: string): string | undefined => typeof row[key] === "string" ? row[key] : undefined;

export class SqliteAutomationStore implements AutomationStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async countActive(): Promise<number> {
    const row = this.database.transaction((connection) => connection.prepare("SELECT COUNT(*) AS count FROM joi_automations WHERE deleted_at IS NULL").get()) as Row;
    return typeof row.count === "number" ? row.count : 0;
  }

  async hasLiveRun(routineId: string): Promise<boolean> {
    return this.database.transaction((connection) => connection.prepare(`SELECT 1 FROM joi_automation_runs
      WHERE routine_id = ? AND status IN ('PENDING', 'RUNNING', 'BLOCKED') LIMIT 1`).get(routineId) !== undefined);
  }

  async inspectGoal(goalId: string): Promise<AutomationGoalInspection | null> {
    return this.database.transaction((connection) => inspectGoal(connection, goalId));
  }

  async create(record: AutomationRecord): Promise<AutomationRecord> {
    this.database.transaction((connection) => {
      if (record.createIdempotencyKey !== undefined) {
        const existing = connection.prepare("SELECT routine_id FROM joi_automations WHERE create_idempotency_key = ?").get(record.createIdempotencyKey);
        if (existing !== undefined) return;
      }
      const count = connection.prepare("SELECT COUNT(*) AS count FROM joi_automations WHERE deleted_at IS NULL").get() as Row;
      if (typeof count.count !== "number" || count.count >= 30) throw new DomainError("routine_limit_reached", "At most 30 routines are allowed.");
      if (record.target.kind === "GOAL_CONTINUATION" && inspectGoal(connection, record.target.goalId) === null) {
        throw new DomainError("routine_goal_invalid", "Routine goal is unavailable.");
      }
      connection.prepare(`INSERT INTO joi_automations
        (routine_id, create_idempotency_key, name, prompt, frequency_json, workbench_id, preferred_partner_id, from_date, to_date,
         next_run_at, last_run_at, pending_trigger_at, enabled, deleted_at, created_at, updated_at, target_kind, target_goal_input_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(create_idempotency_key) DO NOTHING`).run(
        record.routineId, record.createIdempotencyKey ?? null, record.name, record.prompt, JSON.stringify(record.frequency), record.workbenchId,
        record.preferredPartnerId ?? null, record.from ?? null, record.to ?? null, record.nextRunAt ?? null,
        record.lastRunAt ?? null, record.pendingTriggerAt ?? null, record.enabled ? 1 : 0, record.deletedAt ?? null,
        record.createdAt, record.createdAt, record.target.kind,
        record.target.kind === "GOAL_CONTINUATION" ? record.target.goalId : null,
      );
    });
    if (record.createIdempotencyKey !== undefined) {
      const existing = await this.getByCreateIdempotencyKey(record.createIdempotencyKey);
      if (existing !== null) return existing;
    }
    return record;
  }

  async getByCreateIdempotencyKey(key: string): Promise<AutomationRecord | null> {
    return this.database.transaction((connection) => {
      // Idempotency remains stable after a soft delete; a retried create must not
      // manufacture a new routine for a key that already committed.
      const row = connection.prepare("SELECT * FROM joi_automations WHERE create_idempotency_key = ?").get(key) as Row | undefined;
      return row === undefined ? null : mapRecord(connection, row);
    });
  }

  async list(includeDeleted = false): Promise<AutomationRecord[]> {
    return this.database.transaction((connection) => {
      const rows = connection.prepare(`SELECT * FROM joi_automations ${includeDeleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY created_at, routine_id`).all() as Row[];
      return rows.map((row) => mapRecord(connection, row));
    });
  }

  async get(routineId: string, includeDeleted = false): Promise<AutomationRecord | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare(`SELECT * FROM joi_automations WHERE routine_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(routineId) as Row | undefined;
      return row === undefined ? null : mapRecord(connection, row);
    });
  }

  async revealPrompt(routineId: string): Promise<{ prompt: string } | null> {
    const row = this.database.transaction((connection) => connection.prepare("SELECT prompt FROM joi_automations WHERE routine_id = ? AND deleted_at IS NULL").get(routineId)) as Row | undefined;
    return typeof row?.prompt === "string" ? { prompt: row.prompt } : null;
  }

  async update(routineId: string, patch: { enabled?: boolean; from?: string | null; frequency?: RoutineFrequency; name?: string; pendingTriggerAt?: string | null; preferredPartnerId?: string | null; prompt?: string; target?: AutomationRecord["target"]; to?: string | null; workbenchId?: string; nextRunAt?: string | null; lastRunAt?: string | null }, idempotencyKey?: string): Promise<AutomationRecord | null> {
    return this.database.transaction((connection) => {
      const existingMutation = this.readMutation(connection, idempotencyKey);
      if (existingMutation !== undefined) {
        if (existingMutation.routineId !== routineId || existingMutation.kind !== "UPDATE") {
          throw new DomainError("idempotency_key_conflict", "Idempotency key was already used for another automation mutation.");
        }
        const existingRow = connection.prepare("SELECT * FROM joi_automations WHERE routine_id = ?").get(routineId) as Row | undefined;
        return existingRow === undefined ? null : mapRecord(connection, existingRow);
      }
      const current = connection.prepare("SELECT * FROM joi_automations WHERE routine_id = ? AND deleted_at IS NULL").get(routineId) as Row | undefined;
      if (current === undefined) return null;
      const currentTargetKind = optionalText(current, "target_kind") ?? "NEW_GOAL";
      const currentTargetGoalId = optionalText(current, "target_goal_input_id");
      const targetChanged = patch.target !== undefined && (patch.target.kind !== currentTargetKind
        || (patch.target.kind === "GOAL_CONTINUATION" && patch.target.goalId !== currentTargetGoalId));
      if (targetChanged && connection.prepare(`SELECT 1 FROM joi_automation_runs
        WHERE routine_id = ? AND status IN ('PENDING', 'RUNNING', 'BLOCKED') LIMIT 1`).get(routineId) !== undefined) {
        throw new DomainError("routine_target_busy", "Routine target cannot change while a run is active or waiting.");
      }
      if (patch.target?.kind === "GOAL_CONTINUATION" && inspectGoal(connection, patch.target.goalId) === null) {
        throw new DomainError("routine_goal_invalid", "Routine goal is unavailable.");
      }
      const now = new Date().toISOString();
      const currentValue = (key: string): string | null => typeof current[key] === "string" ? current[key] : null;
      connection.prepare(`UPDATE joi_automations SET
        name = ?, prompt = ?, frequency_json = ?, workbench_id = ?, preferred_partner_id = ?,
        from_date = ?, to_date = ?, next_run_at = ?, last_run_at = ?, pending_trigger_at = ?, enabled = ?, updated_at = ?,
        target_kind = ?, target_goal_input_id = ?
        WHERE routine_id = ? AND deleted_at IS NULL`).run(
        patch.name ?? text(current, "name"), patch.prompt ?? text(current, "prompt"), JSON.stringify(patch.frequency ?? JSON.parse(text(current, "frequency_json"))),
        patch.workbenchId ?? text(current, "workbench_id"), patch.preferredPartnerId === undefined ? currentValue("preferred_partner_id") : patch.preferredPartnerId,
        patch.from === undefined ? currentValue("from_date") : patch.from, patch.to === undefined ? currentValue("to_date") : patch.to,
        patch.nextRunAt === undefined ? currentValue("next_run_at") : patch.nextRunAt, patch.lastRunAt === undefined ? currentValue("last_run_at") : patch.lastRunAt,
        patch.pendingTriggerAt === undefined ? currentValue("pending_trigger_at") : patch.pendingTriggerAt,
        patch.enabled === undefined ? Number(current.enabled ?? 1) : patch.enabled ? 1 : 0, now,
        patch.target?.kind ?? text(current, "target_kind"),
        patch.target === undefined ? currentValue("target_goal_input_id") : patch.target.kind === "GOAL_CONTINUATION" ? patch.target.goalId : null,
        routineId,
      );
      const updated = connection.prepare("SELECT * FROM joi_automations WHERE routine_id = ?").get(routineId) as Row;
      if (idempotencyKey !== undefined) {
        connection.prepare("INSERT INTO joi_automation_mutations (idempotency_key, routine_id, kind, committed_at) VALUES (?, ?, 'UPDATE', ?)").run(idempotencyKey, routineId, now);
      }
      return mapRecord(connection, updated);
    });
  }

  async softDelete(routineId: string, now: string, idempotencyKey?: string): Promise<AutomationRecord | null> {
    return this.database.transaction((connection) => {
      const existingMutation = this.readMutation(connection, idempotencyKey);
      if (existingMutation !== undefined) {
        if (existingMutation.routineId !== routineId || existingMutation.kind !== "DELETE") {
          throw new DomainError("idempotency_key_conflict", "Idempotency key was already used for another automation mutation.");
        }
        const existingRow = connection.prepare("SELECT * FROM joi_automations WHERE routine_id = ?").get(routineId) as Row | undefined;
        return existingRow === undefined ? null : mapRecord(connection, existingRow);
      }
      const result = connection.prepare("UPDATE joi_automations SET enabled = 0, deleted_at = ?, updated_at = ? WHERE routine_id = ? AND deleted_at IS NULL").run(now, now, routineId);
      if (result.changes === 0) return null;
      const row = connection.prepare("SELECT * FROM joi_automations WHERE routine_id = ?").get(routineId) as Row;
      if (idempotencyKey !== undefined) {
        connection.prepare("INSERT INTO joi_automation_mutations (idempotency_key, routine_id, kind, committed_at) VALUES (?, ?, 'DELETE', ?)").run(idempotencyKey, routineId, now);
      }
      return mapRecord(connection, row);
    });
  }

  private readMutation(connection: DatabaseSync, idempotencyKey: string | undefined): { kind: "UPDATE" | "DELETE"; routineId: string } | undefined {
    if (idempotencyKey === undefined) return undefined;
    const row = connection.prepare("SELECT routine_id, kind FROM joi_automation_mutations WHERE idempotency_key = ?").get(idempotencyKey) as Row | undefined;
    if (row === undefined) return undefined;
    const routineId = row.routine_id;
    const kind = row.kind;
    if (typeof routineId !== "string" || (kind !== "UPDATE" && kind !== "DELETE")) throw new Error("automation_mutation_invalid");
    return { kind, routineId };
  }

  async runNow(input: { idempotencyKey: string; inputId: string; routineId: string; now: string }): Promise<AutomationTrigger | null> {
    return this.database.transaction((connection) => {
      const key = `automation:${input.routineId}:run-now:${input.idempotencyKey}`;
      const existing = connection.prepare("SELECT run_id, input_id FROM joi_automation_runs WHERE idempotency_key = ?").get(key) as Row | undefined;
      if (existing !== undefined) return {
        ...(typeof existing.input_id === "string" ? { inputId: existing.input_id } : {}),
        routineId: input.routineId,
        runId: text(existing, "run_id"),
      };
      const routine = connection.prepare("SELECT * FROM joi_automations WHERE routine_id = ? AND deleted_at IS NULL").get(input.routineId) as Row | undefined;
      if (routine === undefined) return null;
      const record = mapRecord(connection, routine);
      const runId = `automation_run_now:${input.routineId}:${input.idempotencyKey}`;
      if (record.target.kind === "GOAL_CONTINUATION") {
        return queueGoalContinuation(connection, record, {
          additionalMerges: 0,
          idempotencyKey: key,
          now: input.now,
          occurrenceAt: input.now,
          runId,
        });
      }
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, workbench_id, automation_routine_id, created_at, updated_at)
        VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)`).run(
        input.inputId, key, `Execute Routine once. routineId=${input.routineId}`, text(routine, "workbench_id"), input.routineId, input.now, input.now,
      );
      connection.prepare(`INSERT INTO joi_automation_runs
        (run_id, routine_id, occurrence_at, input_id, idempotency_key, triggered_at, queued_at, merge_count, status, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'PENDING', 'PENDING')`).run(runId, input.routineId, input.now, input.inputId, key, input.now, input.now);
      return { inputId: input.inputId, routineId: input.routineId, runId };
    });
  }

  async claimDue(input: { now: string; timezone: string }): Promise<AutomationTrigger[]> {
    return this.database.transaction((connection) => {
      const now = new Date(input.now);
      const rows = connection.prepare(`SELECT * FROM joi_automations
        WHERE enabled = 1 AND deleted_at IS NULL AND (
          (next_run_at IS NOT NULL AND next_run_at <= ?)
          OR EXISTS (SELECT 1 FROM joi_automation_runs blocked
            WHERE blocked.routine_id = joi_automations.routine_id
              AND blocked.status = 'BLOCKED' AND blocked.input_id IS NULL
              AND (blocked.reason_code IS NULL OR blocked.reason_code <> 'goal_canceled'))
        )
        ORDER BY next_run_at, routine_id LIMIT 50`).all(input.now) as Row[];
      const triggers: AutomationTrigger[] = [];
      for (const row of rows) {
        const routine = mapRecord(connection, row);
        const blockedRun = connection.prepare(`SELECT run_id, input_id, merge_count, occurrence_at, idempotency_key, reason_code, triggered_at
          FROM joi_automation_runs WHERE routine_id = ? AND status = 'BLOCKED' AND input_id IS NULL
          ORDER BY triggered_at DESC LIMIT 1`).get(routine.routineId) as Row | undefined;
        const nextScheduled = routine.nextRunAt === undefined ? undefined : new Date(routine.nextRunAt);
        const blockedOccurrence = typeof blockedRun?.occurrence_at === "string" ? new Date(blockedRun.occurrence_at) : undefined;
        // A blocked run remains claimable even when the next regular occurrence
        // is still in the future: recovery must enqueue the blocked occurrence,
        // never run a future one early.
        const scheduledDue = nextScheduled !== undefined && !Number.isNaN(nextScheduled.getTime()) && nextScheduled.getTime() <= now.getTime();
        let occurrence = scheduledDue ? nextScheduled : blockedOccurrence;
        if (occurrence === undefined || Number.isNaN(occurrence.getTime())) continue;
        let latest = occurrence;
        let count = 0;
        while (scheduledDue && occurrence.getTime() <= now.getTime()) {
          latest = occurrence;
          count += 1;
          const next = nextRoutineOccurrence(routine, occurrence, input.timezone);
          if (next === undefined) { occurrence = undefined; break; }
          occurrence = next;
        }
        const nextAt = scheduledDue ? occurrence?.toISOString() ?? null : routine.nextRunAt ?? null;
        if (routine.target.kind === "GOAL_CONTINUATION") {
          const active = connection.prepare(`SELECT 1 FROM joi_automation_runs
            WHERE routine_id = ? AND input_id IS NOT NULL AND status IN ('PENDING', 'RUNNING', 'BLOCKED') LIMIT 1`).get(routine.routineId);
          let trigger: AutomationTrigger | null = null;
          if (active !== undefined && scheduledDue) {
            trigger = queueDeferredContinuation(connection, routine, blockedRun, latest.toISOString(), count, input.now);
          } else if (blockedRun !== undefined || scheduledDue) {
            let occurrenceAt: string;
            if (scheduledDue) occurrenceAt = latest.toISOString();
            else {
              if (blockedRun === undefined) continue;
              occurrenceAt = text(blockedRun, "occurrence_at");
            }
            const runId = blockedRun === undefined ? `automation_run:${routine.routineId}:${occurrenceAt}` : text(blockedRun, "run_id");
            const key = blockedRun === undefined ? `automation:${routine.routineId}:${occurrenceAt}` : text(blockedRun, "idempotency_key");
            trigger = queueGoalContinuation(connection, routine, {
              additionalMerges: blockedRun === undefined ? Math.max(0, count - 1) : scheduledDue ? Math.max(0, count) : 0,
              idempotencyKey: key,
              now: input.now,
              occurrenceAt,
              runId,
            }, blockedRun);
          }
          if (scheduledDue) connection.prepare("UPDATE joi_automations SET pending_trigger_at = ?, next_run_at = ?, last_run_at = ?, updated_at = ? WHERE routine_id = ?")
            .run(latest.toISOString(), nextAt, latest.toISOString(), input.now, routine.routineId);
          if (trigger?.inputId !== undefined) triggers.push(trigger);
          continue;
        }
        const pending = connection.prepare(`SELECT run_id, input_id, occurrence_at, merge_count, reason_code, status FROM joi_automation_runs
          WHERE routine_id = ? AND status IN ('PENDING', 'RUNNING', 'BLOCKED') ORDER BY triggered_at DESC LIMIT 1`).get(routine.routineId) as Row | undefined;
        const workspace = connection.prepare("SELECT status FROM workbench_workspace_bindings WHERE workbench_id = ?").get(routine.workbenchId) as Row | undefined;
        const unavailable = typeof workspace?.status === "string" && workspace.status !== "READY";
        if (unavailable) {
          if (pending !== undefined) {
            const previousOccurrence = typeof pending.occurrence_at === "string" ? new Date(pending.occurrence_at).getTime() : Number.NaN;
            const additional = Number.isNaN(previousOccurrence) || latest.getTime() > previousOccurrence ? Math.max(0, count) : 0;
            connection.prepare(`UPDATE joi_automation_runs SET occurrence_at = ?, triggered_at = ?, merge_count = merge_count + ?, status = 'BLOCKED', result = 'BLOCKED', reason_code = 'workbench_unavailable' WHERE run_id = ?`).run(latest.toISOString(), input.now, additional, text(pending, "run_id"));
          } else {
            const occurrenceKey = latest.toISOString();
            connection.prepare(`INSERT OR IGNORE INTO joi_automation_runs
              (run_id, routine_id, occurrence_at, input_id, idempotency_key, triggered_at, queued_at, merge_count, status, result, reason_code)
              VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 'BLOCKED', 'BLOCKED', 'workbench_unavailable')`).run(
              `automation_run:${routine.routineId}:${occurrenceKey}`, routine.routineId, occurrenceKey,
              `automation:${routine.routineId}:${occurrenceKey}`, input.now, Math.max(0, count - 1),
            );
          }
          connection.prepare("UPDATE joi_automations SET pending_trigger_at = ?, next_run_at = ?, last_run_at = ?, updated_at = ? WHERE routine_id = ?").run(latest.toISOString(), nextAt, latest.toISOString(), input.now, routine.routineId);
          continue;
        }
        if (pending !== undefined) {
          if (pending.input_id === null || pending.input_id === undefined) {
            const occurrenceKey = latest.toISOString();
            const inputId = `joi_automation_input:${routine.routineId}:${occurrenceKey}`;
            const idempotencyKey = `automation:${routine.routineId}:${occurrenceKey}`;
            connection.prepare(`INSERT OR IGNORE INTO joi_inbox_messages
              (input_id, idempotency_key, body, status, workbench_id, automation_routine_id, created_at, updated_at)
              VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)`).run(inputId, idempotencyKey, `Execute Routine once. routineId=${routine.routineId}`, routine.workbenchId, routine.routineId, input.now, input.now);
            connection.prepare(`UPDATE joi_automation_runs SET occurrence_at = ?, input_id = ?, idempotency_key = ?, triggered_at = ?, queued_at = ?, merge_count = merge_count + ?, status = 'PENDING', result = 'PENDING', reason_code = NULL WHERE run_id = ?`).run(latest.toISOString(), inputId, idempotencyKey, input.now, input.now, Math.max(0, count - 1), text(pending, "run_id"));
            connection.prepare("UPDATE joi_automations SET pending_trigger_at = ?, next_run_at = ?, last_run_at = ?, updated_at = ? WHERE routine_id = ?").run(latest.toISOString(), nextAt, latest.toISOString(), input.now, routine.routineId);
            triggers.push({ inputId, routineId: routine.routineId, runId: text(pending, "run_id") });
            continue;
          }
          const pendingStatus = text(pending, "status");
          const pendingReason = optionalText(pending, "reason_code");
          const recovering = pendingStatus === "BLOCKED" && pendingReason === "workbench_unavailable";
          connection.prepare(`UPDATE joi_automation_runs SET occurrence_at = ?, triggered_at = ?, merge_count = merge_count + ?, status = ?, result = ?, reason_code = ? WHERE run_id = ?`).run(
            latest.toISOString(), input.now, Math.max(0, count), recovering ? "PENDING" : pendingStatus, recovering ? "PENDING" : pendingStatus, recovering ? null : pendingReason ?? null, text(pending, "run_id"),
          );
          connection.prepare("UPDATE joi_automations SET pending_trigger_at = ?, next_run_at = ?, last_run_at = ?, updated_at = ? WHERE routine_id = ?").run(latest.toISOString(), nextAt, latest.toISOString(), input.now, routine.routineId);
          if (typeof pending.input_id === "string") triggers.push({ inputId: pending.input_id, routineId: routine.routineId, runId: text(pending, "run_id") });
          continue;
        }
        const occurrenceKey = latest.toISOString();
        const runId = `automation_run:${routine.routineId}:${occurrenceKey}`;
        const inputId = `joi_automation_input:${routine.routineId}:${occurrenceKey}`;
        const idempotencyKey = `automation:${routine.routineId}:${occurrenceKey}`;
        connection.prepare(`INSERT OR IGNORE INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, automation_routine_id, created_at, updated_at)
          VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)`).run(
          inputId, idempotencyKey, `Execute Routine once. routineId=${routine.routineId}`, routine.workbenchId, routine.routineId, input.now, input.now,
        );
        connection.prepare(`INSERT OR IGNORE INTO joi_automation_runs
          (run_id, routine_id, occurrence_at, input_id, idempotency_key, triggered_at, queued_at, merge_count, status, result)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'PENDING')`).run(runId, routine.routineId, occurrenceKey, inputId, idempotencyKey, input.now, input.now, Math.max(0, count - 1));
        connection.prepare("UPDATE joi_automations SET pending_trigger_at = ?, next_run_at = ?, last_run_at = ?, updated_at = ? WHERE routine_id = ?").run(latest.toISOString(), nextAt, latest.toISOString(), input.now, routine.routineId);
        triggers.push({ inputId, routineId: routine.routineId, runId });
      }
      return triggers;
    });
  }
}

function queueDeferredContinuation(
  connection: DatabaseSync,
  routine: AutomationRecord,
  waiting: Row | undefined,
  occurrenceAt: string,
  occurrenceCount: number,
  now: string,
): null {
  if (waiting === undefined) {
    const runId = `automation_wait:${routine.routineId}:${occurrenceAt}`;
    connection.prepare(`INSERT OR IGNORE INTO joi_automation_runs
      (run_id, routine_id, occurrence_at, input_id, idempotency_key, triggered_at, queued_at, merge_count, status, result, reason_code)
      VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 'BLOCKED', 'BLOCKED', 'goal_not_finished')`).run(
      runId, routine.routineId, occurrenceAt, `automation:${routine.routineId}:${occurrenceAt}`, now, Math.max(0, occurrenceCount - 1),
    );
    return null;
  }
  connection.prepare(`UPDATE joi_automation_runs
    SET occurrence_at = ?, triggered_at = ?, merge_count = merge_count + ?, status = 'BLOCKED', result = 'BLOCKED', reason_code = 'goal_not_finished'
    WHERE run_id = ?`).run(occurrenceAt, now, Math.max(0, occurrenceCount), text(waiting, "run_id"));
  return null;
}

function queueGoalContinuation(
  connection: DatabaseSync,
  routine: AutomationRecord,
  occurrence: { additionalMerges: number; idempotencyKey: string; now: string; occurrenceAt: string; runId: string },
  waiting?: Row,
): AutomationTrigger | null {
  if (routine.target.kind !== "GOAL_CONTINUATION") throw new Error("automation_target_invalid");
  const goal = inspectGoal(connection, routine.target.goalId);
  if (goal === null) {
    connection.prepare("UPDATE joi_automations SET enabled = 0, deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE routine_id = ?")
      .run(occurrence.now, occurrence.now, routine.routineId);
    if (waiting !== undefined) connection.prepare(`UPDATE joi_automation_runs
      SET status = 'CANCELED', result = 'CANCELED', completed_at = ?, reason_code = 'goal_removed' WHERE run_id = ?`)
      .run(occurrence.now, text(waiting, "run_id"));
    return null;
  }
  const workspace = connection.prepare("SELECT status FROM workbench_workspace_bindings WHERE workbench_id = ?").get(goal.workbenchId) as Row | undefined;
  const reasonCode = goal.state === "CANCELED" ? "goal_canceled"
    : goal.state === "ACTIVE" ? "goal_not_finished"
      : workspace?.status !== "READY" ? "workbench_unavailable" : undefined;
  if (reasonCode !== undefined) {
    if (waiting === undefined) {
      connection.prepare(`INSERT OR IGNORE INTO joi_automation_runs
        (run_id, routine_id, occurrence_at, input_id, idempotency_key, triggered_at, queued_at, merge_count, status, result, reason_code)
        VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 'BLOCKED', 'BLOCKED', ?)`).run(
        occurrence.runId, routine.routineId, occurrence.occurrenceAt, occurrence.idempotencyKey, occurrence.now,
        occurrence.additionalMerges, reasonCode,
      );
    } else if (occurrence.additionalMerges > 0) {
      connection.prepare(`UPDATE joi_automation_runs SET occurrence_at = ?, triggered_at = ?,
        merge_count = merge_count + ?, status = 'BLOCKED', result = 'BLOCKED', reason_code = ? WHERE run_id = ?`).run(
        occurrence.occurrenceAt, occurrence.now, occurrence.additionalMerges, reasonCode, text(waiting, "run_id"),
      );
    } else if (waiting.reason_code !== reasonCode) {
      // A recovery check changes only the blocking reason, not the trigger fact.
      connection.prepare("UPDATE joi_automation_runs SET reason_code = ? WHERE run_id = ?")
        .run(reasonCode, text(waiting, "run_id"));
    }
    return null;
  }
  // archived_at is cleared with the rest of the terminal state: a routine that fires on an archived
  // goal starts it running again, and an archived card is hidden from the home feed by definition.
  const claimed = connection.prepare(`UPDATE joi_inbox_messages
    SET status = 'PENDING', archived_at = NULL, canceled_at = NULL, failed_at = NULL, failure_reason_code = NULL, failure_count = NULL,
      clarification_reason_code = NULL, clarification_prompt = NULL, automation_routine_id = ?, updated_at = ?, last_opened_at = ?, reopened_at = ?
    WHERE input_id = ? AND status = 'CONSUMED' AND dismissed_at IS NULL AND canceled_at IS NULL`).run(
    routine.routineId, occurrence.now, occurrence.now, nextGoalReopenTime(connection, goal.goalId, occurrence.now), goal.goalId,
  );
  if (claimed.changes !== 1) return null;
  connection.prepare(`UPDATE joi_harness_maps SET status = 'ACTIVE', cleared_at = NULL, feedback_recorded_at = NULL,
    revision = revision + 1, updated_at = ? WHERE goal_input_id = ? AND status = 'CLEARED'`).run(occurrence.now, goal.goalId);
  if (waiting === undefined) {
    connection.prepare(`INSERT OR IGNORE INTO joi_automation_runs
      (run_id, routine_id, occurrence_at, input_id, idempotency_key, triggered_at, queued_at, merge_count, status, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'PENDING')`).run(
      occurrence.runId, routine.routineId, occurrence.occurrenceAt, goal.goalId, occurrence.idempotencyKey,
      occurrence.now, occurrence.now, occurrence.additionalMerges,
    );
  } else {
    const triggeredAt = occurrence.additionalMerges > 0 ? occurrence.now : text(waiting, "triggered_at");
    connection.prepare(`UPDATE joi_automation_runs SET occurrence_at = ?, input_id = ?, triggered_at = ?, queued_at = ?,
      merge_count = merge_count + ?, status = 'PENDING', result = 'PENDING', reason_code = NULL, completed_at = NULL
      WHERE run_id = ?`).run(
      occurrence.occurrenceAt, goal.goalId, triggeredAt, occurrence.now, occurrence.additionalMerges, text(waiting, "run_id"),
    );
  }
  return { inputId: goal.goalId, routineId: routine.routineId, runId: occurrence.runId };
}

function mapRecord(connection: DatabaseSync, row: Row): AutomationRecord {
  const frequency = JSON.parse(text(row, "frequency_json")) as RoutineFrequency;
  const deletedAt = optionalText(row, "deleted_at");
  const from = optionalText(row, "from_date");
  const to = optionalText(row, "to_date");
  const lastRunAt = optionalText(row, "last_run_at");
  const pendingTriggerAt = optionalText(row, "pending_trigger_at");
  const preferredPartnerId = optionalText(row, "preferred_partner_id");
  const createIdempotencyKey = optionalText(row, "create_idempotency_key");
  const targetKind = optionalText(row, "target_kind") ?? "NEW_GOAL";
  const targetGoalId = optionalText(row, "target_goal_input_id");
  if (targetKind !== "NEW_GOAL" && targetKind !== "GOAL_CONTINUATION") throw new Error("automation_record_invalid");
  if (targetKind === "GOAL_CONTINUATION" && targetGoalId === undefined) throw new Error("automation_record_invalid");
  const routine = createRoutine({
    createdAt: text(row, "created_at"),
    ...(deletedAt === undefined ? {} : { deletedAt }),
    enabled: Number(row.enabled ?? 0) === 1,
    ...(from === undefined ? {} : { from }),
    frequency,
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
    name: text(row, "name"),
    ...(pendingTriggerAt === undefined ? {} : { pendingTriggerAt }),
    ...(preferredPartnerId === undefined ? {} : { preferredPartnerId }),
    prompt: text(row, "prompt",),
    routineId: text(row, "routine_id"),
    target: mapTarget(targetKind, targetGoalId),
    ...(to === undefined ? {} : { to }),
    workbenchId: text(row, "workbench_id"),
  });
  const runs = (connection.prepare(`SELECT r.*, i.status AS inbox_status, i.failed_at AS inbox_failed_at, i.failure_reason_code AS inbox_failure_reason,
      i.canceled_at AS inbox_canceled_at, t.status AS turn_status, t.updated_at AS turn_updated_at, c.completed_at AS completion_at
    FROM joi_automation_runs r LEFT JOIN joi_inbox_messages i ON i.input_id = r.input_id
    LEFT JOIN joi_turns t ON t.input_id = r.input_id AND t.turn_id = (SELECT turn_id FROM joi_turns WHERE input_id = r.input_id ORDER BY created_at DESC LIMIT 1)
    LEFT JOIN joi_turn_completions c ON c.input_id = r.input_id
    WHERE r.routine_id = ? ORDER BY r.occurrence_at DESC LIMIT 100`).all(routine.routineId) as Row[]).map((run) => mapRun(run));
  const nextRunAt = optionalText(row, "next_run_at");
  return { ...routine, ...(createIdempotencyKey === undefined ? {} : { createIdempotencyKey }), ...(nextRunAt === undefined ? {} : { nextRunAt }), runs };
}

function mapTarget(kind: "NEW_GOAL" | "GOAL_CONTINUATION", goalId: string | undefined): AutomationRecord["target"] {
  if (kind === "NEW_GOAL") return { kind };
  if (goalId === undefined) throw new Error("automation_record_invalid");
  return { goalId, kind };
}

function inspectGoal(connection: DatabaseSync, goalId: string): AutomationGoalInspection | null {
  const row = connection.prepare(`SELECT input_id, status, workbench_id, canceled_at, failed_at
    FROM joi_inbox_messages
    WHERE input_id = ? AND dismissed_at IS NULL AND goal_input_id IS NULL
      AND input_id NOT LIKE 'joi_result_input:%'
      AND input_id NOT LIKE 'joi_harness_review:%'
      AND input_id NOT LIKE 'joi_signal_input:%'`).get(goalId) as Row | undefined;
  if (row === undefined || typeof row.workbench_id !== "string") return null;
  const activeWork = connection.prepare(`SELECT 1 FROM work_items w LEFT JOIN partner_runs pr ON pr.work_id = w.work_id
    WHERE w.input_id = ? AND (w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED')
      OR pr.status IN ('RUNNING', 'WAITING_INPUT', 'WAITING_AUTH')) LIMIT 1`).get(goalId);
  const currentOutcome = connection.prepare(`SELECT o.disposition FROM joi_goal_result_sets s
    JOIN joi_current_goal_outcomes o ON o.input_id = s.original_input_id AND o.result_revision = s.revision
    WHERE s.original_input_id = ? AND s.revision > 0`).get(goalId) as Row | undefined;
  const activeMap = connection.prepare("SELECT 1 FROM joi_harness_maps WHERE goal_input_id = ? AND status = 'ACTIVE' LIMIT 1").get(goalId);
  const failedOutcome = currentOutcome?.disposition === "BLOCKED";
  const state: AutomationGoalInspection["state"] = typeof row.canceled_at === "string" ? "CANCELED"
    : activeWork !== undefined ? "ACTIVE"
      : typeof row.failed_at === "string" || failedOutcome ? "FAILED"
        : row.status !== "CONSUMED" || activeMap !== undefined ? "ACTIVE"
          : "COMPLETED";
  return { goalId: text(row, "input_id"), state, workbenchId: text(row, "workbench_id") };
}

function mapRun(row: Row): AutomationRunRecord {
  const inbox = row.inbox_status;
  const turn = row.turn_status;
  let status = String(row.status) as AutomationRunRecord["status"];
  let result = String(row.result) as AutomationRunRecord["result"];
  // A continuation deliberately reuses the original goal input. Ignore terminal
  // timestamps from an earlier conversation round when projecting the new run.
  const runStartedAt = typeof row.queued_at === "string" ? row.queued_at : text(row, "triggered_at");
  const completedThisRun = occurredAtOrAfter(row.completion_at, runStartedAt);
  const failedThisRun = occurredAtOrAfter(row.inbox_failed_at, runStartedAt);
  const canceledThisRun = occurredAtOrAfter(row.inbox_canceled_at, runStartedAt);
  const turnThisRun = occurredAtOrAfter(row.turn_updated_at, runStartedAt);
  if (completedThisRun) { status = "COMPLETED"; result = "COMPLETED"; }
  else if (failedThisRun || (turnThisRun && turn === "FAILED")) { status = "FAILED"; result = "FAILED"; }
  else if (canceledThisRun) { status = "CANCELED"; result = "CANCELED"; }
  else if (inbox === "CONSUMED") { status = "COMPLETED"; result = "COMPLETED"; }
  else if (turnThisRun && turn === "RUNNING") { status = "RUNNING"; result = "RUNNING"; }
  else if (inbox === "CLARIFICATION_REQUIRED") { status = "BLOCKED"; result = "BLOCKED"; }
  return {
    ...(completedThisRun && typeof row.completion_at === "string" ? { completedAt: row.completion_at } : {}),
    ...(typeof row.input_id === "string" ? { inputId: row.input_id } : {}),
    occurrenceAt: text(row, "occurrence_at"),
    ...(typeof row.queued_at === "string" ? { queuedAt: row.queued_at } : {}),
    ...(typeof row.reason_code === "string" ? { reasonCode: row.reason_code } : typeof row.inbox_failure_reason === "string" ? { reasonCode: row.inbox_failure_reason } : {}),
    result, runId: text(row, "run_id"), mergeCount: typeof row.merge_count === "number" ? row.merge_count : 0,
    status, triggeredAt: text(row, "triggered_at"),
  };
}

function occurredAtOrAfter(value: unknown, threshold: string): boolean {
  if (typeof value !== "string") return false;
  const eventTime = Date.parse(value);
  const runTime = Date.parse(threshold);
  return Number.isFinite(eventTime) && Number.isFinite(runTime) && eventTime >= runTime;
}
