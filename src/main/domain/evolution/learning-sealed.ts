import type { LearningCase } from "./learning-case.js";

export function independentSealedCases(cases: readonly LearningCase[], development: readonly LearningCase[], scope: "GLOBAL" | "WORKBENCH", workbenchId: string): LearningCase[] {
  const excluded = new Set(development.map(item=>item.groupId));
  const selected = new Map<string,LearningCase>();
  for (const item of cases) {
    if (item.split!=="sealed" || excluded.has(item.groupId) || (scope==="WORKBENCH" && item.workbenchId!==workbenchId)) continue;
    if (!selected.has(item.groupId)) selected.set(item.groupId,item);
  }
  const distinct = [...selected.values()];
  const first = distinct[0];
  if (first === undefined || scope==="WORKBENCH") return distinct.slice(0,10);
  const second = distinct.find(item=>item.workbenchId!==first.workbenchId);
  return second===undefined ? distinct.slice(0,10) : [first,second,...distinct.filter(item=>item!==first && item!==second)].slice(0,10);
}

export function sealedCoverage(cases: readonly LearningCase[], scope: "GLOBAL" | "WORKBENCH"): boolean {
  return new Set(cases.map(item=>item.groupId)).size>=5 && (scope==="WORKBENCH" || new Set(cases.map(item=>item.workbenchId)).size>=2);
}
