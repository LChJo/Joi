import type { MethodPolicy } from "./learning-policy.js";

export interface DecisionEvidenceRead {
  receiptId: string;
  resultId: string;
  sourceRef: string;
  start: number;
  end: number;
  digest: string;
  verification: string;
  residentReceipts: string[] | null;
  authority: string | null;
}

export interface DecisionFragment {
  version: 1;
  id: string;
  sourceGroup: string;
  workbenchId: string;
  goalId: string;
  turnId: string;
  requirementsRevision: number;
  resultRevision: number;
  sourceRevisionId: string;
  modelRevisionId: string;
  parentRevisionId: string | null;
  parent: MethodPolicy;
  requirements: { id: string; mandatory: boolean }[];
  reads: DecisionEvidenceRead[];
}

export interface DecisionFragmentGrade {
  disposition: "complete" | "continue";
  citedResultIds: string[];
}

export type DecisionFragmentResult =
  | { status: "ready"; fragment: DecisionFragment; grade: DecisionFragmentGrade }
  | { status: "no_receipts" | "snapshot_missing" | "source_missing" | "parent_missing" | "range_invalid" | "acceptance_missing" };

export function decisionPageKey(read: DecisionEvidenceRead): string {
  return JSON.stringify([read.resultId,read.sourceRef,read.start,read.end,read.digest,read.authority]);
}

export function hasRepeatedDecisionPage(fragment: DecisionFragment): boolean {
  const passed = fragment.reads.filter(read=>read.verification==="PASSED");
  return new Set(passed.map(decisionPageKey)).size<passed.length;
}

/** A replay lives in one version-bound turn. Unknown historic residency supports fixed-trace comparison only. */
export function replayDecisionReads<T>(events: readonly DecisionEvidenceRead[], load: (read: DecisionEvidenceRead) => T, reuse: boolean) {
  const pages = new Map<string,{ receiptId: string; value: T }>();
  let reads = 0;
  const observations = events.map(event => {
    const key = decisionPageKey(event);
    const prior = pages.get(key);
    const resident = event.residentReceipts === null || (prior !== undefined && event.residentReceipts.includes(prior.receiptId));
    const eligible = event.verification === "PASSED";
    const value = reuse && eligible && resident && prior !== undefined ? prior.value : load(event);
    if (!(reuse && eligible && resident && prior !== undefined)) reads += 1;
    if (eligible) pages.set(key,{receiptId:event.receiptId,value});
    else pages.delete(key);
    return value;
  });
  return { reads, observations, confirmedResidency: events.every(event => event.residentReceipts !== null && event.authority !== null) };
}
