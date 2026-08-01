import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { PartnerInstanceManager } from "../../application/partners/partner-instance-manager.js";
import type { PartnerRegistryService } from "../../application/partners/partner-registry-service.js";
import type { PartnerWorkMemoryService } from "../../application/partners/partner-work-memory-service.js";
import type { WorkOrchestrationService } from "../../application/work/work-orchestration-service.js";
import type { ModelSourceService } from "../../application/model-sources/model-source-service.js";
import type { AvatarCatalog } from "../../application/ports/avatar-context.js";
import type { AvatarChangeService } from "../../application/joi/avatar-change-service.js";

function result(value: unknown) {
  return { content: [{ text: JSON.stringify(value), type: "text" as const }], details: {} };
}

export function createJoiReasoningTools(input: {
  avatarId: string;
  avatarChanges: Pick<AvatarChangeService, "suggestArchive" | "suggestMerge">;
  avatars: AvatarCatalog;
  instances: Pick<PartnerInstanceManager, "dispose" | "ensure" | "list">;
  memory: Pick<PartnerWorkMemoryService, "digest">;
  models: Pick<ModelSourceService, "list">;
  partners: Pick<PartnerRegistryService, "add" | "inspect" | "list">;
  turnId: string;
  work: Pick<WorkOrchestrationService, "plan" | "reassign">;
}): AgentTool[] {
  const workDispatchParameters = Type.Object({
    dependencies: Type.Array(Type.Object({ dependsOnKey: Type.String(), workKey: Type.String() })),
    work: Type.Array(Type.Object({
      accessMode: Type.Union([Type.Literal("READ"), Type.Literal("WRITE")]),
      instanceId: Type.Optional(Type.String()),
      key: Type.String(),
      partnerId: Type.String(),
      sessionPolicy: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("resident")])),
      title: Type.String(),
      workspaceRef: Type.Optional(Type.String()),
    }), { minItems: 1, maxItems: 16 }),
  });
  const workDispatchTool: AgentTool<typeof workDispatchParameters> = {
    description: "Persist a checked work DAG and queue each allowed partner dispatch through the outbox. Pass instanceId to reuse an existing partner instance, or sessionPolicy resident to continue a conversation; omit both for one-shot ephemeral work.",
    execute: async (_toolCallId, arguments_) => result(await input.work.plan({
      avatarId: input.avatarId,
      dependencies: arguments_.dependencies,
      turnId: input.turnId,
      work: arguments_.work.map((item) => ({
        accessMode: item.accessMode,
        ...(item.instanceId === undefined ? {} : { instanceId: item.instanceId }),
        key: item.key,
        partnerId: item.partnerId,
        ...(item.sessionPolicy === undefined ? {} : { sessionPolicy: item.sessionPolicy === "resident" ? "RESIDENT" as const : "EPHEMERAL" as const }),
        title: item.title,
        ...(item.workspaceRef === undefined ? {} : { workspaceRef: item.workspaceRef }),
      })),
    })),
    label: "Plan and dispatch work",
    name: "work.dispatch",
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
    name: "work.reassign",
    parameters: workReassignParameters,
  };
  const archiveParameters = Type.Object({ avatarId: Type.String(), reason: Type.String() });
  const suggestArchive: AgentTool<typeof archiveParameters> = {
    description: "Create a pending Avatar archive request. This never archives until the user confirms it.",
    execute: async (_toolCallId, arguments_) => result(await input.avatarChanges.suggestArchive({
      avatarId: arguments_.avatarId, reason: arguments_.reason, turnId: input.turnId,
    })),
    label: "Suggest Avatar archive",
    name: "avatar.suggest_archive",
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
    name: "avatar.suggest_merge",
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
    tools: Type.Optional(Type.Array(Type.String())),
    workspaceRef: Type.Optional(Type.String()),
  });
  const partnerCreateTool: AgentTool<typeof partnerCreateParameters> = {
    description: "Register a new local Pi partner when no existing partner fits the work. Optionally pin a READY model source (modelSourceId from model.list_sources, with modelIdOverride for its model id); omit both to follow the global preferred source. The user sees the new partner card (badged as joi-created) and can edit, disable or delete it.",
    execute: async (_toolCallId, arguments_) => {
      const created = await input.partners.add({
        capabilities: arguments_.capabilities ?? [],
        createdBy: "joi",
        ...(arguments_.description === undefined ? {} : { description: arguments_.description }),
        displayName: arguments_.displayName,
        kind: "local-pi",
        ...(arguments_.modelIdOverride === undefined ? {} : { modelIdOverride: arguments_.modelIdOverride }),
        ...(arguments_.modelSourceId === undefined ? {} : { modelSourceId: arguments_.modelSourceId }),
        ...(arguments_.prompt === undefined ? {} : { prompt: arguments_.prompt }),
        skills: arguments_.skills ?? [],
        tools: arguments_.tools ?? [],
        ...(arguments_.workspaceRef === undefined ? {} : { workspaceRef: arguments_.workspaceRef }),
      });
      return result({ partnerId: created.partnerId, partnerRevisionId: created.partnerRevisionId });
    },
    label: "Create a partner",
    name: "partner.create",
    parameters: partnerCreateParameters,
  };
  const createInstanceParameters = Type.Object({
    partnerId: Type.String(),
    sessionPolicy: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("resident")])),
  });
  const createInstanceTool: AgentTool<typeof createInstanceParameters> = {
    description: "Create an instance of a partner. resident keeps the conversation alive across dispatches (bounded by instance caps); ephemeral is disposed after one turn. Prefer reusing an IDLE instance from partner.list_instances.",
    execute: async (_toolCallId, arguments_) => result(await input.instances.ensure({
      partnerId: arguments_.partnerId,
      ...(arguments_.sessionPolicy === undefined ? {} : { sessionPolicy: arguments_.sessionPolicy === "resident" ? "RESIDENT" as const : "EPHEMERAL" as const }),
    })),
    label: "Create a partner instance",
    name: "partner.create_instance",
    parameters: createInstanceParameters,
  };
  const listInstancesParameters = Type.Object({ partnerId: Type.Optional(Type.String()) });
  const listInstancesTool: AgentTool<typeof listInstancesParameters> = {
    description: "List live partner instances with status, session policy and last use, so follow-up work can reuse the right conversation.",
    execute: async (_toolCallId, arguments_) => result(await input.instances.list(arguments_.partnerId)),
    label: "List partner instances",
    name: "partner.list_instances",
    parameters: listInstancesParameters,
  };
  const disposeInstanceParameters = Type.Object({ instanceId: Type.String(), reason: Type.Optional(Type.String()) });
  const disposeInstanceTool: AgentTool<typeof disposeInstanceParameters> = {
    description: "Dispose a partner instance once its goal is complete. Busy instances cannot be disposed.",
    execute: async (_toolCallId, arguments_) => {
      await input.instances.dispose(arguments_.instanceId, arguments_.reason ?? "joi disposed the instance");
      return result({ disposed: true, instanceId: arguments_.instanceId });
    },
    label: "Dispose a partner instance",
    name: "partner.dispose_instance",
    parameters: disposeInstanceParameters,
  };
  const inspectRevisionParameters = Type.Object({ partnerId: Type.String() });
  const inspectRevisionTool: AgentTool<typeof inspectRevisionParameters> = {
    description: "Inspect one partner's active revision (description, engine, capabilities, knowledge count). Never returns prompt bodies or workspace paths.",
    execute: async (_toolCallId, arguments_) => result(await input.partners.inspect(arguments_.partnerId)),
    label: "Inspect partner revision",
    name: "partner.inspect_revision",
    parameters: inspectRevisionParameters,
  };
  return [
    {
      description: "List redacted Avatar summaries. Does not return persona, memory, or workspace paths.",
      execute: async () => result(await input.avatars.listSummaries()),
      label: "List Avatar summaries",
      name: "avatar.list_summaries",
      parameters: Type.Object({}),
    },
    {
      description: "List READY model network sources assignable to a new partner. Pass a chosen sourceId as modelSourceId to partner.create (optionally modelIdOverride for its model id); omit to follow the global preferred source.",
      execute: async () => result((await input.models.list())
        .filter((source) => source.status === "READY")
        .map((source) => ({ displayName: source.displayName, kind: source.kind, modelId: source.activeModel.id, primary: source.primary, protocol: source.protocol, sourceId: source.sourceId }))),
      label: "List ready model sources",
      name: "model.list_sources",
      parameters: Type.Object({}),
    },
    suggestMerge,
    suggestArchive,
    {
      description: "List active partners with public metadata, live instances and a working-memory digest (recent outcomes, success rate). Use the digest to pick and the instance list to reuse.",
      execute: async () => {
        const [partners, instances] = await Promise.all([input.partners.list(), input.instances.list()]);
        const enriched = await Promise.all(partners.map(async (dto) => ({
          ...dto,
          activeInstanceCount: instances.filter((instance) => instance.partnerId === dto.partnerId).length,
          instances: instances
            .filter((instance) => instance.partnerId === dto.partnerId)
            .map((instance) => ({ instanceId: instance.instanceId, lastUsedAt: instance.lastUsedAt, sessionPolicy: instance.sessionPolicy, status: instance.status })),
          memoryDigest: await input.memory.digest(dto.partnerId),
        })));
        return result(enriched);
      },
      label: "List available partners",
      name: "partner.list_available",
      parameters: Type.Object({}),
    },
    inspectRevisionTool,
    partnerCreateTool,
    createInstanceTool,
    listInstancesTool,
    disposeInstanceTool,
    workDispatchTool,
    workReassignTool,
  ];
}
