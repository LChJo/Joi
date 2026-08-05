import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { PartnerInstanceManager } from "../../application/partners/partner-instance-manager.js";
import type { PartnerRegistryService } from "../../application/partners/partner-registry-service.js";
import type { PartnerWorkMemoryService } from "../../application/partners/partner-work-memory-service.js";
import type { WorkOrchestrationService } from "../../application/work/work-orchestration-service.js";
import type { ModelSourceService } from "../../application/model-sources/model-source-service.js";
import type { AvatarCatalog } from "../../application/ports/avatar-context.js";
import type { AvatarChangeService } from "../../application/joi/avatar-change-service.js";
import type { WorkResultService } from "../../application/work/work-result-service.js";
import type { JoiCoordinatorStore } from "../../application/ports/joi-coordinator.js";
import { DomainError } from "../../domain/errors.js";
import { PI_CODING_TOOL_NAMES } from "./pi-coding-tool-factory.js";

const PI_CODING_TOOL_NAME_SET = new Set<string>(PI_CODING_TOOL_NAMES);

function result(value: unknown) {
  return { content: [{ text: JSON.stringify(value), type: "text" as const }], details: {} };
}

function normalizeCodingTools(values: string[] | undefined): string[] {
  if (values === undefined) return [];
  if (values.length > PI_CODING_TOOL_NAMES.length) {
    throw new DomainError("partner_tools_invalid", "Too many coding tools were requested.");
  }
  const normalized = [...new Set(values.map((value) => value.trim()))];
  if (normalized.some((value) => !PI_CODING_TOOL_NAME_SET.has(value))) {
    throw new DomainError("partner_tool_not_allowed", "The requested coding tool is not available.");
  }
  return normalized;
}

const SYNTHESIS_TOOL_NAMES = new Set(["turn_complete", "work_read_result"]);

export function selectJoiReasoningToolsForInput(tools: AgentTool[], inputId: string): AgentTool[] {
  if (!inputId.startsWith("joi_result_input:goal:")) return tools;
  return tools.filter((tool) => SYNTHESIS_TOOL_NAMES.has(tool.name));
}

