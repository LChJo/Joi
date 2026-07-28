import { Agent } from "@earendil-works/pi-agent-core";

import type { PartnerAdapterRunner, PartnerPromptStore, PartnerRunRequest, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { PiCodingToolFactory } from "./pi-coding-tool-factory.js";

export class PiCodingPartnerRunner implements PartnerAdapterRunner {
  constructor(private readonly dependencies: {
    prompts: Pick<PartnerPromptStore, "read">;
    resolver: PiConfiguredModelResolver;
    sources: Pick<ReasoningSourceSelector, "selectInitial">;
    tools: PiCodingToolFactory;
  }) {}

  async run(request: PartnerRunRequest, revision: PartnerRevision): Promise<{ externalRunId: string; status: PartnerRunStatus }> {
    if (revision.kind !== "local-pi") throw new Error("local_partner_kind_required");
    if (revision.workspaceRef === undefined) throw new Error("partner_workspace_required");
    let configuredPrompt = "You are a local Pi coding partner. Work only inside the assigned workspace and complete the requested work.";
    if (revision.promptRef !== undefined) {
      const stored = await this.dependencies.prompts.read(revision.promptRef);
      if (stored === null) throw new Error("partner_prompt_not_found");
      configuredPrompt = stored;
    }
    const externalRunId = `local_pi:${request.actionId}`;
    const pin = await this.dependencies.sources.selectInitial(externalRunId);
    const resolved = await this.dependencies.resolver.resolve(pin);
    const tools = this.dependencies.tools.create(revision.workspaceRef, revision.tools);
    const allowed = new Set(tools.map((tool) => tool.name));
    const agent = new Agent({
      beforeToolCall: ({ toolCall }) => Promise.resolve(allowed.has(toolCall.name)
        ? undefined
        : { block: true, reason: "partner_tool_not_allowed" }),
      initialState: {
        messages: [],
        model: resolved.model,
        systemPrompt: [
          configuredPrompt,
          "Never access paths outside the assigned workspace.",
          `Avatar scope: ${request.avatarId}`,
          `Work item: ${request.workId}`,
        ].join("\n"),
        tools,
      },
      sessionId: externalRunId,
      streamFn: resolved.models.streamSimple.bind(resolved.models),
      toolExecution: "sequential",
    });
    await agent.prompt(request.taskProjection);
    const failed = agent.state.messages.some((message) => message.role === "assistant" && message.stopReason === "error");
    return { externalRunId, status: failed ? "FAILED" : "COMPLETED" };
  }
}
