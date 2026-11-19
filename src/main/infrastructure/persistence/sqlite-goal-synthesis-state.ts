import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../../domain/errors.js";
import { sameGoalRequirement, type GoalRequirement, type GoalRequirements } from "../../domain/work/goal-requirements.js";
import { GoalSynthesisCoverageError, parseGoalSynthesisDraft, type GoalSynthesisCoverageIssues, type GoalSynthesisDraft, type GoalSynthesisState } from "../../domain/work/goal-synthesis-state.js";
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
  goalInputId: string; workbenchId: string; resultRevision: number; requirementsRevision: number; draft?: GoalSynthesisDraft; requireCoverage?: boolean;
}): GoalSynthesisState {
  const contract = loadGoalRequirements(connection, input.goalInputId);
  const knownRequirements = new Set(contract?.requirements.map(requirement => requirement.id) ?? []);
  const previous = input.draft === undefined ? readStoredSynthesisState(connection.prepare("SELECT synthesis_state_json FROM joi_goal_outcomes WHERE input_id=?")
    .get(input.goalInputId)?.synthesis_state_json) : undefined;
  const fallback: GoalSynthesisDraft = previous === undefined ? { version: 1, claims: [], unresolved: [], conflicts: [] } : {
    version: 1,
    claims: previous.claims.map(({ statement, resultIds, requirementIds }) => ({ statement, resultIds, requirementIds: requirementIds.filter(id => knownRequirements.has(id)) })),
    unresolved: previous.unresolved.map(gap => ({ ...gap, requirementIds: gap.requirementIds.filter(id => knownRequirements.has(id)) })),
    conflicts: previous.conflicts.map(conflict => conflict.requirementIds === undefined ? conflict
      : { ...conflict, requirementIds: conflict.requirementIds.filter(id => knownRequirements.has(id)) }),
  };
  const draft = input.draft === undefined ? fallback : parseGoalSynthesisDraft(input.draft);
  if (draft === undefined) throw new DomainError("goal_synthesis_state_invalid", "The private synthesis state is invalid.");
  for (const item of [...draft.claims, ...draft.unresolved, ...draft.conflicts]) {
    if (item.requirementIds?.some(id => !knownRequirements.has(id))) throw new DomainError("goal_synthesis_reference_invalid", "Synthesis references an unknown requirement.");
  }
  const evidence = verifySynthesisResults(connection, input, draft, contract);
  const state: GoalSynthesisState = { ...draft, source: input.draft === undefined ? "LEGACY" : "MODEL", resultRevision: input.resultRevision,
    requirementsRevision: input.requirementsRevision,
    claims: draft.claims.map(claim => {
      const usable = claim.resultIds.flatMap(id => {
        const result = evidence.get(id);
        return result?.eligible === true ? [result] : [];
      });
      const verified = usable.length > 0 && claim.requirementIds.every(id => usable.some(result => result.requirementIds.has(id)));
      return { ...claim, verification: verified ? "VERIFIED" : "UNVERIFIED" };
    }),
  };
  if (input.requireCoverage === true) assertGoalSynthesisCoverage(connection, contract, state, evidence);
  return state;
}

interface ResultEvidence {
  eligible: boolean;
  requirementIds: Set<string>;
  changedRequirementIds: Set<string>;
}

function readRequirementScopes(connection: DatabaseSync, goalInputId: string, current: GoalRequirements | null, oldRevisions: Set<number>) {
  const scopes = new Map<number, Set<string>>();
  if (current === null || oldRevisions.size === 0) return scopes;
  const currentById = new Map(current.requirements.map(requirement => [requirement.id, requirement]));
  const snapshots = connection.prepare(`SELECT revision,requirements_json FROM joi_goal_requirement_snapshots
    WHERE goal_input_id=? AND json_valid(requirements_json) AND revision IN (SELECT value FROM json_each(?))`)
    .all(goalInputId, JSON.stringify([...oldRevisions]));
  for (const snapshot of snapshots) {
    const unchanged = new Set<string>();
    const previousRequirements: unknown = JSON.parse(String(snapshot.requirements_json));
    if (!Array.isArray(previousRequirements)) continue;
    for (const previous of previousRequirements as (GoalRequirement | null)[]) {
      if (previous === null) continue;
      const active = currentById.get(previous.id);
      // The original source span distinguishes a continuously active requirement from a retired or replaced one.
      if (active !== undefined && sameGoalRequirement(previous, active)
        && previous.source.sourceRevision === active.source.sourceRevision
        && previous.source.start === active.source.start && previous.source.end === active.source.end) unchanged.add(active.id);
    }
    scopes.set(Number(snapshot.revision), unchanged);
  }
  return scopes;
}

