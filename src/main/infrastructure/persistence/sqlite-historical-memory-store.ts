import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HISTORICAL_MEMORY_KIND, JOI_MEMORY_OWNER, type HistoricalMemoryCompaction, type HistoricalMemoryStore, type HistoricalMemoryUpdate } from "../../application/ports/historical-memory.js";
import { historicalCharacters, renderHistoricalContext, type HistoricalEntry, type HistoricalScope } from "../../domain/work/historical-context.js";
import { storageEngine } from "./partner-engine-storage.js";
import type { RuntimeDatabase } from "./runtime-database.js";

interface HistoricalSource {
  source_id: string;
  workbench_id: string;
  kind: "goal" | "direct" | "partner";
  subject_id: string;
  version: string;
  created_at: string;
}

const goalSource = `SELECT json_array(o.result_revision,COALESCE(o.requirements_revision,0),o.completed_at) AS version,
    o.disposition, substr(m.destination,1,100) AS label, COALESCE(o.requirements_revision,0) AS requirements_revision
  FROM joi_current_goal_outcomes o JOIN joi_harness_maps m ON m.goal_input_id=o.input_id JOIN joi_inbox_messages i ON i.input_id=o.input_id
  WHERE o.input_id=? AND m.workbench_id=? AND m.status='CLEARED' AND m.feedback_recorded_at IS NOT NULL
    AND i.canceled_at IS NULL AND i.dismissed_at IS NULL AND (i.reopened_at IS NULL OR i.reopened_at <= o.completed_at)
    AND o.disposition IN ('COMPLETED','ACCEPTED_WITH_GAPS')`;
const directSource = `SELECT json_array(c.turn_id,COALESCE(r.revision,0),c.completed_at) AS version,
    COALESCE(r.revision,0) AS requirements_revision
  FROM joi_turn_completions c JOIN joi_inbox_messages i USING(input_id)
  LEFT JOIN joi_goal_requirements r ON r.goal_input_id=i.input_id
  WHERE c.input_id=? AND i.workbench_id=? AND c.outcome_kind='DIRECT_ANSWER' AND i.status='CONSUMED'
    AND i.canceled_at IS NULL AND i.dismissed_at IS NULL AND (i.reopened_at IS NULL OR i.reopened_at <= c.completed_at)
    AND i.goal_input_id IS NULL`;
const partnerSource = `SELECT p.partner_id, r.partner_revision_id, r.instance_id, r.work_id, r.action_id,v.status AS verification
  FROM work_results r JOIN work_result_verifications v USING(result_id) JOIN partner_revisions pr USING(partner_revision_id)
  JOIN partners p USING(partner_id) JOIN work_items w USING(work_id)
  WHERE r.result_id=? AND r.workbench_id=? AND p.status='ACTIVE' AND p.kind='LOCAL_PI'
    AND pr.engine='${storageEngine("pi-core")}' AND r.status='COMPLETED' AND r.is_authoritative=1 AND r.is_late=0 AND w.status='COMPLETED'
    AND v.status IN ('PASSED','NOT_REQUIRED')
    AND r.action_id=(SELECT a.action_id FROM dispatch_attempts a WHERE a.work_id=r.work_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1)`;

