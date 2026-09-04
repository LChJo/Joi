import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { PartnerInstanceManager } from "../../application/partners/partner-instance-manager.js";
import type { PartnerRegistryService } from "../../application/partners/partner-registry-service.js";
import type { PartnerWorkMemoryService } from "../../application/partners/partner-work-memory-service.js";
import type { WorkOrchestrationService } from "../../application/work/work-orchestration-service.js";
import { DISPATCH_POLICY_REASONS } from "../../application/work/dispatch-policy.js";
import type { ModelSourceService } from "../../application/model-sources/model-source-service.js";
import type { WorkbenchCatalog } from "../../application/ports/workbench-context.js";
import type { WorkbenchChangeService } from "../../application/joi/workbench-change-service.js";
import type { WorkbenchManagementService } from "../../application/joi/workbench-management-service.js";
import type { WorkbenchWorkspaceService } from "../../application/joi/workbench-workspace-service.js";
import type { WorkResultService } from "../../application/work/work-result-service.js";
import type { JoiCoordinatorStore } from "../../application/ports/joi-coordinator.js";
import type { JoiHarnessStore } from "../../application/ports/joi-harness.js";
import type { JoiAttachmentPort } from "../../application/ports/managed-file-ports.js";
import type { AutomationService } from "../../application/automation/automation-service.js";
import type { AutomationFrequency } from "../../../shared/automation.js";
import type { PartnerSkillCatalog } from "../../application/ports/partner-skills.js";
import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
  type RuntimeDiagnostics,
} from "../../application/ports/runtime-diagnostics.js";
import { DomainError } from "../../domain/errors.js";
import { partnerClusterKey, partnerClusterName } from "../../domain/workbench/workbench-naming.js";
import { PI_PARTNER_TOOL_NAMES } from "./pi-coding-tool-factory.js";

/** Extracts the original goal input id from synthetic input ids; undefined for direct goal inputs. */
export function goalFromInputIdPrefix(inputId: string): string | undefined {
  const resultPrefix = "joi_result_input:goal:";
  if (inputId.startsWith(resultPrefix)) return inputId.slice(resultPrefix.length);
  const reviewPrefix = "joi_harness_review:goal:";
  if (inputId.startsWith(reviewPrefix)) {
    const remainder = inputId.slice(reviewPrefix.length);
    const separator = remainder.lastIndexOf(":r");
    return separator < 0 ? remainder : remainder.slice(0, separator);
  }
  const recoveryPrefix = "joi_recovery:goal:";
  if (inputId.startsWith(recoveryPrefix)) {
    const remainder = inputId.slice(recoveryPrefix.length);
    const separator = remainder.indexOf(":work:");
    return separator < 0 ? remainder : remainder.slice(0, separator);
  }
  return undefined;
}

const PI_PARTNER_TOOL_NAME_SET = new Set<string>(PI_PARTNER_TOOL_NAMES);

function result(value: unknown, terminate = false) {
  return {
    content: [{ text: JSON.stringify(value), type: "text" as const }],
    details: {},
    ...(terminate ? { terminate: true } : {}),
  };
}

