import type { GoalRequirements, RequirementsUpdate } from "../../domain/work/goal-requirements.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { } from "@earendil-works/pi-ai";
import type { GoalRequirementsRepository } from "../../application/ports/goal-requirements.js";
import type { WorkOrchestrationService } from "../../application/work/work-orchestration-service.js";
import type { WorkExecutionNeed } from "../../domain/work/work-execution-needs.js";
import type { GoalWorkListQuery } from "../../application/ports/work-orchestration.js";
import { DomainError } from "../../domain/errors.js";
import { requiresResourceWaitCancellationIntent } from "../../domain/work/workspace-write-scheduling.js";

function projectContract(contract: GoalRequirements | null) {
  if (contract === null) return null;
  return { goalInputId: contract.goalInputId, workbenchId: contract.workbenchId, revision: contract.revision, sourceRevision: contract.sourceRevision,
    processedSourceRevision: contract.processedSourceRevision, status: contract.status, requirementCount: contract.requirements.length,
    ...(contract.nextUnreadSource === undefined ? {} : { nextUnreadSource: contract.nextUnreadSource }) };
}

function result(value: unknown, terminate = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {}, ...(terminate ? { terminate: true } : {}) };
}

const versionedTools = new Set(["work_dispatch", "work_supplement", "work_resume", "work_reassign", "work_update_brief", "goal_resume", "turn_complete"]);

