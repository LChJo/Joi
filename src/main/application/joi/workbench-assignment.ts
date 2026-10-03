import { judgeWorkbenchMatch } from "../../../shared/workbench-suggestions.js";
import { proposedWorkbenchRejection, type ProposedWorkbench } from "../../domain/workbench/workbench-naming.js";
import type { WorkbenchRoutingRuntime } from "../ports/joi-coordinator.js";
import type { WorkbenchSummary } from "../ports/workbench-context.js";

export interface AbstractWorkbenchDraft extends ProposedWorkbench {
  personaSummary: string;
}

export type WorkbenchAssignment =
  | { action: "select"; resolution: "bootstrap" | "selected"; workbenchId: string }
  | { action: "create"; draft: AbstractWorkbenchDraft; resolution: "bootstrap" | "created" }
  /** The one case worth interrupting the user for: two scopes both plausibly hold this input. */
  | { action: "clarify"; reasonCode: "workbench_selection_invalid" };

type WorkbenchDecision = { action: "select"; workbenchId: string } | ({ action: "create" } & AbstractWorkbenchDraft);

/**
 * The bucket for inputs that belong nowhere else, and the last resort when no cluster can be
 * named for them either. One shared bucket: a generic workbench per input is just a per-request
 * folder wearing a name, which is what this whole decision exists to avoid.
 */
export const BOOTSTRAP_WORKBENCH: AbstractWorkbenchDraft = {
  name: "joi 工作台",
  personaSummary: "承接第一批输入的通用 joi 上下文；可在上下文中心改名或调整范围。",
  projectLabel: "joi 工作台",
  scopeSummary: "尚无 Workbench 时自动创建的通用工作台；只承接不成独立目标的杂项输入，明确的新目标应创建新 Workbench。",
};

/**
 * One structured decision, or null when it cannot be used.
 *
 * `abstract` only accepts a create: that pass exists to name a cluster after routing found
 * nothing, so a select coming back is the router answering a question it was not asked.
 */
function readDecision(value: unknown, input: { canCreate: boolean; known: ReadonlySet<string>; requestText: string; abstract: boolean }): WorkbenchDecision | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!input.abstract && record.action === "select" && typeof record.workbenchId === "string" && input.known.has(record.workbenchId)) {
    return { action: "select", workbenchId: record.workbenchId };
  }
  if (!input.canCreate || record.action !== "create" || typeof record.name !== "string"
    || typeof record.personaSummary !== "string" || typeof record.projectLabel !== "string"
    || typeof record.scopeSummary !== "string") {
    return null;
  }
  const draft = { name: record.name, personaSummary: record.personaSummary, projectLabel: record.projectLabel, scopeSummary: record.scopeSummary };
  return proposedWorkbenchRejection(input.requestText, draft) === null ? { action: "create", ...draft } : null;
}

/** Whether a rejected draft is worth one repaired retry, or the model simply answered something else. */
function wasRejectedForEcho(value: unknown, requestText: string): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.action !== "create" || typeof record.name !== "string"
    || typeof record.personaSummary !== "string" || typeof record.projectLabel !== "string"
    || typeof record.scopeSummary !== "string") {
    return false;
  }
  return proposedWorkbenchRejection(requestText, {
    name: record.name, projectLabel: record.projectLabel, scopeSummary: record.scopeSummary,
  }) !== null;
}

/**
 * Decide where an unbound input belongs.
 *
 * The order is the whole point: ask the router to *place* the input first, fall back to a local
 * match when the router cannot, and only create something new once both agree nothing existing
 * fits. Interrupting the user is the last resort, not the default — a card for every input that
 * the router happened to be unsure about is what made this untrustworthy.
 */
export async function resolveWorkbenchAssignment(input: {
  canCreate: boolean;
  requestText: string;
  router: WorkbenchRoutingRuntime;
  workbenches: readonly WorkbenchSummary[];
}): Promise<WorkbenchAssignment> {
  const known = new Set(input.workbenches.map((workbench) => workbench.workbenchId));
  let decision: WorkbenchDecision | null = null;
  for (let attempt = 0; attempt < 2 && decision === null; attempt += 1) {
    decision = readDecision(
      await input.router.decide({ input: input.requestText, mode: "route", repair: attempt === 1, workbenches: [...input.workbenches] }),
      { abstract: false, canCreate: input.canCreate, known, requestText: input.requestText },
    );
  }
  if (decision?.action === "select") return { action: "select", resolution: "selected", workbenchId: decision.workbenchId };
  if (decision?.action === "create") return { action: "create", draft: decision, resolution: "created" };

  // The router did not place it. A local match still can, with no second model call and no card.
  const verdict = judgeWorkbenchMatch(input.requestText, input.workbenches);
  if (verdict.kind === "confident") return { action: "select", resolution: "selected", workbenchId: verdict.match.workbench.workbenchId };
  if (verdict.kind === "ambiguous") return { action: "clarify", reasonCode: "workbench_selection_invalid" };
  if (!input.canCreate) return { action: "clarify", reasonCode: "workbench_selection_invalid" };

  // Nothing existing fits, so name the cluster this work belongs to — and fall back to the
  // shared bucket rather than to a question when even that comes back as a restatement.
  const abstracted = await input.router.decide({ input: input.requestText, mode: "abstract", repair: false, workbenches: [...input.workbenches] });
  const named = readDecision(abstracted, { abstract: true, canCreate: true, known, requestText: input.requestText });
  if (named?.action === "create") return { action: "create", draft: named, resolution: "created" };
  if (wasRejectedForEcho(abstracted, input.requestText)) {
    const repaired = await input.router.decide({ input: input.requestText, mode: "abstract", repair: true, workbenches: [...input.workbenches] });
    const retried = readDecision(repaired, { abstract: true, canCreate: true, known, requestText: input.requestText });
    if (retried?.action === "create") return { action: "create", draft: retried, resolution: "created" };
  }
  return genericWorkbenchAssignment(input.workbenches);
}

/** Reuse the shared bucket if it already exists; the first input that needed one created it. */
function genericWorkbenchAssignment(workbenches: readonly WorkbenchSummary[]): WorkbenchAssignment {
  const existing = workbenches.find((workbench) => workbench.name === BOOTSTRAP_WORKBENCH.name);
  return existing === undefined
    ? { action: "create", draft: BOOTSTRAP_WORKBENCH, resolution: "bootstrap" }
    : { action: "select", resolution: "bootstrap", workbenchId: existing.workbenchId };
}