function normalizePartnerTools(values: string[] | undefined): string[] {
  if (values === undefined) return [];
  if (values.length > PI_PARTNER_TOOL_NAMES.length) {
    throw new DomainError("partner_tools_invalid", "Too many partner tools were requested.");
  }
  const normalized = [...new Set(values.map((value) => value.trim()))];
  if (normalized.some((value) => !PI_PARTNER_TOOL_NAME_SET.has(value))) {
    throw new DomainError("partner_tool_not_allowed", "The requested partner tool is not available.");
  }
  return normalized;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

// Partner cards must never ship empty: when the model omits description/prompt,
// synthesize a minimal profile in the same DO/acceptance/out-of-scope house style.
function synthesizePartnerProfile(displayName: string, skills: string[], capabilities: string[]): { description: string; prompt: string } {
  const focus = [...skills, ...capabilities].map((item) => item.trim()).filter((item) => item.length > 0).join("、");
  const description = focus.length > 0 ? `${displayName}：覆盖${focus}。` : `${displayName}：由 joi 按需创建，承接目标内相应工作。`;
  const prompt = `你是一位${displayName}搭档。DO：围绕被分配的目标主动推进${focus.length > 0 ? `，覆盖${focus}` : ""}；先给结论再给依据，标明前提与不确定性。验收标准：产出可执行、可验证，附关键证据与来源；未验证内容标注为推测。范围外：不碰与目标无关的内容，不编造数据或来源。`;
  return { description, prompt };
}

const SYNTHESIS_TOOL_NAMES = new Set([
  "model_list_sources", "partner_list_available", "partner_set_model", "partner_set_tools", "turn_complete", "work_cancel", "work_read_result", "work_reassign", "work_resume", "work_supplement",
]);

const ATTACHMENT_CHUNK_CHARS = 8_000;

export function selectJoiReasoningToolsForInput(tools: AgentTool[], inputId: string): AgentTool[] {
  if (!inputId.startsWith("joi_result_input:goal:") && !inputId.startsWith("joi_recovery:goal:")) return tools;
  return tools.filter((tool) => SYNTHESIS_TOOL_NAMES.has(tool.name));
}

export function createJoiReasoningTools(input: {
  automation?: Pick<AutomationService, "create" | "delete" | "get" | "list" | "revealPrompt" | "runNow" | "setEnabled" | "update">;
  workbenchId: string;
  workbenchChanges: Pick<WorkbenchChangeService, "suggestArchive" | "suggestMerge">;
  workbenchRefine?: Pick<WorkbenchManagementService, "update">;
  workbenchWorkspaces: Pick<WorkbenchWorkspaceService, "bindExisting">;
  directoryPicker: () => Promise<string | null>;
  workbenches: WorkbenchCatalog;
  /** Attachment ids bound to the current input; scopes attachment_read. */
  attachmentIds?: readonly string[];
  /** Verified attachment reader; attachment_read is only registered together with attachmentIds. */
  attachments?: Pick<JoiAttachmentPort, "read">;
  clarifications: Pick<JoiCoordinatorStore, "requireClarification">;
  diagnostics?: RuntimeDiagnostics;
  /** Original goal input id; harness tools and goal-binding fall back to inputId when absent. */
  goalInputId?: string | undefined;
  harness?: Pick<JoiHarnessStore, "chartPath" | "clearMap" | "graduateFog" | "nameDestination" | "noteFog" | "recordDecision">;
  inputId: string;
  instances: Pick<PartnerInstanceManager, "dispose" | "ensure" | "list">;
  memory: Pick<PartnerWorkMemoryService, "digest">;
  models: Pick<ModelSourceService, "list">;
  partners: Pick<PartnerRegistryService, "add" | "inspect" | "list" | "setModel" | "setSkills" | "setTools">;
  results: Pick<WorkResultService, "read">;
  skills: Pick<PartnerSkillCatalog, "listForEngine">;
  turnId: string;
  work: Pick<WorkOrchestrationService, "cancel" | "plan" | "reassign" | "resume" | "supplement">;
}): AgentTool[] {
  let dispatchCorrectionOffered = false;
  const goalContext = (): string => input.goalInputId ?? input.inputId;
  const requireHarness = (): NonNullable<typeof input.harness> => {
    if (input.harness === undefined) throw new DomainError("harness_map_unavailable", "The goal map is not configured.");
    return input.harness;
  };
  const automationFrequencyParameters = Type.Object({
    anchorAt: Type.Optional(Type.String()), at: Type.Optional(Type.String()),
    daysOfMonth: Type.Optional(Type.Array(Type.Number())), daysOfWeek: Type.Optional(Type.Array(Type.Number())),
    dtStart: Type.Optional(Type.String()), hours: Type.Optional(Type.Number()), kind: Type.String(),
    localTime: Type.Optional(Type.String()), rule: Type.Optional(Type.String()), unit: Type.Optional(Type.String()),
  });
  const automationParameters = Type.Object({
    frequency: automationFrequencyParameters, name: Type.String(), preferredPartnerId: Type.Optional(Type.String()),
    prompt: Type.String(), to: Type.Optional(Type.String()), from: Type.Optional(Type.String()), workbenchId: Type.Optional(Type.String()),
  });
  const automationUpdateParameters = Type.Object({
    enabled: Type.Optional(Type.Boolean()), frequency: Type.Optional(automationFrequencyParameters), name: Type.Optional(Type.String()),
    preferredPartnerId: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()), routineId: Type.String(),
    to: Type.Optional(Type.String()), from: Type.Optional(Type.String()), workbenchId: Type.Optional(Type.String()),
  });
  const automationMutation = (name: string, execute: (toolCallId: string, args: Record<string, unknown>) => Promise<unknown>): AgentTool => ({
    description: "Manage a recurring Routine through the single joi scheduler.", execute: async (toolCallId, args) => {
      if (input.automation === undefined) throw new DomainError("automation_runtime_unavailable", "Automation runtime is unavailable.");
      return result(await execute(toolCallId, args as Record<string, unknown>));
    }, label: name, name, parameters: automationParameters,
  });
  const automation = input.automation;
  const automationTools: AgentTool[] = automation === undefined ? [] : [
    automationMutation("create_automation", async (toolCallId, args) => automation.create({
      frequency: args.frequency as AutomationFrequency, name: args.name as string, prompt: args.prompt as string, workbenchId: (args.workbenchId as string | undefined) ?? input.workbenchId,
      ...(typeof args.from === "string" ? { from: args.from } : {}), ...(typeof args.to === "string" ? { to: args.to } : {}), ...(typeof args.preferredPartnerId === "string" ? { preferredPartnerId: args.preferredPartnerId } : {}),
    }, `${input.inputId}:${toolCallId}`)),
    automationMutation("schedule_plan", async (toolCallId, args) => automation.create({
      frequency: args.frequency as AutomationFrequency, name: args.name as string, prompt: args.prompt as string, workbenchId: (args.workbenchId as string | undefined) ?? input.workbenchId,
      ...(typeof args.from === "string" ? { from: args.from } : {}), ...(typeof args.to === "string" ? { to: args.to } : {}), ...(typeof args.preferredPartnerId === "string" ? { preferredPartnerId: args.preferredPartnerId } : {}),
    }, `${input.inputId}:${toolCallId}`)),
    {
      description: "List routines without revealing their prompt text.", execute: async () => result(await automation.list()), label: "List routines", name: "list_automations", parameters: Type.Object({}),
    },
    {
      description: "Read one routine's safe configuration without prompt text.", execute: async (_toolCallId, raw) => { const args = raw as Record<string, unknown>; return result(await automation.get(args.routineId as string)); }, label: "Get routine", name: "get_automation", parameters: Type.Object({ routineId: Type.String() }),
    },
    {
      description: "Update a routine. Prompt text is accepted but never echoed by this tool.", execute: async (toolCallId, raw) => { const args = raw as Record<string, unknown>; const { routineId, ...patch } = args; return result(await automation.update(routineId as string, patch, `${input.inputId}:${toolCallId}`)); }, label: "Update routine", name: "update_automation", parameters: automationUpdateParameters,
    },
    {
      description: "Soft-delete a routine without canceling an already queued Joi input.", execute: async (toolCallId, raw) => { const args = raw as Record<string, unknown>; await automation.delete(args.routineId as string, `${input.inputId}:${toolCallId}`); return result({ routineId: args.routineId, status: "DELETED" }); }, label: "Delete routine", name: "delete_automation", parameters: Type.Object({ routineId: Type.String() }),
    },
    {
      description: "Queue one immediate execution of a routine using an idempotent key.", execute: async (toolCallId, raw) => { const args = raw as Record<string, unknown>; return result(await automation.runNow(args.routineId as string, `${input.inputId}:${toolCallId}`)); }, label: "Run routine now", name: "run_automation_now", parameters: Type.Object({ routineId: Type.String() }),
    },
  ];
  const workDispatchParameters = Type.Object({
    dependencies: Type.Array(Type.Object({ dependsOnKey: Type.String(), workKey: Type.String() })),
    work: Type.Array(Type.Object({
      acceptanceChecks: Type.Optional(Type.Array(Type.Union([
        Type.Object({ kind: Type.Literal("BODY_PRESENT") }),
        Type.Object({ kind: Type.Literal("ARTIFACT_PRESENT"), name: Type.String({ maxLength: 240, minLength: 1 }) }),
        Type.Object({
          expectedText: Type.String({ maxLength: 8_000 }), kind: Type.Literal("FILE_CONTAINS_EXACT"),
          relativePath: Type.String({ maxLength: 500, minLength: 1 }),
        }),
        Type.Object({ kind: Type.Literal("FILE_EXISTS"), relativePath: Type.String({ maxLength: 500, minLength: 1 }) }),
      ]), { maxItems: 8, minItems: 1 })),
      accessMode: Type.Union([Type.Literal("NONE"), Type.Literal("READ"), Type.Literal("WRITE")]),
      instanceId: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String({ maxLength: 12_000 })),
      key: Type.String(),
      partnerId: Type.String(),
      sessionPolicy: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("resident")])),
      title: Type.String(),
    }), { minItems: 1, maxItems: 16 }),
  });
  const workDispatchTool: AgentTool<typeof workDispatchParameters> = {
    description: "Persist a checked work DAG and queue each allowed partner dispatch through the outbox. Dependency keys may reference only Work keys declared in the current invocation; historical Work is evidence, not a DAG dependency. Use BODY_PRESENT for a textual answer, ARTIFACT_PRESENT only for an exact filename the partner must create in its workspace, and FILE_EXISTS/FILE_CONTAINS_EXACT only for relative paths inside that workspace. Pass instanceId only as an exact instance id returned by partner_list_available or partner_list_instances; never substitute a partner or revision id. Never pass instanceId together with sessionPolicy. Use sessionPolicy resident only to request a resident conversation; omit both for one-shot ephemeral work.",
    execute: async (_toolCallId, arguments_) => {
      try {
        const currentKeys = new Set(arguments_.work.map((item) => item.key));
        const currentDependencies = arguments_.dependencies.filter((dependency) => (
          currentKeys.has(dependency.workKey) && currentKeys.has(dependency.dependsOnKey)
        ));
        return result(await input.work.plan({
          workbenchId: input.workbenchId,
          dependencies: currentDependencies,
          // Derived inputs (harness review) dispatch on behalf of the original goal so the
          // result set and synthesis closure stay attached to the goal, not the review row.
          inputId: goalContext(),
          turnId: input.turnId,
          work: arguments_.work.map((item) => ({
            ...(item.acceptanceChecks === undefined ? {} : { acceptanceChecks: item.acceptanceChecks }),
            accessMode: item.accessMode,
            ...(item.instanceId === undefined || item.sessionPolicy === "ephemeral" ? {} : { instanceId: item.instanceId }),
            key: item.key,
            ...(item.instructions === undefined ? {} : { instructions: item.instructions }),
            partnerId: item.partnerId,
            ...(item.sessionPolicy === undefined || (item.instanceId !== undefined && item.sessionPolicy === "resident")
              ? {}
              : { sessionPolicy: item.sessionPolicy === "resident" ? "RESIDENT" as const : "EPHEMERAL" as const }),
            title: item.title,
          })),
        }));
      } catch (error) {
        const reasonCode = runtimeDiagnosticErrorCode(error);
        emitRuntimeDiagnostic(input.diagnostics, "joi.work.dispatch_rejected", {
          inputId: input.inputId,
          reasonCode,
          turnId: input.turnId,
          workbenchId: input.workbenchId,
        });
        if (error instanceof DomainError && error.code === DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady) {
          await input.clarifications.requireClarification(
            input.inputId,
            DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady,
            "选择这个 Workbench 的工作目录后，我会继续派发需要读写文件的工作。",
          );
          return result({ reasonCode: DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady, status: "CLARIFICATION_REQUIRED" }, true);
        }
        const correctable = reasonCode === "partner_not_available"
          || reasonCode === "work_dependency_unknown"
          || reasonCode.startsWith("partner_instance_");
        if (correctable && !dispatchCorrectionOffered) {
          dispatchCorrectionOffered = true;
          return result({ reasonCode, status: "RETRY_REQUIRED" });
        }
        if (correctable) {
          await input.clarifications.requireClarification(
            input.inputId,
            "partner_selection_required",
            "自动纠正后仍无法确定可用搭档。请选择一个搭档继续原任务。",
          );
          return result({ reasonCode: "partner_selection_required", status: "CLARIFICATION_REQUIRED" }, true);
        }
        return result({ reasonCode, status: "FAILED" }, true);
      }
    },
    label: "Plan and dispatch work",
    name: "work_dispatch",
    parameters: workDispatchParameters,
  };
  const workSupplementParameters = Type.Object({
    acceptanceChecks: Type.Optional(Type.Array(Type.Union([
      Type.Object({ kind: Type.Literal("BODY_PRESENT") }),
      Type.Object({ kind: Type.Literal("ARTIFACT_PRESENT"), name: Type.String({ maxLength: 240, minLength: 1 }) }),
      Type.Object({ expectedText: Type.String({ maxLength: 8_000 }), kind: Type.Literal("FILE_CONTAINS_EXACT"), relativePath: Type.String({ maxLength: 500, minLength: 1 }) }),
      Type.Object({ kind: Type.Literal("FILE_EXISTS"), relativePath: Type.String({ maxLength: 500, minLength: 1 }) }),
    ]), { maxItems: 8 })),
    accessMode: Type.Union([Type.Literal("NONE"), Type.Literal("READ"), Type.Literal("WRITE")]),
    instructions: Type.Optional(Type.String({ maxLength: 12_000 })),
    partnerId: Type.String(),
    sourceWorkId: Type.String(),
    strategy: Type.Optional(Type.Union([Type.Literal("SUPPLEMENT"), Type.Literal("TOOL_EXPANSION")])),
    title: Type.String({ maxLength: 240, minLength: 1 }),
  });
  const workSupplementTool: AgentTool<typeof workSupplementParameters> = {
    description: "Create one independent recovery Work for an essential gap left by a FAILED Work. The source Work's acceptance checks and access mode are enforced automatically as a minimum; acceptanceChecks here are additive only and cannot weaken the original deliverable. Completed authoritative results from the same goal are attached as evidence references. Do not pass historical DAG keys. Each source Work is limited durably to two recovery rounds. For OBSERVED or UNKNOWN side effects, use this instead of replaying the failed Work; for a missing built-in tool, call partner_set_tools first and choose TOOL_EXPANSION.",
    execute: async (_toolCallId, arguments_) => result(await input.work.supplement({
      ...(arguments_.acceptanceChecks === undefined ? {} : { acceptanceChecks: arguments_.acceptanceChecks }),
      accessMode: arguments_.accessMode,
      ...(arguments_.instructions === undefined ? {} : { instructions: arguments_.instructions }),
      partnerId: arguments_.partnerId,
      sourceWorkId: arguments_.sourceWorkId,
      ...(arguments_.strategy === undefined ? {} : { strategy: arguments_.strategy }),
      title: arguments_.title,
      turnId: input.turnId,
      workbenchId: input.workbenchId,
    }), true),
    label: "Supplement failed work",
    name: "work_supplement",
    parameters: workSupplementParameters,
  };
  const workReassignParameters = Type.Object({ partnerId: Type.String(), workId: Type.String() });
  const workReassignTool: AgentTool<typeof workReassignParameters> = {
    description: "Reassign failed work through policy checks to a different suitable partner or a new immutable revision of the current partner.",
    execute: async (_toolCallId, arguments_) => result(await input.work.reassign({
      workbenchId: input.workbenchId,
      partnerId: arguments_.partnerId,
      turnId: input.turnId,
      workId: arguments_.workId,
    })),
    label: "Reassign work",
    name: "work_reassign",
    parameters: workReassignParameters,
  };
  const workResumeParameters = Type.Object({ workId: Type.String() });
  const workResumeTool: AgentTool<typeof workResumeParameters> = {
    description: "Resume a Work that paused with WAITING_INPUT once the user has answered its blocking question. Dispatches a fresh attempt on the same partner revision and continues the original instance when it is still alive; the user's answer is already part of the goal request text. Use this instead of work_reassign, which exists to change the partner revision after a failure.",
    execute: async (_toolCallId, arguments_) => result(await input.work.resume({
      workbenchId: input.workbenchId,
      turnId: input.turnId,
      workId: arguments_.workId,
    })),
    label: "Resume waiting work",
    name: "work_resume",
    parameters: workResumeParameters,
  };
  const workCancelParameters = Type.Object({ workId: Type.String() });
  const workCancelTool: AgentTool<typeof workCancelParameters> = {
    description: "Cancel planned, ready, waiting or failed Work, for example waiting Work whose question the user declined to answer. A running attempt finishes on its own and arrives late. Canceled Work never dispatches again.",
    execute: async (_toolCallId, arguments_) => result(await input.work.cancel({
      workbenchId: input.workbenchId,
      workId: arguments_.workId,
    })),
    label: "Cancel work",
    name: "work_cancel",
    parameters: workCancelParameters,
  };
  const archiveParameters = Type.Object({ workbenchId: Type.String(), reason: Type.String() });
  const suggestArchive: AgentTool<typeof archiveParameters> = {
    description: "Create a pending Workbench archive request. This never archives until the user confirms it.",
    execute: async (_toolCallId, arguments_) => result(await input.workbenchChanges.suggestArchive({
      workbenchId: arguments_.workbenchId, reason: arguments_.reason, turnId: input.turnId,
    })),
    label: "Suggest Workbench archive",
    name: "workbench_suggest_archive",
    parameters: archiveParameters,
  };
  const mergeParameters = Type.Object({ reason: Type.String(), sourceWorkbenchId: Type.String(), targetWorkbenchId: Type.String() });
  const suggestMerge: AgentTool<typeof mergeParameters> = {
    description: "Create a pending Workbench merge request. Source facts remain intact and nothing changes until the user confirms it.",
    execute: async (_toolCallId, arguments_) => result(await input.workbenchChanges.suggestMerge({
      reason: arguments_.reason,
      sourceWorkbenchId: arguments_.sourceWorkbenchId,
      targetWorkbenchId: arguments_.targetWorkbenchId,
      turnId: input.turnId,
    })),
    label: "Suggest Workbench merge",
    name: "workbench_suggest_merge",
    parameters: mergeParameters,
  };
  const partnerSkillListParameters = Type.Object({
    engine: Type.Optional(Type.Union([Type.Literal("claude-code"), Type.Literal("codex"), Type.Literal("pi-core")])),
  });
  const partnerListSkillsTool: AgentTool<typeof partnerSkillListParameters> = {
    description: "List locally installed skills available to a partner engine. Joi cannot execute these skills; use the returned ids when creating or configuring a local partner.",
    execute: (_toolCallId, arguments_) => Promise.resolve().then(() => {
      const engine = arguments_.engine ?? "pi-core";
      return result({
        engine,
        items: input.skills.listForEngine(engine).map(({ description, displayName, id }) => ({
          ...(description === undefined ? {} : { description }),
          displayName,
          id,
        })),
      });
    }),
    label: "List partner skills",
    name: "partner_list_skills",
    parameters: partnerSkillListParameters,
  };
  const partnerSetSkillsParameters = Type.Object({
    partnerId: Type.String(),
    skills: Type.Array(Type.String(), { maxItems: 64, uniqueItems: true }),
  });
  const partnerSetSkillsTool: AgentTool<typeof partnerSetSkillsParameters> = {
    description: "Attach or clear locally installed skills on an existing local partner. First call partner_list_skills for the partner engine; passing an unavailable id fails closed. This only configures the partner, it does not execute a skill in Joi.",
    execute: async (_toolCallId, arguments_) => {
      const partner = await input.partners.inspect(arguments_.partnerId);
      if (partner.kind !== "local-pi") throw new DomainError("partner_skills_not_supported", "Only local partners can use local skills.");
      const available = new Set(input.skills.listForEngine(partner.engine).map((item) => item.id));
      if (arguments_.skills.some((skill) => !available.has(skill))) {
        throw new DomainError("partner_skill_not_available", "Selected partner skill is not available for this engine.");
      }
      return result(await input.partners.setSkills(arguments_.partnerId, arguments_.skills));
    },
    label: "Set partner skills",
    name: "partner_set_skills",
    parameters: partnerSetSkillsParameters,
  };
  const partnerSetToolsParameters = Type.Object({
    partnerId: Type.String(),
    tools: Type.Array(Type.String({ enum: [...PI_PARTNER_TOOL_NAMES] }), {
      maxItems: PI_PARTNER_TOOL_NAMES.length,
      uniqueItems: true,
    }),
  });
  const partnerSetToolsTool: AgentTool<typeof partnerSetToolsParameters> = {
    description: "Create a new immutable revision of a local Pi partner with a bounded built-in tool grant. Pass [] to grant every built-in coding and public-web tool. This never grants credentials, cookies, private-network access or paths outside the Workbench.",
    execute: async (_toolCallId, arguments_) => result(await input.partners.setTools(
      arguments_.partnerId,
      normalizePartnerTools(arguments_.tools),
    )),
    label: "Set partner tools",
    name: "partner_set_tools",
    parameters: partnerSetToolsParameters,
  };
  const partnerSetModelParameters = Type.Object({
    modelId: Type.String({ maxLength: 240, minLength: 1 }),
    partnerId: Type.String(),
    sourceId: Type.String({ maxLength: 240, minLength: 1 }),
  });
  const partnerSetModelTool: AgentTool<typeof partnerSetModelParameters> = {
    description: "Create a new immutable revision of an existing local partner pinned to a READY model source. Use only after a safely classified retryable failure with sideEffectState NONE, then call work_reassign so the same Work gets a new action and dispatch attempt.",
    execute: async (_toolCallId, arguments_) => {
      const source = (await input.models.list()).find((candidate) => candidate.sourceId === arguments_.sourceId && candidate.status === "READY");
      if (source?.activeModel.id !== arguments_.modelId) {
        throw new DomainError("partner_model_source_not_ready", "The selected model source and active model are not ready.");
      }
      return result(await input.partners.setModel(arguments_.partnerId, {
        modelIdOverride: arguments_.modelId,
        modelSourceId: arguments_.sourceId,
      }));
    },
    label: "Switch partner model",
    name: "partner_set_model",
    parameters: partnerSetModelParameters,
  };
  const partnerCreateParameters = Type.Object({
    capabilities: Type.Optional(Type.Array(Type.String())),
    description: Type.String({ description: "One-line role summary shown on the partner card; say what the partner is for, in the user's language." }),
    displayName: Type.String(),
    modelIdOverride: Type.Optional(Type.String()),
    modelSourceId: Type.Optional(Type.String()),
    prompt: Type.String({ description: "Working directive for the partner: role, DO, acceptance criteria, out-of-scope; concrete to the current work." }),
    skills: Type.Optional(Type.Array(Type.String())),
    tools: Type.Optional(Type.Array(Type.String({ enum: [...PI_PARTNER_TOOL_NAMES] }), {
      maxItems: PI_PARTNER_TOOL_NAMES.length,
      uniqueItems: true,
    })),
  });
  const partnerCreateTool: AgentTool<typeof partnerCreateParameters> = {
    description: "Register a new local Pi capability cluster when no existing partner fits the work. Name the card after a reusable work cluster, not a person or narrow role: use names like 编码工坊 instead of 资深程序员搭档. Never name a partner after a one-off task, model or version (bad: Grok4.6 模型调研搭档); name the durable capability cluster (good: 模型调研搭档) so the next similar goal reuses it. Keep description focused on the capability boundary; keep environment, workspace and directory decisions in the Workbench. Reuses an active local partner whose normalized cluster key matches — one-off model/version tokens and quoted or parenthetical notes are ignored when matching. Always write description (card-visible one-line role summary) and prompt (working directive with DO / acceptance criteria / out-of-scope) for the concrete work. Call partner_list_skills before passing skills; selected ids are injected into the partner, not executed by joi. tools accepts built-in coding and public web tools: bash, edit, find, grep, ls, read, write, web_search, fetch_content and get_search_content; omit it or pass [] to grant all built-in Pi tools. Web access is read-only and bounded; it never receives cookies or credentials. Optionally pin a READY model source (modelSourceId from model_list_sources, with modelIdOverride for its model id); omit both to follow the global preferred source. The user sees the new partner card (badged as joi-created) and can edit, disable or delete it.",
    execute: async (_toolCallId, arguments_) => {
      const displayName = partnerClusterName(arguments_.displayName);
      const tools = normalizePartnerTools(arguments_.tools);
      const nameKey = partnerClusterKey(displayName);
      const existing = (await input.partners.list()).find((partner) =>
        partner.engine === "pi-core"
        && partner.kind === "local-pi"
        && partner.status === "ACTIVE"
        && partner.configuration === undefined
        && partnerClusterKey(partner.displayName) === nameKey
      );
      if (existing !== undefined) {
        return result({ partnerId: existing.partnerId, partnerRevisionId: existing.partnerRevisionId, reused: true });
      }
      const profile = synthesizePartnerProfile(displayName, arguments_.skills ?? [], arguments_.capabilities ?? []);
      const created = await input.partners.add({
        capabilities: arguments_.capabilities ?? [],
        createdBy: "joi",
        description: nonBlank(arguments_.description) ?? profile.description,
        displayName,
        kind: "local-pi",
        ...(arguments_.modelIdOverride === undefined ? {} : { modelIdOverride: arguments_.modelIdOverride }),
        ...(arguments_.modelSourceId === undefined ? {} : { modelSourceId: arguments_.modelSourceId }),
        prompt: nonBlank(arguments_.prompt) ?? profile.prompt,
        skills: arguments_.skills ?? [],
        tools,
      });
      return result({ partnerId: created.partnerId, partnerRevisionId: created.partnerRevisionId });
    },
    label: "Create a partner",
    name: "partner_create",
    parameters: partnerCreateParameters,
  };
  const createInstanceParameters = Type.Object({
    partnerId: Type.String(),
    sessionPolicy: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("resident")])),
  });
  const createInstanceTool: AgentTool<typeof createInstanceParameters> = {
    description: "Create an instance of a partner. resident keeps the conversation alive across dispatches (bounded by instance caps); ephemeral is disposed after one turn. Prefer reusing an IDLE instance from partner_list_instances.",
    execute: async (_toolCallId, arguments_) => result(await input.instances.ensure({
      workbenchId: input.workbenchId,
      partnerId: arguments_.partnerId,
      ...(arguments_.sessionPolicy === undefined ? {} : { sessionPolicy: arguments_.sessionPolicy === "resident" ? "RESIDENT" as const : "EPHEMERAL" as const }),
    })),
    label: "Create a partner instance",
    name: "partner_create_instance",
    parameters: createInstanceParameters,
  };
  const listInstancesParameters = Type.Object({ partnerId: Type.Optional(Type.String()) });
  const listInstancesTool: AgentTool<typeof listInstancesParameters> = {
    description: "List live partner instances with status, session policy and last use, so follow-up work can reuse the right conversation.",
    execute: async (_toolCallId, arguments_) => result(await input.instances.list({
      workbenchId: input.workbenchId,
      ...(arguments_.partnerId === undefined ? {} : { partnerId: arguments_.partnerId }),
    })),
    label: "List partner instances",
    name: "partner_list_instances",
    parameters: listInstancesParameters,
  };
  const disposeInstanceParameters = Type.Object({ instanceId: Type.String(), reason: Type.Optional(Type.String()) });
  const disposeInstanceTool: AgentTool<typeof disposeInstanceParameters> = {
    description: "Dispose a partner instance once its goal is complete. Busy instances cannot be disposed.",
    execute: async (_toolCallId, arguments_) => {
      await input.instances.dispose({
        workbenchId: input.workbenchId,
        instanceId: arguments_.instanceId,
        reason: arguments_.reason ?? "joi disposed the instance",
      });
      return result({ disposed: true, instanceId: arguments_.instanceId });
    },
    label: "Dispose a partner instance",
    name: "partner_dispose_instance",
    parameters: disposeInstanceParameters,
  };
  const inspectRevisionParameters = Type.Object({ partnerId: Type.String() });
  const inspectRevisionTool: AgentTool<typeof inspectRevisionParameters> = {
    description: "Inspect one partner's active revision (description, engine, capabilities, knowledge count and tool count). Never returns tool lists, prompt bodies or workspace paths.",
    execute: async (_toolCallId, arguments_) => {
      const { tools, ...partner } = await input.partners.inspect(arguments_.partnerId);
      return result({ ...partner, toolCount: tools.length });
    },
    label: "Inspect partner revision",
    name: "partner_inspect_revision",
    parameters: inspectRevisionParameters,
  };
  const readResultParameters = Type.Object({ cursor: Type.Optional(Type.String()), resultId: Type.String() });
  const readResultTool: AgentTool<typeof readResultParameters> = {
    description: "Read one bounded chunk of a persisted work result belonging to the current Workbench. The first chunk also reports the acceptance verification verdict (PASSED, FAILED with a reason, or NOT_REQUIRED). Use nextCursor to continue.",
    execute: async (_toolCallId, arguments_) => result(await input.results.read({
      workbenchId: input.workbenchId,
      ...(arguments_.cursor === undefined ? {} : { cursor: arguments_.cursor }),
      resultId: arguments_.resultId,
    })),
    label: "Read work result",
    name: "work_read_result",
    parameters: readResultParameters,
  };
  const userAskParameters = Type.Object({ question: Type.String() });
  const userAskTool: AgentTool<typeof userAskParameters> = {
    description: "Persist one concrete blocking question for the user. Call this only when their judgement or missing information is required, then stop planning until they answer the card.",
    execute: async (_toolCallId, arguments_) => {
      const question = arguments_.question.trim();
      if (question.length === 0 || question.length > 1_000) {
        throw new DomainError("joi_clarification_question_invalid", "The clarification question is invalid.");
      }
      await input.clarifications.requireClarification(input.inputId, "question_required", question);
      return result({ reasonCode: "question_required", status: "CLARIFICATION_REQUIRED" });
    },
    label: "Ask the user",
    name: "user_ask",
    parameters: userAskParameters,
  };
  const turnCompleteParameters = Type.Object({
    outcome: Type.Union([
      Type.Literal("DIRECT_ANSWER"),
      Type.Literal("TEAM_READY"),
      Type.Literal("RESULT_SYNTHESIZED"),
      Type.Literal("RESULT_CONTINUE"),
      Type.Literal("RESULT_BLOCKED"),
      Type.Literal("MAP_CLEARED"),
    ]),
  });
  const turnCompleteTool: AgentTool<typeof turnCompleteParameters> = {
    description: "Commit a tool-using Turn. DIRECT_ANSWER is only for requests needing no execution; TEAM_READY is only for a completed team-building request; RESULT_SYNTHESIZED means persisted results contain enough verified evidence to answer the original goal; RESULT_CONTINUE means evidence is incomplete but the next safe evidence layer is concrete and needs no user decision, credential or broader permission; RESULT_BLOCKED means a critical evidence gap remains and no safe automatic next step exists; MAP_CLEARED is only when the goal's destination is reached and no way remains (never while open paths exist). This tool never executes work.",
    execute: async (_toolCallId, arguments_) => {
      if ((arguments_.outcome === "RESULT_SYNTHESIZED" || arguments_.outcome === "RESULT_CONTINUE" || arguments_.outcome === "RESULT_BLOCKED")
        && (input.goalInputId === undefined || !input.inputId.startsWith("joi_result_input:goal:"))) {
        throw new DomainError("goal_synthesis_outcome_not_allowed", "Result dispositions are only allowed in a goal synthesis Turn.");
      }
      if (arguments_.outcome === "MAP_CLEARED") {
        const harness = requireHarness();
        // Only a harness review turn may declare the way complete; other turns would
        // clear maps mid-flight. Trivial goals are cleared by the traversal instead.
        if (input.goalInputId === undefined || !input.inputId.startsWith("joi_harness_review:goal:")) {
          throw new DomainError("harness_clear_not_allowed", "Only a harness review turn can clear the goal map.");
        }
        const cleared = await harness.clearMap({ goalInputId: input.goalInputId, turnId: input.turnId });
        if (!cleared) {
          throw new DomainError("harness_clear_preconditions_unmet", "The goal map cannot be cleared until its review and execution facts are complete.");
        }
        return result({ cleared, outcome: arguments_.outcome, status: "COMMITTED" });
      }
      return result({ outcome: arguments_.outcome, status: "COMMITTED" });
    },
    label: "Complete this Turn",
    name: "turn_complete",
    parameters: turnCompleteParameters,
  };
  const harnessDestinationParameters = Type.Object({
    destination: Type.String({ maxLength: 240, minLength: 1 }),
  });
  const harnessNameDestinationTool: AgentTool<typeof harnessDestinationParameters> = {
    description: "Name (or rename) the destination of the current goal map — the final state this goal is finding its way to. Every path and decision points at it; keep it fixed once named unless the goal itself changes.",
    execute: async (_toolCallId, arguments_) => result(await requireHarness().nameDestination({
      destination: arguments_.destination,
      goalInputId: goalContext(),
      turnId: input.turnId,
    })),
    label: "Name the goal destination",
    name: "harness_name_destination",
    parameters: harnessDestinationParameters,
  };
  const harnessChartPathParameters = Type.Object({
    close: Type.Optional(Type.Object({
      pathId: Type.String(),
      status: Type.Union([Type.Literal("CLOSED"), Type.Literal("OUT_OF_SCOPE")]),
    })),
    open: Type.Optional(Type.Object({
      layer: Type.Integer({ maximum: 32, minimum: 1 }),
      title: Type.String({ maxLength: 160, minLength: 1 }),
      workId: Type.Optional(Type.String()),
    })),
  });
  const harnessChartPathTool: AgentTool<typeof harnessChartPathParameters> = {
    description: "Chart one path on the goal map. Pass open to add the next layer's path (layer counts up from the completed layer; link a dispatched work by workId once created); pass close to mark an open path CLOSED (resolved) or OUT_OF_SCOPE (beyond the destination). Pass exactly one mode.",
    execute: async (_toolCallId, arguments_) => {
      const harness = requireHarness();
      if (arguments_.close === undefined && arguments_.open === undefined) {
        throw new DomainError("harness_path_invalid", "Pass exactly one of open or close.");
      }
      if (arguments_.close !== undefined && arguments_.open !== undefined) {
        throw new DomainError("harness_path_invalid", "Pass exactly one of open or close.");
      }
      return result(await harness.chartPath({
        ...(arguments_.close === undefined ? {} : { close: arguments_.close }),
        goalInputId: goalContext(),
        ...(arguments_.open === undefined ? {} : { open: arguments_.open }),
        turnId: input.turnId,
      }));
    },
    label: "Chart a goal path",
    name: "harness_chart_path",
    parameters: harnessChartPathParameters,
  };
  const harnessDecisionParameters = Type.Object({
    closePathId: Type.Optional(Type.String()),
    detail: Type.Optional(Type.String({ maxLength: 4_000 })),
    kind: Type.Optional(Type.Union([
      Type.Literal("APPROACH"),
      Type.Literal("SCOPE"),
      Type.Literal("OUT_OF_SCOPE"),
      Type.Literal("WORKBENCH_REFINE"),
    ])),
    summary: Type.String({ maxLength: 240, minLength: 1 }),
  });
  const harnessRecordDecisionTool: AgentTool<typeof harnessDecisionParameters> = {
    description: "Record one resolution on the goal map (Decisions so far): a one-line summary of what was decided; optional detail stays in the decision row, never in the map index. OUT_OF_SCOPE records work consciously ruled beyond the destination. Pass closePathId to close the path the decision resolves. Resolve at most one decision per review turn.",
    execute: async (_toolCallId, arguments_) => result(await requireHarness().recordDecision({
      ...(arguments_.closePathId === undefined ? {} : { closePathId: arguments_.closePathId }),
      ...(arguments_.detail === undefined ? {} : { detail: arguments_.detail }),
      goalInputId: goalContext(),
      kind: arguments_.kind ?? "APPROACH",
      summary: arguments_.summary,
      turnId: input.turnId,
    })),
    label: "Record a goal decision",
    name: "harness_record_decision",
    parameters: harnessDecisionParameters,
  };
  const harnessFogParameters = Type.Object({
    graduate: Type.Optional(Type.Object({
      fogId: Type.String(),
      graduateLayer: Type.Optional(Type.Integer({ maximum: 32, minimum: 1 })),
      graduateTitle: Type.String({ maxLength: 160, minLength: 1 }),
      graduateWorkId: Type.Optional(Type.String()),
    })),
    note: Type.Optional(Type.String({ maxLength: 480, minLength: 1 })),
  });
  const harnessNoteFogTool: AgentTool<typeof harnessFogParameters> = {
    description: "Manage the goal's fog of war — questions you can see coming but cannot yet ticket. Pass note to park a known-but-unsharp question; pass graduate to promote a fog note into a new open path now that it is specifiable. Pass exactly one mode.",
    execute: async (_toolCallId, arguments_) => {
      const harness = requireHarness();
      const hasNote = arguments_.note !== undefined;
      const hasGraduate = arguments_.graduate !== undefined;
      if (hasNote === hasGraduate) {
        throw new DomainError("harness_fog_invalid", "Pass exactly one of note or graduate.");
      }
      if (arguments_.note !== undefined) {
        return result(await harness.noteFog({ goalInputId: goalContext(), note: arguments_.note, turnId: input.turnId }));
      }
      const graduate = arguments_.graduate;
      if (graduate === undefined) throw new DomainError("harness_fog_invalid", "Fog action is missing.");
      return result(await harness.graduateFog({
        fogId: graduate.fogId,
        goalInputId: goalContext(),
        layer: graduate.graduateLayer ?? 1,
        title: graduate.graduateTitle,
        turnId: input.turnId,
        ...(graduate.graduateWorkId === undefined ? {} : { workId: graduate.graduateWorkId }),
      }));
    },
    label: "Note or graduate fog",
    name: "harness_note_fog",
    parameters: harnessFogParameters,
  };
  const harnessRefineParameters = Type.Object({
    persona: Type.Optional(Type.String({ maxLength: 4_000, minLength: 1 })),
    reason: Type.String({ maxLength: 240, minLength: 1 }),
    scopeSummary: Type.Optional(Type.String({ maxLength: 1_000, minLength: 1 })),
  });
  const harnessRefineWorkbenchTool: AgentTool<typeof harnessRefineParameters> = {
    description: "Refine the current workbench's parameters from what completing this goal revealed: narrow its scope summary or sharpen its persona. Never broaden scope, never change name or project label, and always give the reason; the refinement is recorded as a WORKBENCH_REFINE decision.",
    execute: async (_toolCallId, arguments_) => {
      if (input.workbenchRefine === undefined) {
        throw new DomainError("harness_refine_invalid", "Workbench refinement is not configured.");
      }
      if (arguments_.persona === undefined && arguments_.scopeSummary === undefined) {
        throw new DomainError("harness_refine_invalid", "Pass at least one of scopeSummary or persona.");
      }
      await input.workbenchRefine.update(input.workbenchId, {
        ...(arguments_.persona === undefined ? {} : { persona: arguments_.persona }),
        ...(arguments_.scopeSummary === undefined ? {} : { responsibility: arguments_.scopeSummary }),
      });
      const decision = await requireHarness().recordDecision({
        goalInputId: goalContext(),
        kind: "WORKBENCH_REFINE",
        summary: arguments_.reason,
        turnId: input.turnId,
      });
      return result({ workbenchId: input.workbenchId, decisionId: decision.decisionId, refined: true });
    },
    label: "Refine Workbench parameters",
    name: "harness_refine_workbench",
    parameters: harnessRefineParameters,
  };
  const bindWorkspaceParameters = Type.Object({
    workspacePath: Type.Optional(Type.String({ maxLength: 4_000, minLength: 1 })),
  });
  const bindWorkspaceTool: AgentTool<typeof bindWorkspaceParameters> = {
    description: "Bind the current Workbench to an explicit absolute directory from the user's request when local file work needs one. Copy the path exactly; never invent or broaden it. When the user did not provide an absolute directory, omit workspacePath so joi can persist a clarification and the user can choose it on the card. The bound path is never returned to the user.",
    execute: async (_toolCallId, arguments_) => {
      const workspacePath = nonBlank(arguments_.workspacePath);
      if (workspacePath !== undefined) {
        if (!isAbsoluteWorkspacePath(workspacePath)) throw new DomainError("workbench_workspace_path_invalid", "An explicit absolute workspace directory is required.");
        const workspace = await input.workbenchWorkspaces.bindExisting(input.workbenchId, workspacePath);
        return result({ displayName: workspace.displayName, kind: workspace.kind, status: workspace.status });
      }
      await input.clarifications.requireClarification(
        goalContext(),
        "workbench_workspace_not_ready",
        "这个工作需要读写文件。请先从 joi 卡片选择当前 Workbench 的工作目录，确认后我再继续派发。",
      );
      return result({ reasonCode: "workbench_workspace_not_ready", status: "CLARIFICATION_REQUIRED" }, true);
    },
    label: "Bind Workbench workspace",
    name: "workbench_bind_workspace",
    parameters: bindWorkspaceParameters,
  };
  const scopedAttachmentIds = new Set(input.attachmentIds ?? []);
  const attachmentTextCache = new Map<string, { filename: string; mimeType: string; text: string } | "NOT_TEXT">();
  const loadAttachmentText = async (attachmentId: string): Promise<{ filename: string; mimeType: string; text: string } | "NOT_TEXT"> => {
    const cached = attachmentTextCache.get(attachmentId);
    if (cached !== undefined) return cached;
    // Out-of-scope ids report the same code as missing rows so other inputs' ids stay unenumerable.
    if (input.attachments === undefined || !scopedAttachmentIds.has(attachmentId)) {
      throw new DomainError("joi_attachment_not_found", "A referenced joi attachment is unavailable.");
    }
    const attachment = await input.attachments.read(attachmentId);
    let text: string | null;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(attachment.bytes);
      text = decoded.includes("\u0000") ? null : decoded;
    } catch {
      text = null;
    }
    const loaded = text === null ? "NOT_TEXT" as const : { filename: attachment.filename, mimeType: attachment.mimeType, text };
    attachmentTextCache.set(attachmentId, loaded);
    return loaded;
  };
  const attachmentReadParameters = Type.Object({ attachmentId: Type.String(), cursor: Type.Optional(Type.String()) });
  const attachmentReadTool: AgentTool<typeof attachmentReadParameters> = {
    description: "Read one bounded chunk of the UTF-8 text content of an attachment bound to the current input. Use nextCursor to continue reading. Binary or undecodable attachments return NOT_TEXT.",
    execute: async (_toolCallId, arguments_) => {
      if (arguments_.cursor !== undefined && !/^(?:0|[1-9]\d*)$/u.test(arguments_.cursor)) {
        throw new DomainError("attachment_cursor_invalid", "Attachment cursor is invalid.");
      }
      const offset = arguments_.cursor === undefined ? 0 : Number(arguments_.cursor);
      const loaded = await loadAttachmentText(arguments_.attachmentId);
      if (loaded === "NOT_TEXT") return result({ attachmentId: arguments_.attachmentId, reasonCode: "attachment_content_not_text", status: "NOT_TEXT" });
      const chunk = loaded.text.slice(offset, offset + ATTACHMENT_CHUNK_CHARS);
      const next = offset + chunk.length;
      return result({
        attachmentId: arguments_.attachmentId,
        content: chunk,
        filename: loaded.filename,
        mimeType: loaded.mimeType,
        ...(next < loaded.text.length ? { nextCursor: String(next) } : {}),
      });
    },
    label: "Read attachment content",
    name: "attachment_read",
    parameters: attachmentReadParameters,
  };
  const attachmentTools = input.attachmentIds === undefined || input.attachmentIds.length === 0 || input.attachments === undefined
    ? []
    : [attachmentReadTool];
  return [
    ...automationTools,
    ...attachmentTools,
    {
      description: "List redacted Workbench summaries. Does not return persona, memory, or workspace paths.",
      execute: async () => result(await input.workbenches.listSummaries()),
      label: "List Workbench summaries",
      name: "workbench_list_summaries",
      parameters: Type.Object({}),
    },
    {
      description: "List READY model network sources assignable to a new partner. Pass a chosen sourceId as modelSourceId to partner_create (optionally modelIdOverride for its model id); omit to follow the global preferred source.",
      execute: async () => result((await input.models.list())
        .filter((source) => source.status === "READY")
        .map((source) => ({ displayName: source.displayName, kind: source.kind, modelId: source.activeModel.id, primary: source.primary, protocol: source.protocol, sourceId: source.sourceId }))),
      label: "List ready model sources",
      name: "model_list_sources",
      parameters: Type.Object({}),
    },
    suggestMerge,
    suggestArchive,
    partnerListSkillsTool,
    partnerSetSkillsTool,
    partnerSetToolsTool,
    partnerSetModelTool,
    {
      description: "List active partners with public metadata, live instances and a working-memory digest (recent outcomes, success rate). Use the digest to pick and the instance list to reuse.",
      execute: async () => {
        const [partners, instances] = await Promise.all([input.partners.list(), input.instances.list({ workbenchId: input.workbenchId })]);
        const enriched = await Promise.all(partners.map(async (dto) => {
          const { tools, ...partner } = dto;
          return {
            ...partner,
            activeInstanceCount: instances.filter((instance) => instance.partnerId === dto.partnerId).length,
            instances: instances
              .filter((instance) => instance.partnerId === dto.partnerId)
              .map((instance) => ({ instanceId: instance.instanceId, lastUsedAt: instance.lastUsedAt, sessionPolicy: instance.sessionPolicy, status: instance.status })),
            memoryDigest: await input.memory.digest(input.workbenchId, dto.partnerId),
            toolCount: tools.length,
          };
        }));
        return result(enriched);
      },
      label: "List available partners",
      name: "partner_list_available",
      parameters: Type.Object({}),
    },
    inspectRevisionTool,
    partnerCreateTool,
    createInstanceTool,
    listInstancesTool,
    disposeInstanceTool,
    workDispatchTool,
    workSupplementTool,
    workReassignTool,
    workResumeTool,
    workCancelTool,
    readResultTool,
    userAskTool,
    turnCompleteTool,
    harnessNameDestinationTool,
    harnessChartPathTool,
    harnessRecordDecisionTool,
    harnessNoteFogTool,
    harnessRefineWorkbenchTool,
    bindWorkspaceTool,
  ];
}