/** A private tool checkpoint shares the existing reasoning turn and never asks users for internal versions. */
export function withGoalRequirementsTools(tools: AgentTool[], input: {
  requirements?: GoalRequirementsRepository;
  goalInputId: string;
  workbenchId: string;
  turnId: string;
  work: Pick<WorkOrchestrationService, "listForGoal" | "readBrief" | "refreshBrief"> & Partial<Pick<WorkOrchestrationService,"listGoalPage">>;
}): AgentTool[] {
  const store = input.requirements;
  if (store === undefined) return tools;
  const matchingWork = async (query: Omit<GoalWorkListQuery,"goalInputId" | "workbenchId" | "cursor" | "limit">) => {
    if (input.work.listGoalPage !== undefined) return (await input.work.listGoalPage({ ...query,goalInputId: input.goalInputId,workbenchId: input.workbenchId,limit: 1 })).items;
    const rows = await input.work.listForGoal(input.goalInputId,input.workbenchId);
    return rows.filter(work => (query.workId === undefined || query.workId === work.workId) && work.workId !== query.excludeWorkId
      && (query.statuses === undefined || query.statuses.includes(work.status))
      && (query.requirementsRevisionNot === undefined || work.requirementsRevision !== (query.requirementsRevisionNot ?? undefined)));
  };
  const hasWork = async (query: Parameters<typeof matchingWork>[0]) => (await matchingWork(query)).length > 0;
  const source = Type.Object({ sourceRevision: Type.Integer({ minimum: 1 }), quote: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    start: Type.Optional(Type.Integer({ minimum: 0 })), end: Type.Optional(Type.Integer({ minimum: 1 })) });
  const readParameters = Type.Object({ sourceRevision: Type.Integer({ minimum: 1 }), offset: Type.Optional(Type.Integer({ minimum: 0 })) });
  const updateParameters = Type.Object({
    expectedRevision: Type.Integer({ minimum: 0 }), processedSourceRevision: Type.Integer({ minimum: 0 }),
    upserts: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 120 }), text: Type.String({ minLength: 1 }),
      kind: Type.Union([Type.Literal("OBJECTIVE"), Type.Literal("DELIVERABLE"), Type.Literal("CONSTRAINT"), Type.Literal("PREFERENCE")]),
      mandatory: Type.Boolean(), scope: Type.Union([Type.Literal("GLOBAL"), Type.Literal("SCOPED")]), source,
      explicitUserCorrection: Type.Optional(Type.Literal(true)) })),
    retirements: Type.Array(Type.Object({ id: Type.String(), source, explicitUserCorrection: Type.Literal(true) })),
  });
  const extra: AgentTool[] = [
    { name: "goal_read_inputs", label: "Read trusted user inputs", description: "Read all pages of a trusted user source, including the middle of long inputs. Read offsets sequentially and use nextOffset. Source revisions and processedSourceRevision are in the current requirements context.", parameters: readParameters,
      execute: async (_id, raw) => { const args = raw as { sourceRevision: number; offset?: number }; return result(await store.readSource({ ...args, offset: args.offset ?? 0, goalInputId: input.goalInputId, workbenchId: input.workbenchId })); } },
    { name: "goal_update_requirements", label: "Merge effective requirements", description: "Merge effective user requirements after reading every new input page. Keep unmentioned requirements. Replacement/retirement requires a new explicit user correction cited by sourceRevision and an exact quote (preferred) or UTF-16 start/end offsets. Mark explicitUserCorrection=true only for a clear user correction; checkpoint requirements from long sources page by page. Record objective, delivery requirements, all mandatory constraints and preferences. Return empty changes for an unrelated supplement. Use expectedRevision and acknowledge the latest source revision. Copy the returned revision into requirementsRevision for execution/completion; sourceRevision and processedSourceRevision are not contract versions. Empty semantic changes may leave revision unchanged; never infer an increment.", parameters: updateParameters,
      execute: async (_id, raw) => {
        const args = raw as Omit<RequirementsUpdate, "goalInputId" | "workbenchId">;
        const resolve = async <T extends { source: RequirementsUpdate["upserts"][number]["source"] }>(change: T): Promise<T> => {
          const candidate = change.source as unknown as { sourceRevision: number; quote?: string; start?: number };
          return candidate.quote === undefined ? change : { ...change, source: await store.resolveSource({ goalInputId: input.goalInputId, workbenchId: input.workbenchId,
            sourceRevision: candidate.sourceRevision, quote: candidate.quote, ...(candidate.start === undefined ? {} : { start: candidate.start }) }) };
        };
        return result(projectContract(await store.update({ ...args, upserts: await Promise.all(args.upserts.map(resolve)), retirements: await Promise.all(args.retirements.map(resolve)), goalInputId: input.goalInputId, workbenchId: input.workbenchId })));
      } },
    { name: "work_list_goal", label: "List goal work", description: "Page this goal's Work identifiers, status, executionPhase, waitReason and pinned requirements revision. READ_QUEUED/WRITE_QUEUED and CAPACITY/WORKSPACE_READ/WORKSPACE_WRITE mean internal resource waits, even when status is RUNNING; they resume automatically, require no work_resume and are not failures. Follow nextCursor. Filter statuses and requirementsRevision/requirementsRevisionNot to find queued outdated Work without rereading completed history. Refresh queued outdated Work before executing or finishing.",
      parameters: Type.Object({ statuses: Type.Optional(Type.Array(Type.Union(["PLANNED","READY","RUNNING","WAITING","COMPLETED","FAILED","CANCELED"].map(value => Type.Literal(value))),{ uniqueItems: true })),
        requirementsRevision: Type.Optional(Type.Integer({ minimum: 0 })),requirementsRevisionNot: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1,maximum: 50 })),cursor: Type.Optional(Type.String()) }),
      execute: async (_id,raw) => result(input.work.listGoalPage === undefined ? { items: await input.work.listForGoal(input.goalInputId,input.workbenchId) }
        : await input.work.listGoalPage({ ...raw as Omit<GoalWorkListQuery,"goalInputId" | "workbenchId">,goalInputId: input.goalInputId,workbenchId: input.workbenchId })) },
    { name: "work_read_brief", label: "Read goal Work instructions", description: "Read this goal's bounded private Work instructions before rewriting a queued or paused task. Returns only that task's existing instructions, without broadcasting cumulative user history.", parameters: Type.Object({ workId: Type.String() }),
      execute: async (_id, raw) => { const args = raw as { workId: string }; const brief = await input.work.readBrief(input.goalInputId, input.workbenchId, args.workId);
        if (brief === null) throw new DomainError("goal_requirements_scope_invalid", "The Work is unavailable in this goal."); return result(brief); } },
    { name: "work_update_brief", label: "Refresh unstarted Work", description: "Replace instructions and applicable requirement selections for a PLANNED/READY Work whose latest attempt has not started, preserving its outbox, dependencies, checks and permissions. Call goal_resume first in a recovery turn. Existing run snapshots are immutable.",
      parameters: Type.Object({ executionNeeds: Type.Optional(Type.Array(Type.Union([Type.Literal("SHELL"),Type.Literal("FILE_WRITE")]), { uniqueItems: true, maxItems: 2 })), requirementsRevision: Type.Optional(Type.Integer()), workId: Type.String(), instructions: Type.String({ minLength: 1, maxLength: 12000 }),
        requirementIds: Type.Optional(Type.Array(Type.String())), allRequirements: Type.Optional(Type.Boolean()) }),
      execute: async (id, raw) => { const args = raw as { executionNeeds?: WorkExecutionNeed[]; requirementsRevision: number; workId: string; instructions: string; requirementIds?: string[]; allRequirements?: boolean }; await input.work.refreshBrief({ ...args, goalInputId: input.goalInputId,
        workbenchId: input.workbenchId, turnId: input.turnId, actionId: `${input.turnId}:${id}` }); return result({ status: "UPDATED", workId: args.workId }); } },
  ];
  const offered = new Set<string>();
  // Prerequisite processing and parameter correction have separate per-tool, per-Turn budgets.
  const prerequisiteOffered = new Set<string>();
  return [...tools, ...extra].map(tool => {
    const versioned = versionedTools.has(tool.name);
    const guarded = versioned || tool.name === "work_cancel" || tool.name === "goal_update_requirements" || tool.name === "goal_read_inputs";
    if (!guarded) return tool;
    return { ...tool, ...(versioned ? { parameters: Type.Object({ ...(tool.parameters as { properties: Record<string, ReturnType<typeof Type.String>> }).properties, requirementsRevision: Type.Optional(Type.Integer({ minimum: 0 })) }) } : {}),
      execute: async (id, args, signal, onUpdate) => {
        try {
          const revision = (args as { requirementsRevision?: number }).requirementsRevision;
          if (versioned) await store.assertReady(input.goalInputId, revision);
          const argsRecord = args as { workId?: string; sourceWorkId?: string; reason?: string };
          const targetId = argsRecord.workId ?? argsRecord.sourceWorkId;
          if (targetId !== undefined && tool.name.startsWith("work_")) {
            const target = (await matchingWork({ workId: targetId }))[0];
            if (target === undefined) throw new DomainError("goal_requirements_scope_invalid", "This Work belongs to another goal.");
            if (tool.name === "work_cancel" && requiresResourceWaitCancellationIntent(target, argsRecord.reason)) {
              return result({ status: "WAITING", workId: targetId, executionPhase: target.executionPhase, waitReason: target.waitReason,
                automaticResume: true, hint: "Keep this Work: the runtime resumes it automatically when resources are available. End this turn without polling or replacement dispatch. Cancel only for an actual user request, changed requirements or superseded work, stating the corresponding reason." });
            }
          }
          if (versioned && tool.name !== "goal_resume" && tool.name !== "work_update_brief") {
            if (await hasWork({ statuses: ["PLANNED","READY"],requirementsRevisionNot: revision ?? null,
              ...(tool.name === "work_reassign" && targetId !== undefined ? { excludeWorkId: targetId } : {}) })) {
              throw new DomainError("goal_requirements_work_stale", "Refresh or cancel outdated queued Work before execution or completion.");
            }
          }
          if (versioned && revision !== undefined) await store.checkpointTurn(input.goalInputId, input.turnId, revision);
          const output = await tool.execute(id, args, signal, onUpdate);
          if (versioned && revision !== undefined) await store.checkpointTurn(input.goalInputId, input.turnId, revision);
          return output;
        } catch (error) {
          if (!(error instanceof DomainError) || (!error.code.startsWith("goal_requirements_") && error.code !== "work_instructions_invalid")) throw error;
          const budget = error.code === "goal_requirements_pending" ? prerequisiteOffered : offered;
          if (budget.has(tool.name)) return result({ status: "FAILED", reasonCode: error.code }, true);
          budget.add(tool.name);
          return result({ status: "RETRY_REQUIRED", reasonCode: error.code, contract: projectContract(await store.load(input.goalInputId, input.workbenchId)),
            hint: "Read remaining trusted source pages, incrementally merge requirements, refresh outdated queued Work using work_list_goal/work_read_brief/work_update_brief, then retry with requirementsRevision copied exactly from contract.revision or goal_update_requirements' returned revision. Do not use sourceRevision or processedSourceRevision and do not infer an increment. Do not ask the user to supply internal fields." });
        }
      },
    };
  });
}
