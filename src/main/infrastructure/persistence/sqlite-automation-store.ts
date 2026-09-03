/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { AutomationRecord, AutomationRunRecord, AutomationStore, AutomationTrigger } from "../../application/ports/automation.js";
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

  async create(record: AutomationRecord): Promise<AutomationRecord> {
    this.database.transaction((connection) => {
      if (record.createIdempotencyKey !== undefined) {
        const existing = connection.prepare("SELECT routine_id FROM joi_automations WHERE create_idempotency_key = ?").get(record.createIdempotencyKey);
        if (existing !== undefined) return;
      }
      const count = connection.prepare("SELECT COUNT(*) AS count FROM joi_automations WHERE deleted_at IS NULL").get() as Row;
      if (typeof count.count !== "number" || count.count >= 30) throw new DomainError("routine_limit_reached", "At most 30 routines are allowed.");
      connection.prepare(`INSERT INTO joi_automations
        (routine_id, create_idempotency_key, name, prompt, frequency_json, workbench_id, preferred_partner_id, from_date, to_date,
         next_run_at, last_run_at, pending_trigger_at, enabled, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(create_idempotency_key) DO NOTHING`).run(
        record.routineId, record.createIdempotencyKey ?? null, record.name, record.prompt, JSON.stringify(record.frequency), record.workbenchId,
        record.preferredPartnerId ?? null, record.from ?? null, record.to ?? null, record.nextRunAt ?? null,
        record.lastRunAt ?? null, record.pendingTriggerAt ?? null, record.enabled ? 1 : 0, record.deletedAt ?? null,
        record.createdAt, record.createdAt,
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

  async update(routineId: string, patch: { enabled?: boolean; from?: string | null; frequency?: RoutineFrequency; name?: string; pendingTriggerAt?: string | null; preferredPartnerId?: string | null; prompt?: string; to?: string | null; workbenchId?: string; nextRunAt?: string | null; lastRunAt?: string | null }, idempotencyKey?: string): Promise<AutomationRecord | null> {
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
      const now = new Date().toISOString();
      const currentValue = (key: string): string | null => typeof current[key] === "string" ? current[key] : null;
      connection.prepare(`UPDATE joi_automations SET
        name = ?, prompt = ?, frequency_json = ?, workbench_id = ?, preferred_partner_id = ?,
        from_date = ?, to_date = ?, next_run_at = ?, last_run_at = ?, pending_trigger_at = ?, enabled = ?, updated_at = ?
        WHERE routine_id = ? AND deleted_at IS NULL`).run(
        patch.name ?? text(current, "name"), patch.prompt ?? text(current, "prompt"), JSON.stringify(patch.frequency ?? JSON.parse(text(current, "frequency_json"))),
        patch.workbenchId ?? text(current, "workbench_id"), patch.preferredPartnerId === undefined ? currentValue("preferred_partner_id") : patch.preferredPartnerId,
        patch.from === undefined ? currentValue("from_date") : patch.from, patch.to === undefined ? currentValue("to_date") : patch.to,
        patch.nextRunAt === undefined ? currentValue("next_run_at") : patch.nextRunAt, patch.lastRunAt === undefined ? currentValue("last_run_at") : patch.lastRunAt,
        patch.pendingTriggerAt === undefined ? currentValue("pending_trigger_at") : patch.pendingTriggerAt,
        patch.enabled === undefined ? Number(current.enabled ?? 1) : patch.enabled ? 1 : 0, now, routineId,
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
      if (existing !== undefined) return { inputId: text(existing, "input_id"), routineId: input.routineId, runId: text(existing, "run_id") };
      const routine = connection.prepare("SELECT * FROM joi_automations WHERE routine_id = ? AND deleted_at IS NULL").get(input.routineId) as Row | undefined;
      if (routine === undefined) return null;
      const runId = `automation_run_now:${input.routineId}:${input.idempotencyKey}`;
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
              AND blocked.status = 'BLOCKED' AND blocked.reason_code = 'workbench_unavailable')
        )
        ORDER BY next_run_at, routine_id LIMIT 50`).all(input.now) as Row[];
      const triggers: AutomationTrigger[] = [];
      for (const row of rows) {
        const routine = mapRecord(connection, row);
        const blockedRun = connection.prepare(`SELECT run_id, input_id, merge_count, occurrence_at, idempotency_key
          FROM joi_automation_runs WHERE routine_id = ? AND status = 'BLOCKED' AND reason_code = 'workbench_unavailable'
          ORDER BY triggered_at DESC LIMIT 1`).get(routine.routineId) as Row | undefined;
        const nextScheduled = routine.nextRunAt === undefined ? undefined : new Date(routine.nextRunAt);
        const blockedOccurrence = typeof blockedRun?.occurrence_at === "string" ? new Date(blockedRun.occurrence_at) : undefined;
        // A blocked run remains claimable even when the next regular occurrence
        // is still in the future: recovery must enqueue the blocked occurrence,
        // never run a future one early.
        let occurrence = nextScheduled !== undefined && !Number.isNaN(nextScheduled.getTime()) && nextScheduled.getTime() <= now.getTime()
          ? nextScheduled : blockedOccurrence;
        if (occurrence === undefined || Number.isNaN(occurrence.getTime())) continue;
        let latest = occurrence;
        let count = 0;
        while (occurrence.getTime() <= now.getTime()) {
          latest = occurrence;
          count += 1;
          const next = nextRoutineOccurrence(routine, occurrence, input.timezone);
          if (next === undefined) { occurrence = undefined; break; }
          occurrence = next;
        }
        const nextAt = occurrence?.toISOString() ?? null;
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

function mapRecord(connection: DatabaseSync, row: Row): AutomationRecord {
  const frequency = JSON.parse(text(row, "frequency_json")) as RoutineFrequency;
  const deletedAt = optionalText(row, "deleted_at");
  const from = optionalText(row, "from_date");
  const to = optionalText(row, "to_date");
  const lastRunAt = optionalText(row, "last_run_at");
  const pendingTriggerAt = optionalText(row, "pending_trigger_at");
  const preferredPartnerId = optionalText(row, "preferred_partner_id");
  const createIdempotencyKey = optionalText(row, "create_idempotency_key");
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
    ...(to === undefined ? {} : { to }),
    workbenchId: text(row, "workbench_id"),
  });
  const runs = (connection.prepare(`SELECT r.*, i.status AS inbox_status, i.failed_at AS inbox_failed_at, i.failure_reason_code AS inbox_failure_reason,
      i.canceled_at AS inbox_canceled_at, t.status AS turn_status, c.completed_at AS completion_at
    FROM joi_automation_runs r LEFT JOIN joi_inbox_messages i ON i.input_id = r.input_id
    LEFT JOIN joi_turns t ON t.input_id = r.input_id AND t.turn_id = (SELECT turn_id FROM joi_turns WHERE input_id = r.input_id ORDER BY created_at DESC LIMIT 1)
    LEFT JOIN joi_turn_completions c ON c.input_id = r.input_id
    WHERE r.routine_id = ? ORDER BY r.occurrence_at DESC LIMIT 100`).all(routine.routineId) as Row[]).map((run) => mapRun(run));
  const nextRunAt = optionalText(row, "next_run_at");
  return { ...routine, ...(createIdempotencyKey === undefined ? {} : { createIdempotencyKey }), ...(nextRunAt === undefined ? {} : { nextRunAt }), runs };
}

function mapRun(row: Row): AutomationRunRecord {
  const inbox = row.inbox_status;
  const turn = row.turn_status;
  let status = String(row.status) as AutomationRunRecord["status"];
  let result = String(row.result) as AutomationRunRecord["result"];
  if (typeof row.completion_at === "string") { status = "COMPLETED"; result = "COMPLETED"; }
  else if (typeof row.inbox_failed_at === "string" || turn === "FAILED") { status = "FAILED"; result = "FAILED"; }
  else if (typeof row.inbox_canceled_at === "string") { status = "CANCELED"; result = "CANCELED"; }
  else if (inbox === "CONSUMED") { status = "COMPLETED"; result = "COMPLETED"; }
  else if (turn === "RUNNING") { status = "RUNNING"; result = "RUNNING"; }
  else if (inbox === "CLARIFICATION_REQUIRED") { status = "BLOCKED"; result = "BLOCKED"; }
  return {
    ...(typeof row.completion_at === "string" ? { completedAt: row.completion_at } : {}),
    ...(typeof row.input_id === "string" ? { inputId: row.input_id } : {}),
    occurrenceAt: text(row, "occurrence_at"),
    ...(typeof row.queued_at === "string" ? { queuedAt: row.queued_at } : {}),
    ...(typeof row.reason_code === "string" ? { reasonCode: row.reason_code } : typeof row.inbox_failure_reason === "string" ? { reasonCode: row.inbox_failure_reason } : {}),
    result, runId: text(row, "run_id"), mergeCount: typeof row.merge_count === "number" ? row.merge_count : 0,
    status, triggeredAt: text(row, "triggered_at"),
  };
}
