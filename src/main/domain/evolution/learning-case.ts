import { DomainError } from "../errors.js";
import type { CompletionDecision, EvolutionScenario } from "./scenarios.js";

export interface LearningFacts {
  goalId: string;
  workbenchId: string;
  sourceGroupId?: string;
  requirementsRevision: number;
  resultRevision: number;
  observedAt: string;
  completed: boolean;
  canceled: boolean;
  verified: number;
  failed: number;
  unverified: number;
  requirementCount: number;
  coveredRequirementCount: number;
  foreignEvidenceCount: number;
  dependencyViolationCount: number;
  redundantReads: number;
  environmentFailed: boolean;
  executionFailed: boolean;
}
export type LearningDefect = "false_completion" | "requirement_gap" | "evidence_identity" | "dependency_order" | "redundant_read" | "healthy";
export interface LearningCase {
  caseId: string;
  groupId: string;
  workbenchId: string;
  goalId: string;
  requirementsRevision: number;
  resultRevision: number;
  observedAt: string;
  profile: string;
  defect: LearningDefect;
  split: "development" | "sealed";
  expected: CompletionDecision;
  evidence: Record<string, string>;
  requiredIds: string[];
}

// A deterministic non-cryptographic identifier keeps private provenance out of model-facing aliases.
function fingerprint(value: string): string {
  let first = 2166136261;
  let second = 2246822507;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function validateFacts(facts: LearningFacts): void {
  const counts = [facts.verified, facts.failed, facts.unverified, facts.requirementCount, facts.coveredRequirementCount,
    facts.foreignEvidenceCount, facts.dependencyViolationCount, facts.redundantReads];
  if (!counts.every(value => Number.isSafeInteger(value) && value >= 0)
    || facts.coveredRequirementCount > facts.requirementCount
    || typeof facts.goalId !== "string" || facts.goalId.length === 0
    || typeof facts.workbenchId !== "string" || facts.workbenchId.length === 0
    || (facts.sourceGroupId !== undefined && (typeof facts.sourceGroupId !== "string" || facts.sourceGroupId.length === 0))
    || typeof facts.observedAt !== "string" || !Number.isFinite(Date.parse(facts.observedAt))
    || ![facts.completed, facts.canceled, facts.environmentFailed, facts.executionFailed].every(value => typeof value === "boolean")) {
    throw new DomainError("evolution_case_invalid", "Learning facts must contain valid authoritative counts and revisions.");
  }
}

export function learningProfile(requirementCount: number): string {
  if (!Number.isSafeInteger(requirementCount) || requirementCount < 0) {
    throw new DomainError("evolution_case_invalid", "Requirement count must be a nonnegative integer.");
  }
  const countBucket = requirementCount <= 10 ? "small" : requirementCount <= 100 ? "medium" : "large";
  return `requirements:${requirementCount > 0 ? "explicit" : "absent"};count:${countBucket}`;
}

export function buildLearningCases(facts: LearningFacts): LearningCase[] {
  validateFacts(facts);
  if (![facts.requirementsRevision, facts.resultRevision].every(value => Number.isSafeInteger(value) && value >= 1)) return [];
  if (facts.canceled || facts.environmentFailed || facts.executionFailed || facts.verified + facts.failed === 0) return [];
  const gap = facts.coveredRequirementCount < facts.requirementCount;
  const incomplete = facts.failed > 0 || facts.unverified > 0 || gap || facts.foreignEvidenceCount > 0 || facts.dependencyViolationCount > 0;
  if (!facts.completed && !incomplete) return [];
  const expected: CompletionDecision = incomplete ? "continue" : "complete";
  const defects: LearningDefect[] = [];
  if (facts.completed && incomplete) defects.push("false_completion");
  if (gap) defects.push("requirement_gap");
  if (facts.foreignEvidenceCount > 0) defects.push("evidence_identity");
  if (facts.dependencyViolationCount > 0) defects.push("dependency_order");
  if (facts.redundantReads > 0) defects.push("redundant_read");
  if (defects.length === 0 && !incomplete && facts.completed) defects.push("healthy");
  const groupId = `group-${fingerprint(facts.sourceGroupId ?? facts.goalId)}`;
  const split = (Number.parseInt(groupId.slice(-2), 16) % 5 === 0) ? "sealed" : "development";
  const profile = learningProfile(facts.requirementCount);
  const snapshot = fingerprint(JSON.stringify([facts.completed, facts.verified, facts.failed, facts.unverified,
    facts.requirementCount, facts.coveredRequirementCount, facts.foreignEvidenceCount,
    facts.dependencyViolationCount, facts.redundantReads]));
  return defects.map(defect => ({
    caseId: `case-${fingerprint(JSON.stringify([facts.goalId, facts.requirementsRevision, facts.resultRevision, snapshot, defect]))}`,
    groupId, workbenchId: facts.workbenchId, goalId: facts.goalId,
    requirementsRevision: facts.requirementsRevision, resultRevision: facts.resultRevision, observedAt: facts.observedAt,
    profile, defect, split, expected, requiredIds: ["requirements", "verification", "workflow"],
    evidence: {
      requirements: `Authoritative current-goal requirement register: ${String(facts.requirementCount)} explicit requirements; ${String(facts.coveredRequirementCount)} covered. A zero count does not establish missing requirements.`,
      verification: `Current-revision authoritative checks: ${String(facts.verified)} passed; ${String(facts.failed)} failed; ${String(facts.unverified)} unverified. Foreign-goal references: ${String(facts.foreignEvidenceCount)}. Foreign evidence cannot satisfy current acceptance.`,
      workflow: `Dependency violations: ${String(facts.dependencyViolationCount)}. Redundant read operations: ${String(facts.redundantReads)}. Completion claimed: ${facts.completed ? "yes" : "no"}. A completion claim cannot override failed checks, missing coverage, foreign evidence or unmet prerequisites. Bounded local verification is available; no user decision is required.`,
    },
  }));
}

export function asScenario(learningCase: LearningCase): EvolutionScenario {
  const planning = learningCase.defect === "dependency_order"
    ? " Before finishing, submit a corrective work_plan with exactly these local task aliases: source (title Read prerequisite evidence), review (title Review dependent result), verify (title Verify acceptance). Use partnerId fixture-reader, accessMode READ, executionNeeds [], and acceptanceChecks [{kind: BODY_PRESENT}] on every task. Declare review dependsOnKey source, then verify dependsOnKey review. These are isolated text-only plan records; they do not execute or change the observed results. Omit optional instructions and requirement revision."
    : "";
  return {
    id: learningCase.caseId,
    family: `production-${learningCase.defect}`,
    request: `Review the current goal using its authoritative requirement, verification and workflow registers. Decide whether acceptance is complete or bounded verification must continue. Read every required register. Do not perform or repeat any external action.${planning}`,
    evidence: { ...learningCase.evidence }, requiredIds: [...learningCase.requiredIds], expected: learningCase.expected,
  };
}
