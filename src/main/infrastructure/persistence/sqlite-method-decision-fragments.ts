import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { learningSourceGroup } from "../../domain/evolution/learning-case.js";
import type { DecisionEvidenceRead, DecisionFragment, DecisionFragmentResult } from "../../domain/evolution/learning-decision-fragment.js";
import { baselineMethodPolicy, parseMethodPolicy } from "../../domain/evolution/learning-policy.js";
import { readStoredSynthesisState } from "./sqlite-goal-synthesis-state.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceGroup = (key: string) => learningSourceGroup(key.startsWith("legacy:") ? digest(key) : key);
const bounds = 16;
const members = `EXISTS (SELECT 1 FROM joi_goal_result_members m
  JOIN partner_result_events event ON event.event_id=m.event_id
  WHERE m.original_input_id=e.goal_input_id AND m.revision<=e.result_revision AND event.run_id=r.run_id AND event.status=r.status)`;
const receiptPages = `SELECT e.*,r.created_at AS result_at,COALESCE(v.status,'UNVERIFIED') AS verification,
  r.is_late,r.is_authoritative,r.status AS result_status,c.resident_json,c.authority,${members} AS member
  FROM joi_goal_evidence_reads e JOIN work_results r ON r.result_id=e.result_id AND r.body_ref=e.source_ref
  JOIN work_items w ON w.work_id=r.work_id AND w.input_id=e.goal_input_id AND w.workbench_id=r.workbench_id
  LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
  LEFT JOIN method_learning_decision_receipts c ON c.turn_id=e.turn_id AND c.tool_call_id=e.tool_call_id
  WHERE e.goal_input_id=? AND e.turn_id=? AND e.requirements_revision=? AND e.result_revision=? AND r.workbench_id=?
  ORDER BY e.rowid LIMIT ${String(bounds+1)}`;

export function readDecisionPage(db: DatabaseSync, fragment: DecisionFragment, page: DecisionEvidenceRead): string | null {
  const row = db.prepare(`SELECT substr(b.body,?,?) AS content,
      r.is_authoritative,r.is_late,r.status,COALESCE(v.status,'UNVERIFIED') AS verification
    FROM joi_goal_evidence_reads e JOIN work_results r ON r.result_id=e.result_id AND r.body_ref=e.source_ref
    JOIN work_result_bodies b ON b.body_ref=e.source_ref JOIN work_items w ON w.work_id=r.work_id AND w.input_id=e.goal_input_id
    LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
    JOIN joi_inbox_messages i ON i.input_id=e.goal_input_id AND i.workbench_id=r.workbench_id
    JOIN workbenches wb ON wb.workbench_id=i.workbench_id AND wb.status='ACTIVE'
    WHERE e.goal_input_id=? AND e.turn_id=? AND e.requirements_revision=? AND e.result_revision=? AND i.workbench_id=?
      AND w.workbench_id=i.workbench_id AND i.canceled_at IS NULL AND i.dismissed_at IS NULL AND i.failed_at IS NULL
      AND e.tool_call_id=? AND e.result_id=? AND e.source_ref=? AND e.start_offset=? AND e.end_offset=? AND ${members}`)
    .get(page.start+1,page.end-page.start,fragment.goalId,fragment.turnId,fragment.requirementsRevision,fragment.resultRevision,
      fragment.workbenchId,page.receiptId,page.resultId,page.sourceRef,page.start,page.end);
  const current = row?.status === "COMPLETED" && row.is_authoritative === 1 && row.is_late === 0 ? row.verification : "UNVERIFIED";
  return typeof row?.content === "string" && current === page.verification && digest(row.content) === page.digest ? row.content : null;
}

