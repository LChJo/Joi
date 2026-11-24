import { DomainError } from "../../domain/errors.js";
import { decisionPageKey, type DecisionEvidenceRead, type DecisionFragment, type DecisionFragmentGrade } from "../../domain/evolution/learning-decision-fragment.js";
import { composeMethodInstructions } from "../../domain/evolution/learning-policy.js";
import type { EvolutionLearningDto, EvolutionShadowArmDto } from "../../../shared/evolution.js";

export type ShadowView = NonNullable<EvolutionLearningDto["shadow"]>;
export interface ShadowTrial {
  variant: "baseline" | "candidate";
  modelCalls: number;
  tokens: number;
  tokensComplete: boolean;
  actions: string[];
  observations: string[];
  backingReads?: number;
  toolRequests?: number;
  success?: boolean;
}
export interface ShadowRun {
  contextVersion: 1;
  fragment: DecisionFragment;
  grade: DecisionFragmentGrade;
  callLimit: number;
  verdict: ShadowView["verdict"];
}
function pages(fragment: DecisionFragment): Map<string,DecisionEvidenceRead> {
  const known = new Map<string,DecisionEvidenceRead>();
  const fingerprints = new Set<string>();
  for (const read of fragment.reads) {
    const key = decisionPageKey(read);
    if (fingerprints.has(key)) continue;
    fingerprints.add(key);
    known.set(`page-${String(known.size+1)}`,read);
  }
  return known;
}

export function shadowPrompt(shadow: ShadowRun, trial: ShadowTrial) {
  const aliases = new Map<string,string>();
  const index = [...pages(shadow.fragment)].map(([alias,page])=>{
    if (!aliases.has(page.resultId)) aliases.set(page.resultId,`result-${String(aliases.size+1)}`);
    return {alias,result:aliases.get(page.resultId),offset:page.start,length:page.end-page.start};
  });
  const candidate = trial.variant === "candidate" ? "\nRetain valid page aliases after a successful read. Cite the existing observation directly if it still covers the same result and page. Read again when the retained record is missing or invalid." : "";
  return {mode:"simulation" as const,
    systemPrompt:`${composeMethodInstructions(shadow.fragment.parent)}\nIsolated decision fragment. Read the local evidence pages and submit a completion decision with the aliases you used. Verification is independent of your decision. Use only the tools in this request.${candidate}`,
    prompt:JSON.stringify({requirements:shadow.fragment.requirements.map(({mandatory}, index)=>({alias:`requirement-${String(index+1)}`,mandatory})),
      index,observations:trial.observations})};
}

export function applyShadowAction(shadow: ShadowRun, trial: ShadowTrial, value: unknown, load: (page: DecisionEvidenceRead) => string | null) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainError("evolution_response_invalid","Shadow action is invalid.");
  const action = value as Record<string,unknown>;
  const available = pages(shadow.fragment);
  if (action.action === "read_evidence" && typeof action.evidenceId === "string") {
    const alias = action.evidenceId;
    const page = available.get(alias);
    if (page === undefined) throw new DomainError("evolution_response_invalid","The page alias does not belong to this fragment.");
    trial.toolRequests=(trial.toolRequests ?? 0)+1;
    const reuse = trial.variant === "candidate" && page.verification === "PASSED" && trial.actions.includes(alias);
    if (reuse) return;
    trial.backingReads=(trial.backingReads ?? 0)+1;
    if (load(page) === null) throw new DomainError("evolution_shadow_stale","The replay evidence changed.");
    trial.actions.push(alias);
    trial.observations.push(JSON.stringify({alias,verification:page.verification,offset:page.start,length:page.end-page.start}));
    return;
  }
  if (action.action !== "finish" || typeof action.decision !== "string" || !["complete","continue","wait"].includes(action.decision)
    || !Array.isArray(action.evidenceIds) || action.evidenceIds.length>10 || !action.evidenceIds.every(id=>typeof id==="string" && trial.actions.includes(id))) {
    throw new DomainError("evolution_response_invalid","The shadow decision must cite observed page aliases.");
  }
  const cited = new Set((action.evidenceIds as string[]).map(id=>available.get(id))
    .filter(page=>page?.verification==="PASSED").map(page=>page?.resultId));
  trial.success = action.decision===shadow.grade.disposition && shadow.grade.citedResultIds.every(id=>cited.has(id));
}

export function shadowArm(trials: readonly ShadowTrial[], variant: ShadowTrial["variant"]): EvolutionShadowArmDto {
  const arm = trials.filter(trial=>trial.variant===variant);
  return {trials:arm.filter(trial=>trial.success!==undefined).length,success:arm.filter(trial=>trial.success===true).length,
    backingReads:arm.reduce((total,trial)=>total+(trial.backingReads ?? 0),0),
    toolRequests:arm.reduce((total,trial)=>total+(trial.toolRequests ?? 0),0),
    modelCalls:arm.reduce((total,trial)=>total+trial.modelCalls,0),
    tokens:arm.every(trial=>trial.tokensComplete) ? arm.reduce((total,trial)=>total+trial.tokens,0) : null};
}

export function shadowVerdict(trials: readonly ShadowTrial[]): NonNullable<ShadowView["verdict"]> {
  const baseline = shadowArm(trials,"baseline"), candidate = shadowArm(trials,"candidate");
  if (candidate.success<baseline.success) return "quality_regression";
  if (candidate.success===0) return "parent";
  const benefits = candidate.backingReads<baseline.backingReads || candidate.toolRequests<baseline.toolRequests;
  return benefits && candidate.modelCalls<=baseline.modelCalls ? "candidate" : "parent";
}
