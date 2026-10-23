import { DomainError } from "../errors.js";

export type ContextOperation = "requirements_map" | "open_questions_first" | "handoff_first" | "read_conflicting_evidence";
export type PlanningOperation = "dependency_outline" | "parallel_readonly" | "verification_work_item";
export type CompletionOperation = "acceptance_matrix" | "stale_evidence_check" | "contradiction_check";
export type MethodModule = "context" | "planning" | "completion";
export interface MethodPolicy {
  version: 2;
  context: ContextOperation[];
  planning: PlanningOperation[];
  completion: CompletionOperation[];
}

export const baselineMethodPolicy: Readonly<MethodPolicy> = Object.freeze({ version: 2, context: [], planning: [], completion: [] });
const modules: readonly MethodModule[] = ["context", "planning", "completion"];
export const METHOD_OPERATIONS = {
  context: ["requirements_map", "open_questions_first", "handoff_first", "read_conflicting_evidence"],
  planning: ["dependency_outline", "parallel_readonly", "verification_work_item"],
  completion: ["acceptance_matrix", "stale_evidence_check", "contradiction_check"],
} as const satisfies Record<MethodModule, readonly string[]>;
for (const module of modules) {
  Object.freeze(METHOD_OPERATIONS[module]);
  Object.freeze(baselineMethodPolicy[module]);
}
Object.freeze(METHOD_OPERATIONS);

export function parseMethodPolicy(value: unknown, parent?: Readonly<MethodPolicy>): MethodPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidPolicy();
  const record = value as Record<string, unknown>;
  if (record.version !== 2 || Object.keys(record).length !== 4
    || Object.keys(record).some(key => key !== "version" && !(modules as readonly string[]).includes(key))) return invalidPolicy();
  for (const module of modules) {
    const choices = record[module];
    if (!Array.isArray(choices) || choices.length > 3 || new Set(choices).size !== choices.length
      || !choices.every((choice: unknown) => typeof choice === "string" && (METHOD_OPERATIONS[module] as readonly string[]).includes(choice))) return invalidPolicy();
  }
  const policy: MethodPolicy = {
    version: 2,
    context: [...record.context as ContextOperation[]],
    planning: [...record.planning as PlanningOperation[]],
    completion: [...record.completion as CompletionOperation[]],
  };
  if (parent !== undefined && modules.filter(module => JSON.stringify(policy[module]) !== JSON.stringify(parent[module])).length !== 1) return invalidPolicy();
  return policy;
}

function invalidPolicy(): never {
  throw new DomainError("evolution_strategy_invalid", "Working method must contain only registered operations and change exactly one module.");
}

export function policyKey(policy: Readonly<MethodPolicy>): string {
  const validated = parseMethodPolicy(policy);
  return JSON.stringify(validated);
}

const templates: Record<ContextOperation | PlanningOperation | CompletionOperation, string> = {
  requirements_map: "Map the current goal's requirements to relevant results before summarizing. Preserve unmet requirements and retrieve their current-goal evidence.",
  open_questions_first: "List unresolved questions and unmet requirements before advancing. Preserve them through context summaries.",
  handoff_first: "Read the current work handoff and its evidence references before rebuilding context. A handoff claim alone is not authoritative verification.",
  read_conflicting_evidence: "Read the authoritative current-goal records behind conflicting claims. Preserve unresolved contradictions rather than selecting a convenient claim.",
  dependency_outline: "Outline the dependencies between work items before dispatch. A dependent item must wait for verified prerequisites.",
  parallel_readonly: "Run independent read-only work concurrently only when its inputs and dependency constraints permit. Keep external side effects behind the existing gates.",
  verification_work_item: "Create one bounded verification work item for missing acceptance evidence. Do not repeat an external action to obtain evidence.",
  acceptance_matrix: "Before completion, map each acceptance requirement to authoritative evidence for this goal and revision. Missing evidence requires verification or an explicit blocked outcome.",
  stale_evidence_check: "Before completion, confirm every cited check covers the current requirement and result revisions. Earlier revisions and other goals cannot satisfy current acceptance.",
  contradiction_check: "Before completion, check current evidence for contradictions, failed checks and missing deliverables. Resolve them with bounded verification or report the blocking decision.",
};

export function composeMethodInstructions(policy: Readonly<MethodPolicy>): string {
  const validated = parseMethodPolicy(policy);
  return ["Preserve the original goal and explicit constraints. User requirements and immutable runtime gates always take precedence. These working methods never authorize code execution, permission changes or external side effects.",
    ...modules.flatMap(module => validated[module].map(operation => templates[operation])),
  ].join("\n");
}