export function loadDecisionFragments(db: DatabaseSync, workbenchId: string): DecisionFragmentResult[] {
  const rows = db.prepare(`SELECT DISTINCT e.goal_input_id,e.turn_id,e.requirements_revision,e.result_revision,t.created_at,
    t.source_revision_id,t.model_revision_id,s.source_key,p.revision_id,p.policy,q.requirements_json,
    h.synthesis_state_json,h.disposition,
    EXISTS (SELECT 1 FROM method_learning_revisions prior
      WHERE json_extract(prior.state_json,'$.createdAt')<=t.created_at AND
      (json_extract(prior.state_json,'$.scope')='GLOBAL' OR json_extract(prior.state_json,'$.workbenchId')=t.workbench_id)) AS prior_method
    FROM method_learning_sources s JOIN joi_inbox_messages g ON g.input_id=s.goal_id
    JOIN joi_goal_evidence_reads e ON e.goal_input_id=g.input_id JOIN joi_turns t ON t.turn_id=e.turn_id AND t.workbench_id=g.workbench_id
    JOIN joi_inbox_messages ti ON ti.input_id=t.input_id AND (ti.input_id=g.input_id OR ti.goal_input_id=g.input_id)
    LEFT JOIN joi_goal_requirement_snapshots q ON q.goal_input_id=g.input_id AND q.revision=e.requirements_revision
    LEFT JOIN joi_goal_outcome_history h ON h.goal_input_id=g.input_id AND h.requirements_revision=e.requirements_revision AND h.result_revision=e.result_revision
    LEFT JOIN method_learning_goal_pins p ON p.goal_id=g.input_id AND p.workbench_id=g.workbench_id AND p.created_at<=t.created_at
    WHERE g.workbench_id=? AND g.goal_input_id IS NULL AND g.canceled_at IS NULL AND g.dismissed_at IS NULL AND g.failed_at IS NULL
      AND t.status='COMPLETED' AND s.split='development' AND e.requirements_revision>0 AND e.result_revision>0
    ORDER BY t.created_at DESC,e.turn_id,e.result_revision LIMIT 128`).all(workbenchId);
  if (rows.length === 0) return [{status:"no_receipts"}];
  const pages = db.prepare(receiptPages);
  const text = db.prepare("SELECT substr(body,?,?) AS content FROM work_result_bodies WHERE body_ref=?");
  return rows.map((row): DecisionFragmentResult => {
    if (typeof row.source_revision_id !== "string" || typeof row.model_revision_id !== "string") return {status:"source_missing"};
    if (typeof row.requirements_json !== "string") return {status:"snapshot_missing"};
    const requirementSnapshot: unknown = JSON.parse(row.requirements_json);
    if (!Array.isArray(requirementSnapshot) || !requirementSnapshot.every((item:unknown):item is {id:string;mandatory?:boolean}=>
      item!==null && typeof item==="object" && typeof (item as {id?:unknown}).id==="string")) return {status:"snapshot_missing"};
    const requirements = requirementSnapshot.map(({id,mandatory}) => ({id,mandatory:mandatory===true}));
    const requirementsRevision = Number(row.requirements_revision);
    const resultRevision = Number(row.result_revision);
    const goalId = String(row.goal_input_id);
    const turnId = String(row.turn_id);
    const synthesis = readStoredSynthesisState(row.synthesis_state_json);
    if ((row.disposition !== "COMPLETED" && row.disposition !== "ACCEPTED_WITH_GAPS") || synthesis?.source !== "MODEL"
      || synthesis.requirementsRevision !== requirementsRevision || synthesis.resultRevision !== resultRevision) return {status:"acceptance_missing"};
    const parentRevisionId = typeof row.revision_id === "string" ? row.revision_id : null;
    if (row.policy === null && row.prior_method === 1) return {status:"parent_missing"};
    let parent;
    try {
      const stored: unknown = typeof row.policy === "string" ? JSON.parse(row.policy) : baselineMethodPolicy;
      parent = parseMethodPolicy(stored!==null && typeof stored==="object" && "policy" in stored ? stored.policy : stored);
    }
    catch { return {status:"parent_missing"}; }
    const reads: DecisionEvidenceRead[] = [];
    for (const receipt of pages.all(goalId,turnId,requirementsRevision,resultRevision,workbenchId)) {
      const start = Number(receipt.start_offset), end = Number(receipt.end_offset);
      if (receipt.member !== 1 || String(receipt.result_at) > String(row.created_at) || reads.length >= bounds
        || end-start > 8000 || end<=start) return {status:"range_invalid"};
      const sourceRef = String(receipt.source_ref);
      const page = text.get(start+1,end-start,sourceRef)?.content;
      if (typeof page !== "string" || Array.from(page).length !== end-start) return {status:"range_invalid"};
      const verification = receipt.is_authoritative === 1 && receipt.is_late === 0 && receipt.result_status === "COMPLETED"
        ? String(receipt.verification) : "UNVERIFIED";
      reads.push({receiptId:String(receipt.tool_call_id),resultId:String(receipt.result_id),sourceRef,start,end,digest:digest(page),verification,
        residentReceipts:typeof receipt.resident_json === "string" ? JSON.parse(receipt.resident_json) as string[] : null,
        authority:typeof receipt.authority === "string" ? receipt.authority : null});
    }
    if (reads.length === 0) return {status:"range_invalid"};
    const reviewed = new Set(reads.filter(page=>page.verification==="PASSED").map(page=>page.resultId));
    const citedResultIds = [...new Set(synthesis.claims.filter(claim=>claim.verification==="VERIFIED").flatMap(claim=>claim.resultIds))]
      .filter(resultId=>reviewed.has(resultId)).sort();
    if (citedResultIds.length === 0 || citedResultIds.length > 10) return {status:"acceptance_missing"};
    const grade: { disposition: "complete" | "continue"; citedResultIds: string[] } = {
      disposition:row.disposition==="COMPLETED" ? "complete" : "continue",citedResultIds };
    const manifest = {version:1 as const,sourceGroup:sourceGroup(String(row.source_key)),workbenchId,goalId,turnId,requirementsRevision,resultRevision,
      sourceRevisionId:row.source_revision_id,modelRevisionId:row.model_revision_id,parentRevisionId,parent,requirements,reads};
    return {status:"ready",fragment:{...manifest,id:digest(JSON.stringify([manifest,grade]))},grade};
  });
}
