import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { WorkOrchestrationService } from "../../application/work/work-orchestration-service.js";
import type { PartnerRegistryService } from "../../application/partners/partner-registry-service.js";
import type { AvatarCatalog } from "../../application/ports/avatar-context.js";

function result(value: unknown) {
  return { content: [{ text: JSON.stringify(value), type: "text" as const }], details: {} };
}

export function createJoiReasoningTools(input: {
  avatarId: string;
  avatars: AvatarCatalog;
  partners: Pick<PartnerRegistryService, "list">;
  turnId: string;
  work: Pick<WorkOrchestrationService, "plan" | "reassign">;
}): AgentTool[] {
  const workDispatchParameters = Type.Object({
    dependencies: Type.Array(Type.Object({ dependsOnKey: Type.String(), workKey: Type.String() })),
    work: Type.Array(Type.Object({
      accessMode: Type.Union([Type.Literal("READ"), Type.Literal("WRITE")]),
      key: Type.String(),
      partnerId: Type.String(),
      title: Type.String(),
      workspaceRef: Type.Optional(Type.String()),
    }), { minItems: 1, maxItems: 16 }),
  });
  const workDispatchTool: AgentTool<typeof workDispatchParameters> = {
    description: "Persist a checked work DAG and queue each allowed partner dispatch through the outbox.",
    execute: async (_toolCallId, arguments_) => result(await input.work.plan({
      avatarId: input.avatarId,
      dependencies: arguments_.dependencies,
      turnId: input.turnId,
      work: arguments_.work,
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
  return [
    {
      description: "List redacted Avatar summaries. Does not return persona, memory, or workspace paths.",
      execute: async () => result(await input.avatars.listSummaries()),
      label: "List Avatar summaries",
      name: "avatar.list_summaries",
      parameters: Type.Object({}),
    },
    {
      description: "List active partners with their public capability and active revision metadata.",
      execute: async () => result(await input.partners.list()),
      label: "List available partners",
      name: "partner.list_available",
      parameters: Type.Object({}),
    },
    workDispatchTool,
    workReassignTool,
  ];
}
