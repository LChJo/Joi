import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { JsonObject, MethodEvidenceRead, MethodExperiment, MethodGoalPin, MethodLearningControl, MethodLearningParticipant, MethodLearningStore, MethodRevision, MethodTrialKey } from "../../application/ports/method-learning.js";
import { buildLearningCases, type LearningCase, type LearningFacts } from "../../domain/evolution/learning-case.js";
import { DomainError } from "../../domain/errors.js";
import { validateTokenUsage } from "../../domain/statistics/statistics.js";

interface Database { transaction<T>(operation: (db: DatabaseSync) => T): T; }
type Row = Record<string, unknown>;
const parse = <T>(row: Row | undefined, field = "state_json", fallback: T | null = null): T | null => row === undefined ? fallback : JSON.parse(String(row[field])) as T;
function required<T>(value: T | null): T {
  if (value === null) throw new DomainError("evolution_state_missing", "Required learning state is missing.");
  return value;
}
const trialKey = (key: MethodTrialKey): string => JSON.stringify([key.source,key.model,key.tool,key.evaluator,key.parent,key.caseId,key.attempt]);
const factsFingerprint = (fact: LearningFacts): string => JSON.stringify([fact.requirementsRevision,fact.resultRevision,fact.observedAt,Number(fact.completed),Number(fact.canceled),fact.verified,fact.failed,fact.unverified,fact.requirementCount,fact.coveredRequirementCount,fact.foreignEvidenceCount,fact.dependencyViolationCount,fact.redundantReads,Number(fact.executionFailed),Number(fact.environmentFailed)]);
function assertWorkbench(db: DatabaseSync, id: string): void {
  if (!db.prepare("SELECT 1 FROM workbenches WHERE workbench_id=? AND status='ACTIVE'").get(id)) throw new DomainError("workbench_not_found", "Workbench was not found.");
}
function assertGoal(db: DatabaseSync, workbench: string, goal: string): void {
  if (!db.prepare("SELECT 1 FROM joi_inbox_messages WHERE input_id=? AND workbench_id=? AND goal_input_id IS NULL").get(goal,workbench)) throw new DomainError("evolution_goal_invalid", "Goal does not belong to this workbench.");
}
function participant(db: DatabaseSync, id: string): MethodLearningParticipant {
  assertWorkbench(db,id);
  return parse<MethodLearningParticipant>(db.prepare("SELECT state_json FROM method_learning_participants WHERE workbench_id=?").get(id)) ?? { enabled:false,paused:false,dailyCallLimit:150,reason:"disabled" };
}
function control(db: DatabaseSync): MethodLearningControl {
  return required(parse<MethodLearningControl>(db.prepare("SELECT state_json FROM method_learning_control WHERE singleton=1").get()));
}
function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100000) throw new DomainError("evolution_budget_invalid", "The daily limit is invalid.");
}
function callCount(db: DatabaseSync, day: string, workbench?: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM (
    SELECT call_id FROM method_learning_calls WHERE day=? AND (? IS NULL OR workbench_id=?)
    UNION SELECT outbox_id FROM outbox WHERE kind='evolution.model' AND substr(created_at,1,10)=?
      AND (? IS NULL OR json_extract(payload_json,'$.workbenchId')=?)
  )`).get(day,workbench ?? null,workbench ?? null,day,workbench ?? null,workbench ?? null)?.total ?? 0);
}
function persistExperiment(db: DatabaseSync, value: MethodExperiment): void {
  db.prepare("INSERT INTO method_learning_experiments VALUES (?,?,?,?) ON CONFLICT(experiment_id) DO UPDATE SET status=excluded.status,state_json=excluded.state_json").run(value.id,value.status,value.createdAt,JSON.stringify(value));
  const ids = new Set<string>();
  if (Array.isArray(value.state.caseIds)) for (const id of value.state.caseIds) if (typeof id === "string") ids.add(id);
  if (Array.isArray(value.state.dataset)) for (const item of value.state.dataset) {
    if (item !== null && typeof item === "object" && !Array.isArray(item) && typeof item.caseId === "string") ids.add(item.caseId);
  }
  for (const id of ids) db.prepare("INSERT OR IGNORE INTO method_learning_case_references SELECT ?,case_id FROM method_learning_cases WHERE case_id=?").run(value.id,id);
}

export class SqliteMethodLearningStore implements MethodLearningStore {
  constructor(private readonly database: Database) {}
  control(): MethodLearningControl { return this.database.transaction(control); }
  configureGlobal(patch: Partial<MethodLearningControl>): MethodLearningControl {
    return this.database.transaction(db => {
      const value = {...control(db),...patch}; validateLimit(value.dailyCallLimit);
      db.prepare("UPDATE method_learning_control SET state_json=? WHERE singleton=1").run(JSON.stringify(value)); return value;
    });
  }
  participant(id: string): MethodLearningParticipant { return this.database.transaction(db => participant(db,id)); }
  configureParticipant(id: string, patch: Partial<MethodLearningParticipant>): MethodLearningParticipant {
    return this.database.transaction(db => {
      const value = {...participant(db,id),...patch}; validateLimit(value.dailyCallLimit);
      db.prepare("INSERT INTO method_learning_participants VALUES (?,?) ON CONFLICT(workbench_id) DO UPDATE SET state_json=excluded.state_json").run(id,JSON.stringify(value)); return value;
    });
  }
  reserveCall(input: Parameters<MethodLearningStore["reserveCall"]>[0]): ReturnType<MethodLearningStore["reserveCall"]> {
    return this.database.transaction(db => {
      if (input.checkpoint !== undefined && (input.checkpoint.id !== input.experimentId || input.checkpoint.workbenchId !== input.workbenchId)) throw new DomainError("evolution_checkpoint_invalid", "Checkpoint does not belong to this reservation.");
      const prior = db.prepare("SELECT experiment_id,workbench_id,day FROM method_learning_calls WHERE call_id=?").get(input.callId);
      if (prior) {
        if (prior.experiment_id !== input.experimentId || prior.workbench_id !== input.workbenchId || prior.day !== input.day) throw new DomainError("evolution_call_identity_invalid", "Call identity does not match its reservation.");
        return "existing";
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day) || !Number.isFinite(Date.parse(input.at)) || new Date(input.at).toISOString().slice(0,10) !== input.day) throw new DomainError("evolution_call_day_invalid", "Call day must match its UTC timestamp.");
      const global = control(db), local = participant(db,input.workbenchId);
      if (!global.enabled || !local.enabled) return "disabled";
      if (global.paused || local.paused) return "paused";
      if (callCount(db,input.day) >= global.dailyCallLimit || callCount(db,input.day,input.workbenchId) >= local.dailyCallLimit) return "budget_exhausted";
      db.prepare("INSERT INTO method_learning_calls(call_id,experiment_id,workbench_id,day,created_at) VALUES (?,?,?,?,?)").run(input.callId,input.experimentId,input.workbenchId,input.day,input.at);
      db.prepare(`INSERT INTO outbox(outbox_id,kind,payload_json,status,available_at,created_at,claim_owner) VALUES (?,'evolution.model',?,'CLAIMED',?,?,'method-learning')`).run(input.callId,JSON.stringify({workbenchId:input.workbenchId,callId:input.callId,experimentId:input.experimentId}),input.at,input.at);
      if (input.checkpoint !== undefined) persistExperiment(db,input.checkpoint);
      return "reserved";
    });
  }
  completeCall(id: string, tokens: number | null, at: string): void {
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new DomainError("evolution_tokens_invalid", "Token usage is invalid.");
    this.database.transaction(db => {
      const result = db.prepare("UPDATE method_learning_calls SET completed_at=COALESCE(completed_at,?),tokens=COALESCE(tokens,?) WHERE call_id=? AND (completed_at IS NULL OR (tokens IS NULL AND ? IS NOT NULL))").run(at,tokens,id,tokens);
      if (result.changes) db.prepare("UPDATE outbox SET status='DONE' WHERE outbox_id=? AND kind='evolution.model'").run(id);
    });
  }
  usage(day: string, workbench?: string): ReturnType<MethodLearningStore["usage"]> {
    return this.database.transaction(db => {
      const row = required(db.prepare("SELECT COALESCE(SUM(tokens),0) AS tokens,COUNT(tokens) AS known FROM method_learning_calls WHERE day=? AND (? IS NULL OR workbench_id=?)").get(day,workbench ?? null,workbench ?? null) ?? null);
      const calls = callCount(db,day,workbench); return {calls,tokens:Number(row.tokens),tokensComplete:Number(row.known) === calls};
    });
  }
  experimentUsage(id: string): ReturnType<MethodLearningStore["experimentUsage"]> {
    return this.database.transaction(db => {
      const row = required(db.prepare("SELECT COUNT(*) AS calls,COUNT(tokens) AS known,COALESCE(SUM(tokens),0) AS tokens FROM method_learning_calls WHERE experiment_id=?").get(id) ?? null);
      return {calls:Number(row.calls),tokens:Number(row.tokens),tokensComplete:Number(row.calls)===Number(row.known)};
    });
  }
  captureFacts(limit = 50): LearningFacts[] {
    return this.database.transaction(db => this.readFacts(db,limit,null,true,true));
  }
  private readFacts(db: DatabaseSync, limit: number | null, goal: string | null, changedOnly: boolean, activeOnly: boolean): LearningFacts[] {
      const rows = db.prepare(`WITH latest AS (
        SELECT r.*,v.status AS verification,COALESCE(run.requirements_revision,0) AS requirements_revision,run.requirement_ids_json,
          ROW_NUMBER() OVER(PARTITION BY r.work_id ORDER BY r.created_at DESC,r.rowid DESC) AS position
        FROM work_results r LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
        LEFT JOIN partner_runs run ON run.run_id=r.run_id WHERE r.is_authoritative=1 AND r.is_late=0
      ), facts AS (
        SELECT i.input_id AS goalId,i.workbench_id AS workbenchId,i.body AS privateSourceBody,COALESCE(q.revision,0) AS requirementsRevision,
          COALESCE(o.result_revision,s.revision,0) AS resultRevision,MAX(i.updated_at,COALESCE(o.updated_at,''),COALESCE(s.updated_at,'')) AS observedAt,
          CASE WHEN o.disposition='COMPLETED' THEN 1 ELSE 0 END AS completed,
          CASE WHEN i.canceled_at IS NOT NULL OR i.dismissed_at IS NOT NULL THEN 1 ELSE 0 END AS canceled,
          (SELECT COUNT(*) FROM work_items w JOIN latest r ON r.work_id=w.work_id AND r.position=1 WHERE w.input_id=i.input_id AND r.workbench_id=w.workbench_id AND r.requirements_revision=COALESCE(q.revision,0) AND r.verification='PASSED') AS verified,
          (SELECT COUNT(*) FROM work_items w JOIN latest r ON r.work_id=w.work_id AND r.position=1 WHERE w.input_id=i.input_id AND r.workbench_id=w.workbench_id AND r.requirements_revision=COALESCE(q.revision,0) AND r.verification='FAILED') AS failed,
          (SELECT COUNT(*) FROM work_items w WHERE w.input_id=i.input_id AND NOT EXISTS(SELECT 1 FROM latest r WHERE r.work_id=w.work_id AND r.position=1 AND r.workbench_id=w.workbench_id AND r.requirements_revision=COALESCE(q.revision,0) AND r.verification IN ('PASSED','FAILED','NOT_REQUIRED'))) AS unverified,
          COALESCE(json_array_length(qs.requirements_json),0) AS requirementCount,
          (SELECT COUNT(DISTINCT ids.value) FROM json_each(o.synthesis_state_json,'$.claims') c,json_each(c.value,'$.requirementIds') ids
            JOIN json_each(qs.requirements_json) req ON json_extract(req.value,'$.id')=ids.value
            WHERE json_extract(c.value,'$.verification')='VERIFIED' AND json_array_length(c.value,'$.resultIds')>0
              AND NOT EXISTS(SELECT 1 FROM json_each(c.value,'$.resultIds') refs WHERE NOT EXISTS(
                SELECT 1 FROM latest lr JOIN work_items lw ON lw.work_id=lr.work_id WHERE lr.result_id=refs.value AND lr.position=1
                  AND lw.input_id=i.input_id AND lw.workbench_id=i.workbench_id AND lr.workbench_id=i.workbench_id
                  AND lw.status='COMPLETED' AND lr.status='COMPLETED' AND lr.verification='PASSED' AND lr.requirements_revision=q.revision))
              AND EXISTS(SELECT 1 FROM json_each(c.value,'$.resultIds') refs JOIN latest lr ON lr.result_id=refs.value,
                json_each(lr.requirement_ids_json) scope WHERE scope.value=ids.value)) AS coveredRequirementCount,
          (SELECT COUNT(*) FROM json_each(o.synthesis_state_json,'$.claims') c,json_each(c.value,'$.resultIds') ids WHERE NOT EXISTS(SELECT 1 FROM work_results r JOIN work_items w ON w.work_id=r.work_id WHERE r.result_id=ids.value AND w.input_id=i.input_id AND w.workbench_id=i.workbench_id AND r.workbench_id=i.workbench_id)) AS foreignEvidenceCount,
          (SELECT COUNT(*) FROM work_dependencies d JOIN work_items w ON w.work_id=d.work_id JOIN work_items parent ON parent.work_id=d.depends_on_work_id WHERE w.input_id=i.input_id AND w.status='COMPLETED' AND parent.status NOT IN ('COMPLETED')) AS dependencyViolationCount,
          (SELECT COALESCE(SUM(duplicates),0) FROM (
            SELECT COUNT(*)-1 AS duplicates FROM method_learning_evidence_reads er WHERE er.goal_id=i.input_id
              AND er.requirements_revision=COALESCE(q.revision,0) AND er.result_revision=COALESCE(o.result_revision,s.revision,0)
            GROUP BY turn_id,requirements_revision,result_revision,tool,result_id,cursor,mode HAVING COUNT(*)>1)) AS redundantReads,
          EXISTS(SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND (
            EXISTS(SELECT 1 FROM latest r WHERE r.work_id=w.work_id AND r.position=1 AND r.status IN ('FAILED','UNKNOWN'))
            OR (w.status='FAILED' AND NOT EXISTS(SELECT 1 FROM latest r WHERE r.work_id=w.work_id AND r.position=1 AND r.status='COMPLETED' AND r.verification='FAILED')))) AS executionFailed,
          ((SELECT COUNT(*) FROM work_items w JOIN latest r ON r.work_id=w.work_id AND r.position=1 WHERE w.input_id=i.input_id AND r.status IN ('WAITING_AUTH','WAITING_INPUT','UNKNOWN'))>0) AS environmentFailed
        FROM joi_inbox_messages i JOIN workbenches b ON b.workbench_id=i.workbench_id AND (?=0 OR b.status='ACTIVE')
        LEFT JOIN joi_current_goal_outcomes o ON o.input_id=i.input_id LEFT JOIN joi_goal_requirements q ON q.goal_input_id=i.input_id
        LEFT JOIN joi_goal_requirement_snapshots qs ON qs.goal_input_id=q.goal_input_id AND qs.revision=q.revision
        LEFT JOIN joi_goal_result_sets s ON s.original_input_id=i.input_id
        WHERE i.goal_input_id IS NULL AND i.status='CONSUMED'
          AND (? IS NULL OR i.input_id=?)
          AND EXISTS(SELECT 1 FROM work_items w JOIN latest r ON r.work_id=w.work_id AND r.position=1 WHERE w.input_id=i.input_id AND r.workbench_id=w.workbench_id AND r.requirements_revision=COALESCE(q.revision,0) AND r.verification IN ('PASSED','FAILED'))
          AND (o.disposition IS NULL OR o.disposition<>'CONTINUE' OR i.canceled_at IS NOT NULL OR i.dismissed_at IS NOT NULL)
          AND (o.input_id IS NULL OR s.original_input_id IS NULL OR o.result_revision=s.revision OR i.canceled_at IS NOT NULL OR i.dismissed_at IS NOT NULL)
          AND (o.disposition IS NOT NULL OR i.canceled_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM work_items w WHERE w.input_id=i.input_id))
          AND NOT EXISTS(SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND w.status IN ('PLANNED','READY','RUNNING','WAITING'))
          AND NOT EXISTS(SELECT 1 FROM joi_turns t JOIN joi_inbox_messages ti ON ti.input_id=t.input_id WHERE t.status='RUNNING' AND (ti.input_id=i.input_id OR ti.goal_input_id=i.input_id))
          AND NOT EXISTS(SELECT 1 FROM joi_inbox_messages child WHERE child.goal_input_id=i.input_id AND child.status<>'CONSUMED' AND child.canceled_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM joi_harness_maps m WHERE m.goal_input_id=i.input_id AND m.status='ACTIVE')
          AND NOT EXISTS(SELECT 1 FROM joi_goal_requirement_sources src WHERE src.goal_input_id=i.input_id AND src.kind<>'LEGACY' AND src.source_revision>COALESCE(q.processed_source_revision,0))
      ), stamped AS (SELECT *,json_array(requirementsRevision,resultRevision,observedAt,completed,canceled,verified,failed,unverified,requirementCount,coveredRequirementCount,foreignEvidenceCount,dependencyViolationCount,redundantReads,executionFailed,environmentFailed) AS fingerprint FROM facts)
      SELECT f.* FROM stamped f LEFT JOIN method_learning_fact_receipts p ON p.goal_id=f.goalId WHERE (?=0 OR p.fingerprint IS NULL OR p.fingerprint<>f.fingerprint) ORDER BY f.observedAt,f.goalId LIMIT ?`).all(Number(activeOnly),goal,goal,Number(changedOnly),limit===null ? -1 : Math.min(50,Math.max(1,Math.floor(limit)))) as Row[];
      return rows.map(row => {
        const sourceGroupId = createHash("sha256").update(String(row.privateSourceBody).normalize("NFC").replace(/\s+/gu," ").trim()).digest("hex");
        return {goalId:String(row.goalId),workbenchId:String(row.workbenchId),sourceGroupId,requirementsRevision:Number(row.requirementsRevision),resultRevision:Number(row.resultRevision),observedAt:String(row.observedAt),completed:row.completed===1,canceled:row.canceled===1,verified:Number(row.verified),failed:Number(row.failed),unverified:Number(row.unverified),requirementCount:Number(row.requirementCount),coveredRequirementCount:Number(row.coveredRequirementCount),foreignEvidenceCount:Number(row.foreignEvidenceCount),dependencyViolationCount:Number(row.dependencyViolationCount),redundantReads:Number(row.redundantReads),executionFailed:Number(row.executionFailed)>0,environmentFailed:Number(row.environmentFailed)>0};
      });
  }
  acknowledgeFacts(facts: LearningFacts[]): void {
    this.database.transaction(db => {
      for (const fact of facts) {
        const fingerprint = factsFingerprint(fact);
        db.prepare("INSERT INTO method_learning_fact_receipts VALUES (?,?) ON CONFLICT(goal_id) DO UPDATE SET fingerprint=excluded.fingerprint").run(fact.goalId,fingerprint);
      }
    });
  }
  goalMetrics(goal: string): {calls:number;tokens:number|null} {
    return this.database.transaction(db => {
      const rows = db.prepare(`SELECT i.status,o.tokens_json FROM usage_invocations i
        LEFT JOIN usage_observations o ON o.invocation_id=i.invocation_id
        WHERE i.purpose<>'evolution' AND (i.goal_id=? OR EXISTS(SELECT 1 FROM work_items w WHERE w.work_id=i.work_id AND w.input_id=?))
        ORDER BY i.invocation_id,o.observation_key`).all(goal,goal);
      let tokens = 0, complete = rows.length>0;
      for (const row of rows) {
        const usage = validateTokenUsage(typeof row.tokens_json === "string" ? JSON.parse(row.tokens_json) as unknown : null);
        if (usage === null || row.status === "running" || row.status === "interrupted") complete=false;
        else tokens += usage.input+usage.output;
      }
      return {calls:rows.length,tokens:complete && Number.isSafeInteger(tokens) ? tokens : null};
    });
  }
  goalRequirementCount(workbench: string, goal: string): number | null {
    return this.database.transaction(db => {
      const row = db.prepare(`SELECT json_array_length(s.requirements_json) AS total
        FROM joi_goal_requirements q JOIN joi_goal_requirement_snapshots s ON s.goal_input_id=q.goal_input_id AND s.revision=q.revision
        JOIN joi_inbox_messages i ON i.input_id=q.goal_input_id AND i.workbench_id=q.workbench_id
        WHERE q.goal_input_id=? AND q.workbench_id=? AND q.revision>0
          AND NOT EXISTS(SELECT 1 FROM joi_goal_requirement_sources src WHERE src.goal_input_id=q.goal_input_id AND src.source_revision>q.processed_source_revision)`)
        .get(goal,workbench);
      return typeof row?.total === "number" ? row.total : null;
    });
  }
  goalSourceMatches(goal: string, source: string, model: string): boolean {
    return this.database.transaction(db => db.prepare(`SELECT 1 FROM joi_inbox_messages i WHERE i.input_id=? AND i.goal_input_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM joi_turns t JOIN joi_inbox_messages ti ON ti.input_id=t.input_id
        WHERE (ti.input_id=i.input_id OR ti.goal_input_id=i.input_id)
          AND (t.source_revision_id IS NOT ? OR t.model_revision_id IS NOT ?))`).get(goal,source,model) !== undefined);
  }
  goalEvaluationEligible(goal: string): boolean {
    return this.database.transaction(db => this.collectEvaluationCases(db,goal).length>0);
  }
  currentEvaluationCases(): LearningCase[] {
    return this.database.transaction(db => this.collectEvaluationCases(db,null));
  }
  goalCaseMatchesCurrent(goal: string, requirementsRevision: number, resultRevision: number, caseId?: string): boolean {
    return this.database.transaction(db => this.collectEvaluationCases(db,goal).some(item => item.requirementsRevision===requirementsRevision
      && item.resultRevision===resultRevision && (caseId===undefined || item.caseId===caseId)));
  }
  private collectEvaluationCases(db: DatabaseSync, goal: string | null): LearningCase[] {
    const metadata = db.prepare(`SELECT i.input_id,p.fingerprint FROM joi_inbox_messages i JOIN joi_goal_requirements q ON q.goal_input_id=i.input_id AND q.workbench_id=i.workbench_id
      JOIN joi_current_goal_outcomes o ON o.input_id=i.input_id JOIN method_learning_fact_receipts p ON p.goal_id=i.input_id
      WHERE (? IS NULL OR i.input_id=?) AND i.failed_at IS NULL
        AND o.disposition IN ('COMPLETED','ACCEPTED_WITH_GAPS')
        AND NOT EXISTS(SELECT 1 FROM method_learning_exposure_invalidations invalid WHERE invalid.goal_id=i.input_id)
        AND NOT EXISTS(SELECT 1 FROM joi_goal_requirement_sources src WHERE src.goal_input_id=i.input_id AND src.source_revision>q.processed_source_revision)
        AND NOT EXISTS(SELECT 1 FROM joi_goal_execution_gates gate WHERE gate.goal_input_id=i.input_id AND gate.status IN ('REVIEWING','WAITING_INPUT'))`).all(goal,goal);
    if (metadata.length===0) return [];
    const stored = db.prepare("SELECT case_id,case_json FROM method_learning_cases WHERE (? IS NULL OR json_extract(case_json,'$.goalId')=?) ORDER BY observed_at,case_id").all(goal,goal);
    if (stored.length===0) return [];
    const fingerprints = new Map(metadata.map(row=>[String(row.input_id),String(row.fingerprint)]));
    const currentIds = new Set<string>();
    for (const fact of this.readFacts(db,goal===null ? null : 1,goal,false,false)) {
      if (fact.canceled || fact.environmentFailed || fact.executionFailed || fact.requirementsRevision<1 || fact.resultRevision<1
        || fingerprints.get(fact.goalId)!==factsFingerprint(fact)) continue;
      for (const item of buildLearningCases(fact)) currentIds.add(item.caseId);
    }
    return stored.filter(row=>currentIds.has(String(row.case_id))).map(row=>required(parse<LearningCase>(row,"case_json")));
  }
  invalidateGoalExposure(workbench: string, goal: string): void {
    this.database.transaction(db => {
      assertGoal(db,workbench,goal);
      db.prepare("INSERT OR IGNORE INTO method_learning_exposure_invalidations VALUES (?,?)").run(goal,workbench);
    });
  }
  recordEvidenceRead(read: MethodEvidenceRead): void {
    this.database.transaction(db => {
      assertGoal(db,read.workbenchId,read.goalId);
      const goal = db.prepare(`SELECT i.canceled_at,i.dismissed_at,COALESCE(q.revision,0) AS requirements_revision,COALESCE(s.revision,o.result_revision,0) AS result_revision
        FROM joi_inbox_messages i LEFT JOIN joi_goal_requirements q ON q.goal_input_id=i.input_id
        LEFT JOIN joi_goal_result_sets s ON s.original_input_id=i.input_id
        LEFT JOIN joi_current_goal_outcomes o ON o.input_id=i.input_id
        WHERE i.input_id=? AND EXISTS(SELECT 1 FROM joi_turns t JOIN joi_inbox_messages ti ON ti.input_id=t.input_id
          WHERE t.turn_id=? AND t.workbench_id=i.workbench_id AND (ti.input_id=i.input_id OR ti.goal_input_id=i.input_id))`).get(read.goalId,read.turnId);
      if (!goal) throw new DomainError("evolution_turn_invalid", "Turn does not belong to this goal.");
      if (goal.canceled_at !== null || goal.dismissed_at !== null) return;
      db.prepare("INSERT INTO method_learning_evidence_reads VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(turn_id,tool_call_id) DO NOTHING")
        .run(read.workbenchId,read.goalId,read.turnId,read.toolCallId,Number(goal.requirements_revision),Number(goal.result_revision),read.tool,read.resultId,read.cursor,read.mode);
    });
  }
  upsertCases(cases: LearningCase[]): void {
    this.database.transaction(db => {
      for (const item of cases) {
        assertGoal(db,item.workbenchId,item.goalId);
        db.prepare("INSERT INTO method_learning_cases VALUES (?,?,?,?,?) ON CONFLICT(case_id) DO NOTHING").run(item.caseId,item.groupId,item.workbenchId,item.observedAt,JSON.stringify(item));
      }
      for (const id of new Set(cases.map(item => item.workbenchId))) db.prepare(`DELETE FROM method_learning_cases WHERE case_id IN (
        SELECT case_id FROM method_learning_cases c WHERE workbench_id=? AND NOT EXISTS(SELECT 1 FROM method_learning_case_references r WHERE r.case_id=c.case_id)
        ORDER BY observed_at DESC,case_id DESC LIMIT -1 OFFSET 200)`).run(id);
    });
  }
  listCases(id?: string): LearningCase[] { return this.database.transaction(db => db.prepare("SELECT case_json FROM method_learning_cases WHERE (? IS NULL OR workbench_id=?) ORDER BY observed_at,case_id").all(id ?? null,id ?? null).map(row => required(parse<LearningCase>(row,"case_json")))); }
  saveExperiment(value: MethodExperiment): void {
    this.database.transaction(db => persistExperiment(db,value));
  }
  experiment(id: string): MethodExperiment | null { return this.database.transaction(db => parse(db.prepare("SELECT state_json FROM method_learning_experiments WHERE experiment_id=?").get(id))); }
  experiments(): MethodExperiment[] { return this.database.transaction(db => db.prepare("SELECT state_json FROM method_learning_experiments ORDER BY created_at,experiment_id").all().map(row => required(parse<MethodExperiment>(row)))); }
  saveRevision(value: MethodRevision): void { this.database.transaction(db => db.prepare("INSERT INTO method_learning_revisions VALUES (?,?) ON CONFLICT(revision_id) DO UPDATE SET state_json=excluded.state_json").run(value.id,JSON.stringify(value))); }
  revision(id: string): MethodRevision | null { return this.database.transaction(db => parse(db.prepare("SELECT state_json FROM method_learning_revisions WHERE revision_id=?").get(id))); }
  revisions(): MethodRevision[] { return this.database.transaction(db => db.prepare("SELECT state_json FROM method_learning_revisions ORDER BY revision_id").all().map(row => required(parse<MethodRevision>(row)))); }
  cacheTrial(key: MethodTrialKey): JsonObject | null { return this.database.transaction(db => parse(db.prepare("SELECT result_json FROM method_learning_trial_cache WHERE cache_key=?").get(trialKey(key)),"result_json")); }
  saveTrial(key: MethodTrialKey, result: JsonObject): void { this.database.transaction(db => db.prepare("INSERT INTO method_learning_trial_cache VALUES (?,?) ON CONFLICT(cache_key) DO NOTHING").run(trialKey(key),JSON.stringify(result))); }
  pinGoal(pin: MethodGoalPin): MethodGoalPin {
    return this.database.transaction(db => {
      assertGoal(db,pin.workbenchId,pin.goalId);
      db.prepare("INSERT INTO method_learning_goal_pins VALUES (?,?,?,?,?) ON CONFLICT(goal_id) DO NOTHING").run(pin.goalId,pin.workbenchId,pin.revisionId,pin.policy,pin.at);
      return required(this.readPin(db,pin.workbenchId,pin.goalId));
    });
  }
  goalPin(workbench: string, goal: string): MethodGoalPin | null { return this.database.transaction(db => { assertGoal(db,workbench,goal); return this.readPin(db,workbench,goal); }); }
  goalPins(revisionId?: string): MethodGoalPin[] {
    return this.database.transaction(db => db.prepare("SELECT * FROM method_learning_goal_pins WHERE (? IS NULL OR revision_id=?) ORDER BY created_at DESC,goal_id DESC LIMIT 1000").all(revisionId ?? null,revisionId ?? null)
      .map(row => ({workbenchId:String(row.workbench_id),goalId:String(row.goal_id),revisionId:row.revision_id === null ? null : String(row.revision_id),policy:String(row.policy),at:String(row.created_at)})));
  }
  countGoalPins(revisionId?: string): number { return this.database.transaction(db => Number(db.prepare("SELECT COUNT(*) AS total FROM method_learning_goal_pins WHERE (? IS NULL OR revision_id=?)").get(revisionId ?? null,revisionId ?? null)?.total ?? 0)); }
  private readPin(db: DatabaseSync, workbench: string, goal: string): MethodGoalPin | null {
    const row = db.prepare("SELECT * FROM method_learning_goal_pins WHERE goal_id=? AND workbench_id=?").get(goal,workbench);
    return row ? {workbenchId:workbench,goalId:goal,revisionId:row.revision_id === null ? null : String(row.revision_id),policy:String(row.policy),at:String(row.created_at)} : null;
  }
}
