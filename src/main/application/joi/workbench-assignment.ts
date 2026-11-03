import type { WorkbenchProposalDto } from "../../../shared/joi.js";
import { proposedWorkbenchRejection } from "../../domain/workbench/workbench-naming.js";
import type { WorkbenchRoutingRuntime } from "../ports/joi-coordinator.js";
import type { WorkbenchSummary } from "../ports/workbench-context.js";
import { sanitizeAgentConversationText } from "../partners/agent-conversation-presentation.js";

export type WorkbenchAssignment =
  | { action: "select"; resolution: "selected"; workbenchId: string }
  | { action: "clarify"; reasonCode: "workbench_selection_invalid"; proposal?: WorkbenchProposalDto };

type Decision = { action: "select"; workbenchId: string } | { action: "clarify" } | { action: "create"; proposal: WorkbenchProposalDto };

function readDecision(value: unknown, input: { canCreate: boolean; known: ReadonlySet<string>; requestText: string; abstract: boolean }): Decision | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!input.abstract && record.action === "clarify") return { action: "clarify" };
  if (!input.abstract && record.action === "select" && typeof record.workbenchId === "string"
    && input.known.has(record.workbenchId) && (record.matchKind === "SAME_PROJECT" || record.matchKind === "SAME_SCOPE")) {
    return { action: "select", workbenchId: record.workbenchId };
  }
  if (!input.canCreate || record.action !== "create" || typeof record.name !== "string"
    || typeof record.projectLabel !== "string" || typeof record.scopeSummary !== "string") return null;
  const proposal = { name: record.name.trim(), projectLabel: record.projectLabel.trim(), scopeSummary: record.scopeSummary.trim() };
  if (!proposal.projectLabel || proposal.projectLabel.length > 120 || !proposal.scopeSummary || proposal.scopeSummary.length > 1000
    || proposedWorkbenchRejection(input.requestText, proposal) !== null) return null;
  return { action: "create", proposal: {
    name: sanitizeAgentConversationText(proposal.name),
    projectLabel: sanitizeAgentConversationText(proposal.projectLabel),
    scopeSummary: sanitizeAgentConversationText(proposal.scopeSummary),
  } };
}

/** Only an explicit semantic scope match may bind an unassigned input without user confirmation. */
export async function resolveWorkbenchAssignment(input: {
  canCreate: boolean;
  requestText: string;
  router: WorkbenchRoutingRuntime;
  workbenches: readonly WorkbenchSummary[];
}): Promise<WorkbenchAssignment> {
  const known = new Set(input.workbenches.map((workbench) => workbench.workbenchId));
  let decision: Decision | null = null;
  for (let attempt = 0; attempt < 2 && decision === null; attempt += 1) {
    decision = readDecision(
      await input.router.decide({ input: input.requestText, mode: "route", repair: attempt === 1, workbenches: [...input.workbenches] }),
      { abstract: false, canCreate: input.canCreate, known, requestText: input.requestText },
    );
  }
  if (decision?.action === "select") return { action: "select", resolution: "selected", workbenchId: decision.workbenchId };
  const waiting = { action: "clarify", reasonCode: "workbench_selection_invalid" } as const;
  if (decision?.action === "create") return { ...waiting, proposal: decision.proposal };
  if (!input.canCreate) return waiting;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await input.router.decide({ input: input.requestText, mode: "abstract", repair: attempt === 1, workbenches: [...input.workbenches] });
    const named = readDecision(raw, { abstract: true, canCreate: true, known, requestText: input.requestText });
    if (named?.action === "create") return { ...waiting, proposal: named.proposal };
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || (raw as Record<string, unknown>).action !== "create") break;
  }
  return waiting;
}