/** Source identity and outbox receipts commit with the existing completion transaction. */
export function enqueueHistoricalMemory(db: DatabaseSync, input: { workbenchId: string; kind: "goal" | "partner"; subjectId: string; now: string }): void {
  const query = input.kind === "goal" ? goalSource : partnerSource;
  const eligible = db.prepare(query).get(input.subjectId,input.workbenchId);
  if (eligible === undefined) return;
  const version = input.kind === "partner" ? input.subjectId : String(eligible.version);
  const sourceId = `history:${createHash("sha256").update(JSON.stringify([input.workbenchId,input.kind,input.subjectId,version])).digest("hex")}`;
  const inserted = db.prepare(`INSERT INTO historical_memory_sources VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .run(sourceId,input.workbenchId,input.kind,input.subjectId,version,input.now);
  if (inserted.changes > 0 && input.kind !== "partner") {
    const source = { source_id: sourceId,workbench_id: input.workbenchId,kind: input.kind,subject_id: input.subjectId,version,created_at: input.now };
    const facts = captureFacts(db,source,Number(eligible.requirements_revision));
    const preferences = capturePreferences(db,source,eligible.disposition);
    db.prepare("INSERT INTO historical_memory_settlements VALUES (?,?,?)")
      .run(sourceId,JSON.stringify(facts),JSON.stringify(preferences));
  }
  for (const scope of input.kind === "partner" ? ["partner"] : ["workbench","joi"]) {
    db.prepare(`INSERT INTO outbox (outbox_id,kind,payload_json,status,attempt_count,available_at,created_at)
      VALUES (?,?,?,'PENDING',0,?,?) ON CONFLICT DO NOTHING`)
      .run(`${sourceId}:${scope}`,HISTORICAL_MEMORY_KIND,JSON.stringify({ sourceId,scope }),input.now,input.now);
  }
}

function current(db: DatabaseSync, source: HistoricalSource) {
  if (db.prepare("SELECT 1 FROM workbenches WHERE workbench_id=? AND status='ACTIVE'").get(source.workbench_id) === undefined) return undefined;
  const row = db.prepare(source.kind === "goal" ? goalSource : source.kind === "direct" ? directSource : partnerSource)
    .get(source.subject_id,source.workbench_id);
  return row !== undefined && (source.kind === "partner" || row.version === source.version) ? row : undefined;
}

function sourceById(db: DatabaseSync, id: string): HistoricalSource | undefined {
  return db.prepare("SELECT * FROM historical_memory_sources WHERE source_id=?").get(id) as HistoricalSource | undefined;
}

function conclusionQuery(source: HistoricalSource): string {
  return source.kind === "direct" ? "SELECT completion_summary AS body FROM joi_turn_completions WHERE input_id=?"
    : "SELECT completion_summary AS body FROM joi_current_goal_outcomes WHERE input_id=?";
}

function captureFacts(db: DatabaseSync, source: HistoricalSource, requirementsRevision: number): HistoricalMemoryUpdate["facts"] {
  const summary = db.prepare(`SELECT CASE WHEN length(body) <= 8000 THEN body
      ELSE substr(body,1,4000) || char(10) || '[omitted]' || char(10) || substr(body,-3989) END AS conclusion
    FROM (${conclusionQuery(source)})`).get(source.subject_id);
  const requirements = db.prepare(`SELECT requirements_json AS summary FROM joi_goal_requirement_snapshots
    WHERE goal_input_id=? AND revision=?`).get(source.subject_id,requirementsRevision);
  return { conclusion: String(summary?.conclusion ?? ""),requirements: String(requirements?.summary ?? "") };
}

function capturePreferences(db: DatabaseSync, source: HistoricalSource, disposition: unknown): HistoricalEntry[] {
  const original = db.prepare("SELECT body AS text FROM joi_inbox_messages WHERE input_id=? AND workbench_id=?")
    .get(source.subject_id,source.workbench_id);
  const preferences = String(original?.text ?? "").split(/\r?\n/u).flatMap((line): HistoricalEntry[] => {
    const labeled = /^\s*(?:全局偏好|跨工作台偏好|global preference)(?:\[([^\]\n]{1,40})\])?\s*[:：]\s*(.+)\s*$/iu.exec(line);
    const explicit = /^\s*(?:(?:以后|今后)[，,]?\s*(?:在|对)?所有工作台[，,]?\s*|from now on[, ]+in (?:all|every) workbench(?:es)?[, ]+)\s*(.+)\s*$/iu.exec(line);
    const preference = labeled?.[2] ?? explicit?.[1];
    const key = labeled?.[1]?.trim().toLowerCase();
    return preference === undefined ? [] : [{ section: "preferences",text: preference,source: source.source_id,...(key ? { key } : {}) }];
  });
  if (disposition === "ACCEPTED_WITH_GAPS") preferences.push({
    section: "orchestration",text: "When a user accepts an outcome with gaps, carry the unresolved conditions into any later continuation.",source: source.source_id,
  });
  return renderHistoricalContext("joi",preferences).entries;
}

function readMemory(db: DatabaseSync, scope: HistoricalScope, ownerId: string) {
  const row = db.prepare("SELECT revision,entries_json FROM historical_memories WHERE scope=? AND owner_id=?").get(scope,ownerId);
  const saved = row === undefined ? [] : JSON.parse(String(row.entries_json)) as HistoricalEntry[];
  const valid = new Map<string,boolean>();
  const entries = saved.filter(entry => {
    if (entry.source === undefined) return false;
    const known = valid.get(entry.source);
    if (known !== undefined) return known;
    const origin = sourceById(db,entry.source);
    const active = origin !== undefined && current(db,origin) !== undefined;
    valid.set(entry.source,active);
    return active;
  });
  return { revision: Number(row?.revision ?? 0), entries };
}

export class SqliteHistoricalMemoryStore implements HistoricalMemoryStore {
  constructor(private readonly database: Pick<RuntimeDatabase,"transaction">) {}

  entries(scope: HistoricalScope, ownerId: string): HistoricalEntry[] {
    return this.database.transaction(db => readMemory(db,scope,ownerId).entries,"deferred");
  }

  readEvidence(workbenchId: string, sourceId: string, offset: number, limit: number, part: "input" | "conclusion" = "input"): { text: string; total: number } | null {
    return this.database.transaction(db => {
      const source = sourceById(db,sourceId);
      if (source?.workbench_id !== workbenchId || source.kind === "partner" || current(db,source) === undefined) return null;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) return null;
      const lookup = part === "input" ? "SELECT body FROM joi_inbox_messages WHERE input_id=?"
        : conclusionQuery(source);
      const row = db.prepare(`SELECT substr(body,? + 1,?) AS chunk,length(body) AS total FROM (${lookup})`)
        .get(offset,Math.min(limit,4000),source.subject_id);
      return typeof row?.chunk === "string" && typeof row.total === "number" ? { text: row.chunk,total: row.total } : null;
    },"deferred");
  }

  loadUpdate(sourceId: string, scope: HistoricalScope): HistoricalMemoryUpdate | null {
    return this.database.transaction(db => {
      const source = sourceById(db,sourceId);
      if (source === undefined || (source.kind === "partner") !== (scope === "partner")
        || db.prepare("SELECT 1 FROM historical_memory_receipts WHERE source_id=? AND scope=?").get(sourceId,scope) !== undefined) return null;
      const row = current(db,source);
      if (row === undefined) return null;
      const ownerId = scope === "joi" ? JOI_MEMORY_OWNER : scope === "partner" ? String(row.partner_id) : source.workbench_id;
      const prior = readMemory(db,scope,ownerId);
      const base = { ...prior, scope, ownerId, sourceId, workbenchId: source.workbench_id };
      if (scope === "partner") return { ...base, facts: { verification: String(row.verification) },
        partner: { revisionId: String(row.partner_revision_id),workId: String(row.work_id),actionId: String(row.action_id),
          ...(typeof row.instance_id === "string" ? { instanceId: row.instance_id } : {}) } };
      const settlement = db.prepare("SELECT facts_json,preferences_json FROM historical_memory_settlements WHERE source_id=?").get(sourceId);
      if (scope === "joi") {
        const explicitPreferences = settlement === undefined ? capturePreferences(db,source,row.disposition)
          : JSON.parse(String(settlement.preferences_json)) as HistoricalEntry[];
        return { ...base,facts: {},explicitPreferences };
      }
      const facts = settlement === undefined ? captureFacts(db,source,Number(row.requirements_revision))
        : JSON.parse(String(settlement.facts_json)) as HistoricalMemoryUpdate["facts"];
      const label = typeof row.label === "string" && row.label.trim() !== "" ? ` · ${row.label}` : "";
      const index = { section: "sources" as const,text: `${source.created_at.slice(0,10)} · Input and conclusion for ${row.disposition === "ACCEPTED_WITH_GAPS" ? "goal accepted with gaps" : "completed goal"}${label}`,source: sourceId };
      return { ...base,facts,index };
    },"deferred");
  }

  commit(update: HistoricalMemoryUpdate, entries: HistoricalEntry[], compacted: readonly HistoricalMemoryCompaction[] = []): boolean {
    return this.database.transaction(db => {
      const source = sourceById(db,update.sourceId);
      if (source === undefined || current(db,source) === undefined) return false;
      const receipt = db.prepare(`INSERT INTO historical_memory_receipts VALUES (?,?) ON CONFLICT DO NOTHING`).run(update.sourceId,update.scope);
      if (receipt.changes === 0) return false;
      const prior = readMemory(db,update.scope,update.ownerId);
      if (prior.revision !== update.revision) throw new Error("historical_memory_revision_changed");
      const candidates = entries.filter(entry => entry.source === source.source_id);
      const accepted = update.scope === "joi" ? acceptCurrentPreferences(db,source,candidates) : candidates;
      const older = applyCompaction(update.scope,prior.entries,accepted,compacted);
      const retained = renderHistoricalContext(update.scope,[...accepted,...older]).entries;
      if (JSON.stringify(prior.entries) === JSON.stringify(retained)) return true;
      db.prepare(`INSERT INTO historical_memories VALUES (?,?,?,?) ON CONFLICT(scope,owner_id) DO UPDATE SET
        revision=excluded.revision,entries_json=excluded.entries_json`).run(update.scope,update.ownerId,prior.revision + 1,JSON.stringify(retained));
      return true;
    });
  }
}

function applyCompaction(scope: HistoricalScope, prior: HistoricalEntry[], incoming: HistoricalEntry[],
  compacted: readonly HistoricalMemoryCompaction[]): HistoricalEntry[] {
  if (compacted.length === 0) return prior;
  const replacements = new Map(compacted.map(({ before,text }) => [JSON.stringify(before),text]));
  const factKey = (entry: HistoricalEntry) => `${entry.section}\n${entry.text}`;
  const occupied = new Set([...prior,...incoming].map(factKey));
  return prior.map(entry => {
    const text = replacements.get(JSON.stringify(entry));
    if (text === undefined) return entry;
    const original = { ...entry,compacted: true as const };
    const replacement = renderHistoricalContext(scope,[{ ...original,text }]).entries[0];
    if (replacement === undefined || historicalCharacters(replacement.text) >= historicalCharacters(entry.text)
      || occupied.has(factKey(replacement))) return original;
    occupied.add(factKey(replacement));
    return replacement;
  });
}

function acceptCurrentPreferences(db: DatabaseSync, source: HistoricalSource, candidates: HistoricalEntry[]): HistoricalEntry[] {
  const advance = db.prepare(`INSERT INTO historical_preference_watermarks (topic,input_created_at,input_sequence)
    SELECT ?, created_at, rowid FROM joi_inbox_messages WHERE input_id=? AND workbench_id=?
    ON CONFLICT(topic) DO UPDATE SET input_created_at=excluded.input_created_at,input_sequence=excluded.input_sequence
    WHERE (excluded.input_created_at,excluded.input_sequence) >
      (historical_preference_watermarks.input_created_at,historical_preference_watermarks.input_sequence)`);
  return renderHistoricalContext("joi",candidates).entries.filter(entry =>
    entry.section !== "preferences" || entry.key === undefined || advance.run(entry.key,source.subject_id,source.workbench_id).changes > 0);
}