function resultRequirementIds(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const ids: unknown = JSON.parse(value);
    if (Array.isArray(ids) && ids.every((id: unknown) => typeof id === "string")) return ids;
  } catch { /* An unknown execution scope cannot prove requirement coverage. */ }
  return undefined;
}

function verifySynthesisResults(connection: DatabaseSync, input: {
  goalInputId: string; workbenchId: string; resultRevision: number; requirementsRevision: number;
}, draft: GoalSynthesisDraft, contract: GoalRequirements | null): Map<string, ResultEvidence> {
  const ids = new Set([...draft.claims, ...draft.unresolved, ...draft.conflicts].flatMap(item => item.resultIds));
  for (const conflict of draft.conflicts) for (const id of conflict.resolution?.resultIds ?? []) ids.add(id);
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
  const oldRevisions = new Set(rows.map(row => Number(row.requirements_revision ?? 0))
    .filter(revision => revision > 0 && revision < input.requirementsRevision));
  const unchanged = readRequirementScopes(connection, input.goalInputId,
    contract?.revision === input.requirementsRevision ? contract : null, oldRevisions);
  return new Map(rows.map(row => {
    const requirementIds = new Set<string>();
    const changedRequirementIds = new Set<string>();
    let eligible = false;
    if (row.status === "COMPLETED" && row.verification === "PASSED" && row.is_late === 0 && row.is_authoritative === 1 && row.eligible === 1) {
      const revision = Number(row.requirements_revision ?? 0);
      const scope = resultRequirementIds(row.requirement_ids_json);
      if (revision === input.requirementsRevision) {
        eligible = scope !== undefined || revision === 0;
        for (const id of scope ?? []) requirementIds.add(id);
      } else if (revision < input.requirementsRevision) {
        for (const id of scope ?? []) {
          (unchanged.get(revision)?.has(id) === true ? requirementIds : changedRequirementIds).add(id);
        }
        eligible = requirementIds.size > 0;
      }
    }
    return [String(row.resultId), { eligible, requirementIds, changedRequirementIds }];
  }));
}

