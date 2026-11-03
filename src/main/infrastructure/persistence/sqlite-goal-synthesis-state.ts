import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../../domain/errors.js";
import { parseGoalSynthesisDraft, type GoalSynthesisDraft, type GoalSynthesisState } from "../../domain/work/goal-synthesis-state.js";
import { loadGoalRequirements } from "./sqlite-goal-requirements.js";

export function readStoredSynthesisState(value: unknown): GoalSynthesisState | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const stored = JSON.parse(value) as GoalSynthesisState;
    const draft = parseGoalSynthesisDraft({ version: stored.version,
      claims: stored.claims.map(({ statement, requirementIds, resultIds }) => ({ statement, requirementIds, resultIds })),
      unresolved: stored.unresolved, conflicts: stored.conflicts });
    if (draft === undefined || !Number.isSafeInteger(stored.resultRevision) || !Number.isSafeInteger(stored.requirementsRevision)
      || !["MODEL", "LEGACY"].includes(stored.source)) return undefined;
    return { ...draft, resultRevision: stored.resultRevision, requirementsRevision: stored.requirementsRevision, source: stored.source,
      claims: draft.claims.map((claim, index) => ({ ...claim, verification: stored.claims[index]?.verification === "VERIFIED" ? "VERIFIED" : "UNVERIFIED" })) };
  } catch { return undefined; }
}

/** References are scoped to the committed evidence version; model statements cannot grant acceptance. */
export function buildGoalSynthesisState(connection: DatabaseSync, input: {
  goalInputId: string; workbenchId: string; resultRevision: number; requirementsRevision: number; draft?: GoalSynthesisDraft;
}): GoalSynthesisState {
  const contract = loadGoalRequirements(connection, input.goalInputId);
  const knownRequirements = new Set(contract?.requirements.map(requirement => requirement.id) ?? []);
  const previous = readStoredSynthesisState(connection.prepare("SELECT synthesis_state_json FROM joi_goal_outcomes WHERE input_id=?")
    .get(input.goalInputId)?.synthesis_state_json);
  const fallback: GoalSynthesisDraft = previous === undefined ? { version: 1, claims: [], unresolved: [], conflicts: [] } : {
    version: 1,
    claims: previous.claims.map(({ statement, resultIds, requirementIds }) => ({ statement, resultIds, requirementIds: requirementIds.filter(id => knownRequirements.has(id)) })),
    unresolved: previous.unresolved.map(gap => ({ ...gap, requirementIds: gap.requirementIds.filter(id => knownRequirements.has(id)) })),
    conflicts: previous.conflicts,
  };
  const draft = input.draft === undefined ? fallback : parseGoalSynthesisDraft(input.draft);
  if (draft === undefined) throw new DomainError("goal_synthesis_state_invalid", "The private synthesis state is invalid.");
  for (const item of [...draft.claims, ...draft.unresolved]) {
    if (item.requirementIds.some(id => !knownRequirements.has(id))) throw new DomainError("goal_synthesis_reference_invalid", "Synthesis references an unknown requirement.");
  }
  const ids = new Set([...draft.claims, ...draft.unresolved, ...draft.conflicts].flatMap(item => item.resultIds));
  const verified = new Map<string, { requirementsRevision: number; requirementIds?: Set<string> }>();
  const rows = ids.size === 0 ? [] : connection.prepare(`WITH requested AS (SELECT value AS result_id FROM json_each(?))
      SELECT r.result_id AS resultId,r.status,r.is_late,r.is_authoritative,COALESCE(v.status,'UNVERIFIED') AS verification,
      run.requirements_revision,run.requirement_ids_json,
      (w.status='COMPLETED' AND r.action_id=(SELECT action_id FROM dispatch_attempts a WHERE a.work_id=w.work_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1)) AS eligible
      FROM requested JOIN work_results r ON r.result_id=requested.result_id JOIN work_items w ON w.work_id=r.work_id
      JOIN partner_runs run ON run.run_id=r.run_id
      LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
      WHERE w.input_id=? AND w.workbench_id=? AND r.workbench_id=? AND EXISTS (
        SELECT 1 FROM joi_goal_result_members m JOIN partner_result_events e ON e.event_id=m.event_id
        WHERE m.original_input_id=? AND m.revision<=? AND e.run_id=r.run_id AND e.status=r.status
      )`).all(JSON.stringify([...ids]), input.goalInputId, input.workbenchId, input.workbenchId, input.goalInputId, input.resultRevision);
  if (rows.length !== ids.size) throw new DomainError("goal_synthesis_reference_invalid", "Synthesis references evidence outside its goal or version.");
  for (const row of rows) {
    if (row.status === "COMPLETED" && row.verification === "PASSED" && row.is_late === 0 && row.is_authoritative === 1 && row.eligible === 1) {
      let requirementIds: Set<string> | undefined;
      try {
        const ids: unknown = typeof row.requirement_ids_json === "string" ? JSON.parse(row.requirement_ids_json) : undefined;
        if (Array.isArray(ids) && ids.every((value: unknown) => typeof value === "string")) requirementIds = new Set(ids);
      } catch { /* An unknown execution scope cannot prove current requirement coverage. */ }
      verified.set(row.resultId as string, { requirementsRevision: Number(row.requirements_revision ?? 0), ...(requirementIds === undefined ? {} : { requirementIds }) });
    }
  }
  return { ...draft, source: input.draft === undefined ? "LEGACY" : "MODEL", resultRevision: input.resultRevision,
    requirementsRevision: input.requirementsRevision,
    claims: draft.claims.map(claim => {
      const coveredRequirements = new Set<string>();
      const eligible = claim.resultIds.length > 0 && claim.resultIds.every(id => {
        const evidence = verified.get(id);
        if (evidence?.requirementsRevision !== input.requirementsRevision) return false;
        if (evidence.requirementIds === undefined) return input.requirementsRevision === 0 && claim.requirementIds.length === 0;
        for (const requirementId of evidence.requirementIds) coveredRequirements.add(requirementId);
        return true;
      });
      return { ...claim, verification: eligible && claim.requirementIds.every(id => coveredRequirements.has(id)) ? "VERIFIED" : "UNVERIFIED" };
    }),
  };
}
