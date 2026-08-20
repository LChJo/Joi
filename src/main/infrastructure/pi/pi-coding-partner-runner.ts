import { Agent } from "@earendil-works/pi-agent-core";

import type { PartnerAdapterRunner, PartnerPromptStore, PartnerRunOutput, PartnerRunRequest, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { WorkbenchExecutionContextReader } from "../../application/ports/workbench-context.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { PartnerSkillCatalog } from "../../application/ports/partner-skills.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import { DomainError } from "../../domain/errors.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { PiCodingToolFactory } from "./pi-coding-tool-factory.js";
import { captureWorkspaceSnapshot, collectChangedWorkspaceArtifacts } from "../workspace/workspace-output-artifacts.js";

export class PiCodingPartnerRunner implements PartnerAdapterRunner {
  constructor(private readonly dependencies: {
    contexts: WorkbenchExecutionContextReader;
    prompts: Pick<PartnerPromptStore, "read">;
    resolver: PiConfiguredModelResolver;
    skills?: Pick<PartnerSkillCatalog, "resolveForPi">;
    sources: Pick<ReasoningSourceSelector, "selectInitial"> & Partial<Pick<ReasoningSourceSelector, "selectById">>;
    tools: PiCodingToolFactory;
  }) {}

  async run(request: PartnerRunRequest, revision: PartnerRevision): Promise<{ externalRunId: string; output: PartnerRunOutput; status: PartnerRunStatus }> {
    if (revision.kind !== "local-pi") throw new Error("local_partner_kind_required");
    const execution = await this.dependencies.contexts.loadForExecution(request.contextSnapshotId);
    if (execution === null) throw new Error("workbench_context_snapshot_not_found");
    let configuredPrompt = "You are a local Pi coding partner. The assigned workspace is your home base; complete the requested work.";
    if (revision.promptRef !== undefined) {
      const stored = await this.dependencies.prompts.read(revision.promptRef);
      if (stored === null) throw new Error("partner_prompt_not_found");
      configuredPrompt = stored;
    }
    const externalRunId = `local_pi:${request.actionId}`;
    const pin = revision.modelSourceId === undefined
      ? await this.dependencies.sources.selectInitial(externalRunId)
      : await this.#selectPinnedSource(revision.modelSourceId, externalRunId);
    if (revision.modelIdOverride !== undefined && revision.modelIdOverride !== pin.modelId) {
      throw new DomainError("partner_model_override_not_ready", "The pinned model is not active on the selected source.");
    }
    const resolved = await this.dependencies.resolver.resolve(pin);
    const skillDispatch = this.dependencies.skills?.resolveForPi(revision.skills)
      ?? { environmentKeys: [], promptSection: "", skillCount: 0 };
    const tools = execution.workspacePath === undefined ? [] : this.dependencies.tools.create(
      execution.workspacePath,
      revision.tools,
      { environmentKeys: skillDispatch.environmentKeys },
    );
    const skillSection = skillDispatch.promptSection;
    const before = await captureWorkspaceSnapshot(execution.workspacePath);
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
          "The assigned workspace is your home base: create work files there by default. When the task requires it, you may also read and write paths outside the workspace (for example user directories, installed skill folders, or configuration files). List every write outside the workspace (path and change) in your final reply. Placeholders like {baseDir} inside skill instructions refer to the skill's own directory.",
          `Workbench scope: ${request.workbenchId}`,
          `Work item: ${request.workId}`,
          execution.promptSection,
          ...(skillSection === "" ? [] : [skillSection]),
        ].join("\n"),
        tools,
      },
      sessionId: externalRunId,
      streamFn: resolved.models.streamSimple.bind(resolved.models),
      toolExecution: "sequential",
    });
    await agent.prompt(request.taskProjection);
    const failed = agent.state.messages.some((message) => message.role === "assistant" && message.stopReason === "error");
    const body = agent.state.messages.flatMap((message) => {
      if (message.role !== "assistant") return [];
      if (typeof message.content === "string") return [message.content];
      return message.content.flatMap((block) => block.type === "text" ? [block.text] : []);
    }).join("\n").trim();
    const artifacts = await collectChangedWorkspaceArtifacts(execution.workspacePath, before);
    return { externalRunId, output: { artifacts, body }, status: failed ? "FAILED" : "COMPLETED" };
  }

  async #selectPinnedSource(sourceId: string, turnId: string) {
    if (this.dependencies.sources.selectById === undefined) {
      throw new DomainError("partner_model_source_not_ready", "The partner model source cannot be selected.");
    }
    return this.dependencies.sources.selectById(sourceId, turnId);
  }
}