function assertGoalSynthesisCoverage(connection: DatabaseSync, contract: GoalRequirements | null, state: GoalSynthesisState,
  evidence: Map<string, ResultEvidence>): void {
  if (contract === null) return;
  const mandatory = contract.requirements.filter(requirement => requirement.mandatory).map(requirement => requirement.id);
  if (mandatory.length === 0) return;
  const required = new Set(mandatory);
  const claimResultIds = new Set(state.claims.flatMap(claim => claim.resultIds).filter(id => evidence.get(id)?.eligible === true));
  const readRows = claimResultIds.size === 0 ? [] : connection.prepare(`SELECT DISTINCT e.result_id FROM json_each(?) requested
    JOIN joi_goal_evidence_reads e ON e.result_id=requested.value
    JOIN work_results r ON r.result_id=e.result_id AND r.body_ref=e.source_ref
    WHERE e.goal_input_id=? AND e.requirements_revision=? AND e.result_revision<=?`)
    .all(JSON.stringify([...claimResultIds]), contract.goalInputId, state.requirementsRevision, state.resultRevision);
  const readIds = new Set(readRows.map(row => String(row.result_id)));
  const support = new Map<string, Set<string>>();
  const relevantCitations = new Map<string, Set<string>>();
  for (const claim of state.claims) {
    const claimedRequirements = claim.requirementIds.filter(id => required.has(id));
    if (claimedRequirements.length === 0) continue;
    for (const resultId of claim.resultIds) {
      const relevant = relevantCitations.get(resultId) ?? new Set<string>();
      for (const id of claimedRequirements) {
        relevant.add(id);
        if (!readIds.has(resultId) || evidence.get(resultId)?.requirementIds.has(id) !== true) continue;
        const supportingResults = support.get(id) ?? new Set<string>();
        supportingResults.add(resultId);
        support.set(id, supportingResults);
      }
      relevantCitations.set(resultId, relevant);
    }
  }
  const blockingConflicts: GoalSynthesisCoverageIssues["blockingConflicts"] = [];
  for (const [index, conflict] of state.conflicts.entries()) {
    const affected = conflict.requirementIds?.filter(id => required.has(id)) ?? mandatory;
    if (affected.length === 0) continue;
    const resolvedWith = conflict.resolution?.resultIds;
    if (resolvedWith === undefined) blockingConflicts.push({ index, requirementIds: affected, reason: "MISSING_RESOLUTION" });
    else if (affected.some(id => !resolvedWith.some(resultId => support.get(id)?.has(resultId) === true))
      || resolvedWith.some(resultId => !affected.some(id => support.get(id)?.has(resultId) === true))) {
      blockingConflicts.push({ index, requirementIds: affected, reason: "UNSUPPORTED_RESOLUTION" });
    }
  }
  const gaps = new Set(state.unresolved.flatMap(gap => gap.requirementIds));
  const missingRequirementIds = mandatory.filter(id => !support.has(id));
  const unresolvedRequirementIds = mandatory.filter(id => gaps.has(id));
  const requirementsStatus = contract.revision === state.requirementsRevision ? contract.status : "STALE";
  if (requirementsStatus === "READY" && missingRequirementIds.length === 0 && unresolvedRequirementIds.length === 0
    && blockingConflicts.length === 0) return;

  const citations: GoalSynthesisCoverageIssues["citations"] = [];
  for (const [resultId, requirementIds] of relevantCitations) {
    const result = evidence.get(resultId);
    const changed = [...requirementIds].filter(id => result?.changedRequirementIds.has(id) === true);
    if (changed.length > 0) citations.push({ resultId, reason: "REQUIREMENT_CHANGED", requirementIds: changed });
    if (result?.eligible !== true && changed.length === 0) citations.push({ resultId, reason: "INELIGIBLE_RESULT" });
    else if (result?.eligible === true && !readIds.has(resultId)
      && [...requirementIds].some(id => result.requirementIds.has(id))) citations.push({ resultId, reason: "MISSING_READ_RECEIPT" });
  }
  const limit = 12;
  const perIssueLimit = 4;
  throw new GoalSynthesisCoverageError({
    requirementsStatus,
    missingRequirementIds: missingRequirementIds.slice(0, limit),
    unresolvedRequirementIds: unresolvedRequirementIds.slice(0, limit),
    blockingConflicts: blockingConflicts.slice(0, limit).map(issue => ({ ...issue, requirementIds: issue.requirementIds.slice(0, perIssueLimit) })),
    citations: citations.slice(0, limit).map(issue => issue.reason === "REQUIREMENT_CHANGED"
      ? { ...issue, requirementIds: issue.requirementIds.slice(0, perIssueLimit) } : issue),
    truncated: [missingRequirementIds, unresolvedRequirementIds, blockingConflicts, citations].some(items => items.length > limit)
      || [...blockingConflicts, ...citations].some(issue => "requirementIds" in issue && issue.requirementIds.length > perIssueLimit),
  });
}

export function hasCurrentGoalSynthesisCoverage(connection: DatabaseSync, goalInputId: string): boolean {
  const contract = loadGoalRequirements(connection,goalInputId);
  if (!contract?.requirements.some(requirement => requirement.mandatory)) return true;
  const outcome = connection.prepare(`SELECT result_revision,synthesis_state_json FROM joi_current_goal_outcomes
    WHERE input_id=? AND disposition='COMPLETED'`).get(goalInputId);
  const stored = readStoredSynthesisState(outcome?.synthesis_state_json);
  if (stored === undefined || stored.resultRevision !== outcome?.result_revision || stored.requirementsRevision !== contract.revision) return false;
  const draft: GoalSynthesisDraft = {
    version: 1,claims: stored.claims.map(({ verification: _verification,...claim }) => claim),
    unresolved: stored.unresolved,conflicts: stored.conflicts,
  };
  try {
    buildGoalSynthesisState(connection,{ goalInputId,workbenchId: contract.workbenchId,
      resultRevision: stored.resultRevision,requirementsRevision: contract.revision,draft,requireCoverage: true });
    return true;
  } catch (error) {
    if (error instanceof DomainError && ["goal_synthesis_coverage_incomplete","goal_synthesis_reference_invalid"].includes(error.code)) return false;
    throw error;
  }
}