export function createJoiReasoningTools(input: {
  avatarId: string;
  avatarChanges: Pick<AvatarChangeService, "suggestArchive" | "suggestMerge">;
  avatars: AvatarCatalog;
  clarifications: Pick<JoiCoordinatorStore, "requireClarification">;
  inputId: string;
  instances: Pick<PartnerInstanceManager, "dispose" | "ensure" | "list">;
  memory: Pick<PartnerWorkMemoryService, "digest">;
  models: Pick<ModelSourceService, "list">;
  partners: Pick<PartnerRegistryService, "add" | "inspect" | "list">;
  results: Pick<WorkResultService, "read">;
  turnId: string;
  work: Pick<WorkOrchestrationService, "plan" | "reassign">;
}): AgentTool[] {
  const workDispatchParameters = Type.Object({
    dependencies: Type.Array(Type.Object({ dependsOnKey: Type.String(), workKey: Type.String() })),
    work: Type.Array(Type.Object({
      acceptanceChecks: Type.Optional(Type.Array(Type.Union([
        Type.Object({ kind: Type.Literal("ARTIFACT_PRESENT"), name: Type.String({ maxLength: 240, minLength: 1 }) }),
        Type.Object({
          expectedText: Type.String({ maxLength: 8_000 }), kind: Type.Literal("FILE_CONTAINS_EXACT"),
          relativePath: Type.String({ maxLength: 500, minLength: 1 }),
        }),
        Type.Object({ kind: Type.Literal("FILE_EXISTS"), relativePath: Type.String({ maxLength: 500, minLength: 1 }) }),
      ]), { maxItems: 8 })),
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
    description: "Persist a checked work DAG and queue each allowed partner dispatch through the outbox. Pass instanceId to reuse an existing partner instance, or sessionPolicy resident to continue a conversation; omit both for one-shot ephemeral work.",
    execute: async (_toolCallId, arguments_) => {
      try {
        return result(await input.work.plan({
          avatarId: input.avatarId,
          dependencies: arguments_.dependencies,
          inputId: input.inputId,
          turnId: input.turnId,
          work: arguments_.work.map((item) => ({
            ...(item.acceptanceChecks === undefined ? {} : { acceptanceChecks: item.acceptanceChecks }),
            accessMode: item.accessMode,
            ...(item.instanceId === undefined ? {} : { instanceId: item.instanceId }),
            key: item.key,
            ...(item.instructions === undefined ? {} : { instructions: item.instructions }),
            partnerId: item.partnerId,
            ...(item.sessionPolicy === undefined ? {} : { sessionPolicy: item.sessionPolicy === "resident" ? "RESIDENT" as const : "EPHEMERAL" as const }),
            title: item.title,
          })),
        }));
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "avatar_workspace_not_ready") throw error;
        await input.clarifications.requireClarification(
          input.inputId,
          "avatar_workspace_not_ready",
          "选择这个 Avatar 的工作目录后，我会继续派发需要读写文件的工作。",
        );
        return result({ reasonCode: "avatar_workspace_not_ready", status: "CLARIFICATION_REQUIRED" });
      }
    },
    label: "Plan and dispatch work",
    name: "work_dispatch",
    parameters: workDispatchParameters,
  };
  const workReassignParameters = Type.Object({ partnerId: Type.String(), workId: Type.String() });
  const workReassignTool: AgentTool<typeof workReassignParameters> = {
    description: "Reassign failed or waiting work through policy checks and a new immutable partner revision.",
    execute: async (_toolCallId, arguments_) => result(await input.work.reassign({
      avatarId: input.avatarId,
      partnerId: arguments_.partnerId,
      turnId: input.turnId,
      workId: arguments_.workId,
    })),
    label: "Reassign work",
    name: "work_reassign",
    parameters: workReassignParameters,
  };
  const archiveParameters = Type.Object({ avatarId: Type.String(), reason: Type.String() });
  const suggestArchive: AgentTool<typeof archiveParameters> = {
    description: "Create a pending Avatar archive request. This never archives until the user confirms it.",
    execute: async (_toolCallId, arguments_) => result(await input.avatarChanges.suggestArchive({
      avatarId: arguments_.avatarId, reason: arguments_.reason, turnId: input.turnId,
    })),
    label: "Suggest Avatar archive",
    name: "avatar_suggest_archive",
    parameters: archiveParameters,
  };
  const mergeParameters = Type.Object({ reason: Type.String(), sourceAvatarId: Type.String(), targetAvatarId: Type.String() });
  const suggestMerge: AgentTool<typeof mergeParameters> = {
    description: "Create a pending Avatar merge request. Source facts remain intact and nothing changes until the user confirms it.",
    execute: async (_toolCallId, arguments_) => result(await input.avatarChanges.suggestMerge({
      reason: arguments_.reason,
      sourceAvatarId: arguments_.sourceAvatarId,
      targetAvatarId: arguments_.targetAvatarId,
      turnId: input.turnId,
    })),
    label: "Suggest Avatar merge",
    name: "avatar_suggest_merge",
    parameters: mergeParameters,
  };
  const partnerCreateParameters = Type.Object({
    capabilities: Type.Optional(Type.Array(Type.String())),
    description: Type.Optional(Type.String()),
    displayName: Type.String(),
    modelIdOverride: Type.Optional(Type.String()),
    modelSourceId: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    skills: Type.Optional(Type.Array(Type.String())),
    tools: Type.Optional(Type.Array(Type.String({ enum: [...PI_CODING_TOOL_NAMES] }), {
      maxItems: PI_CODING_TOOL_NAMES.length,
      uniqueItems: true,
    })),
  });
  const partnerCreateTool: AgentTool<typeof partnerCreateParameters> = {
    description: "Register a new local Pi partner when no existing partner fits the work. Reuses an active joi-created local partner with the same name. tools accepts only bash, edit, find, grep, ls, read and write; omit it or pass [] to grant all built-in Pi coding tools. Optionally pin a READY model source (modelSourceId from model_list_sources, with modelIdOverride for its model id); omit both to follow the global preferred source. The user sees the new partner card (badged as joi-created) and can edit, disable or delete it.",
    execute: async (_toolCallId, arguments_) => {
      const displayName = arguments_.displayName.trim();
      const tools = normalizeCodingTools(arguments_.tools);
      const nameKey = displayName.toLocaleLowerCase();
      const existing = (await input.partners.list()).find((partner) =>
        partner.createdBy === "joi"
        && partner.engine === "pi-core"
        && partner.kind === "local-pi"
        && partner.status === "ACTIVE"
        && partner.displayName.trim().toLocaleLowerCase() === nameKey
      );
      if (existing !== undefined) {
        return result({ partnerId: existing.partnerId, partnerRevisionId: existing.partnerRevisionId, reused: true });
      }
      const created = await input.partners.add({
        capabilities: arguments_.capabilities ?? [],
        createdBy: "joi",
        ...(arguments_.description === undefined ? {} : { description: arguments_.description }),
        displayName,
        kind: "local-pi",
        ...(arguments_.modelIdOverride === undefined ? {} : { modelIdOverride: arguments_.modelIdOverride }),
        ...(arguments_.modelSourceId === undefined ? {} : { modelSourceId: arguments_.modelSourceId }),
        ...(arguments_.prompt === undefined ? {} : { prompt: arguments_.prompt }),
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
      avatarId: input.avatarId,
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
      avatarId: input.avatarId,
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
        avatarId: input.avatarId,
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
    description: "Read one bounded chunk of a persisted work result belonging to the current Avatar. Use nextCursor to continue.",
    execute: async (_toolCallId, arguments_) => result(await input.results.read({
      avatarId: input.avatarId,
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
    ]),
  });
  const turnCompleteTool: AgentTool<typeof turnCompleteParameters> = {
    description: "Commit a tool-using Turn that is fully answered without dispatch or clarification. DIRECT_ANSWER is only for requests needing no execution; TEAM_READY is only for a completed team-building request; RESULT_SYNTHESIZED is only after persisted results were read and synthesized. This tool never executes work.",
    execute: (_toolCallId, arguments_) => Promise.resolve(result({ outcome: arguments_.outcome, status: "COMMITTED" })),
    label: "Complete this Turn",
    name: "turn_complete",
    parameters: turnCompleteParameters,
  };
  return [
    {
      description: "List redacted Avatar summaries. Does not return persona, memory, or workspace paths.",
      execute: async () => result(await input.avatars.listSummaries()),
      label: "List Avatar summaries",
      name: "avatar_list_summaries",
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
    {
      description: "List active partners with public metadata, live instances and a working-memory digest (recent outcomes, success rate). Use the digest to pick and the instance list to reuse.",
      execute: async () => {
        const [partners, instances] = await Promise.all([input.partners.list(), input.instances.list({ avatarId: input.avatarId })]);
        const enriched = await Promise.all(partners.map(async (dto) => {
          const { tools, ...partner } = dto;
          return {
            ...partner,
            activeInstanceCount: instances.filter((instance) => instance.partnerId === dto.partnerId).length,
            instances: instances
              .filter((instance) => instance.partnerId === dto.partnerId)
              .map((instance) => ({ instanceId: instance.instanceId, lastUsedAt: instance.lastUsedAt, sessionPolicy: instance.sessionPolicy, status: instance.status })),
            memoryDigest: await input.memory.digest(input.avatarId, dto.partnerId),
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
    workReassignTool,
    readResultTool,
    userAskTool,
    turnCompleteTool,
  ];
}
