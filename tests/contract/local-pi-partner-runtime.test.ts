/* Faux Pi provider callbacks resolve deterministically in contract tests. */
/* eslint-disable @typescript-eslint/require-await */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { vi } from "vitest";

import { PiCodingPartnerRunner } from "../../src/main/infrastructure/pi/pi-coding-partner-runner.js";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { BuiltinPiCodingToolFactory } from "../../src/main/infrastructure/pi/pi-coding-tool-factory.js";

const contexts = { loadForExecution: async () => ({ promptSection: "Workbench context", sanitized: {}, workspacePath: "workspace_ref_1" }) };
const wait = async (milliseconds: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("local Pi coding partner runtime", () => {
  it("runs one isolated Pi session with the pinned workspace, prompt and tool allowlist", async () => {
    const faux = fauxProvider({ provider: "local-partner" });
    faux.setResponses([fauxAssistantMessage([fauxText("work completed")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const toolRequests: { cwd: string; environmentKeys?: readonly string[]; names: string[] }[] = [];
    const sourceRequests: { sourceId: string; turnId: string }[] = [];
    const runner = new PiCodingPartnerRunner({
      contexts,
      prompts: { read: async (promptRef) => promptRef === "prompt_ref_1" ? "LOCAL_PARTNER_SYSTEM_SENTINEL" : null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      skills: { resolveForPi: () => ({ environmentKeys: ["TAVILY_API_KEY"], promptSection: "skill metadata", skillCount: 1 }) },
      sources: {
        selectById: async (sourceId, turnId) => {
          sourceRequests.push({ sourceId, turnId });
          return { modelId: "faux", modelRevisionId: "mr", sourceId, sourceRevisionId: "sr", turnId };
        },
        selectInitial: async () => { throw new Error("global source must not be selected for a pinned partner"); },
      },
      tools: {
        create: (cwd, names, options) => {
          toolRequests.push({ cwd, names, ...(options?.environmentKeys === undefined ? {} : { environmentKeys: options.environmentKeys }) });
          return [];
        },
        names: ["read", "edit", "bash", "write", "grep", "find", "ls"],
      },
    });
    const revision = createPartnerRevision({
      capabilities: ["code"],
      createdAt: "2026-07-28T12:00:00.000Z",
      displayName: "Local coder",
      kind: "local-pi",
      modelIdOverride: "faux",
      modelSourceId: "source_partner",
      partnerId: "partner_local",
      partnerRevisionId: "partner_revision_local",
      promptRef: "prompt_ref_1",
      registryRevision: 1,
      skills: ["typescript"],
      tools: ["read", "edit"],
    });

    await expect(runner.run({
      actionId: "action_1",
      workbenchId: "workbench_1",
      contextSnapshotId: "context_1",
      taskProjection: "Implement the verified change.",
      workId: "work_1",
    }, revision)).resolves.toMatchObject({ externalRunId: "local_pi:action_1", output: { body: "work completed" }, status: "COMPLETED" });
    expect(toolRequests).toEqual([{ cwd: "workspace_ref_1", environmentKeys: ["TAVILY_API_KEY"], names: ["read", "edit"] }]);
    expect(sourceRequests).toEqual([{ sourceId: "source_partner", turnId: "local_pi:action_1" }]);
  });

  it("fails closed when the prompt reference cannot be resolved", async () => {
    const runner = new PiCodingPartnerRunner({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => { throw new Error("must not resolve"); } },
      sources: { selectInitial: async () => { throw new Error("must not select"); } },
      tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Local", kind: "local-pi",
      partnerId: "partner", partnerRevisionId: "revision", promptRef: "missing", registryRevision: 1,
      skills: [], tools: [],
    });
    await expect(runner.run({ actionId: "action", workbenchId: "workbench", contextSnapshotId: "context", taskProjection: "task", workId: "work" }, revision))
      .rejects.toThrow("partner_prompt_not_found");
  });
});

describe("Pi partner engine runtime", () => {
  it("publishes bounded visible text and tool lifecycle snapshots while a run is active", async () => {
    const faux = fauxProvider({ provider: "local-partner-live-conversation", tokenSize: { max: 1, min: 1 }, tokensPerSecond: 100 });
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("PRIVATE_REASONING"), fauxToolCall("read", { path: "/PRIVATE/live-secret.txt", token: "PRIVATE_TOOL_ARGUMENT" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("正在整理可见结论。")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: {
        create: () => [{
          description: "read a bounded test value",
          execute: async () => ({ content: [{ text: "PRIVATE_TOOL_RESULT /PRIVATE/result.txt", type: "text" as const }], details: {} }),
          label: "read",
          name: "read",
          parameters: Type.Object({ path: Type.String(), token: Type.String() }),
        }],
        names: ["read"],
      },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-08-29T09:00:00.000Z", displayName: "Live partner", kind: "local-pi",
      partnerId: "partner_live", partnerRevisionId: "partner_revision_live", registryRevision: 1, skills: [], tools: ["read"],
    });
    const snapshots: unknown[] = [];
    let publishAttempts = 0;
    const context = {
      knowledgeSection: "",
      onEvent: async (event: unknown) => {
        publishAttempts += 1;
        snapshots.push(event);
        if (publishAttempts === 1) throw new Error("display projection temporarily unavailable");
      },
      skillEnvironmentKeys: [],
      skillSection: "",
    };

    await expect(runtime.runEphemeral(
      { actionId: "action_live", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "分析公开资料", workId: "work_live" },
      revision,
      context,
    )).resolves.toMatchObject({ status: "COMPLETED" });

    const serialized = JSON.stringify(snapshots);
    const visibleText = snapshots.flatMap((event) => {
      const row = event as { parts?: { text?: string }[] };
      return row.parts?.map((part) => part.text ?? "") ?? [];
    }).join("");
    expect(snapshots.length).toBeGreaterThan(2);
    expect(serialized).toContain("分析公开资料");
    expect(visibleText).toContain("正在整理可见结论");
    expect(serialized).toContain('"toolName":"read"');
    expect(serialized).toContain('"state":"completed"');
    expect(serialized).not.toContain("PRIVATE_TOOL_ARGUMENT");
    expect(serialized).not.toContain("PRIVATE_TOOL_RESULT");
    expect(serialized).not.toContain("PRIVATE_REASONING");
    expect(serialized).not.toContain("live-secret");
  });

  it("pauses with actionable input when a Skill command cannot access its credential environment variable", async () => {
    const faux = fauxProvider({ provider: "local-partner-missing-skill-credential" });
    let firstSystemPrompt = "";
    faux.setResponses([
      (context) => {
        firstSystemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage([fauxToolCall("bash", { command: "run selected skill" })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage([fauxText("BLOCKED")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const toolEnvironmentRequests: string[][] = [];
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: {
        create: (_cwd, _names, options) => {
          toolEnvironmentRequests.push([...(options?.environmentKeys ?? [])]);
          return [{
          description: "test bash",
          execute: async () => { throw new Error("Missing TAVILY_API_KEY. Set env var TAVILY_API_KEY. PRIVATE token=secret"); },
          label: "bash",
          name: "bash",
          parameters: Type.Object({ command: Type.String() }),
          }];
        },
        names: ["bash"],
      },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Search", kind: "local-pi",
      partnerId: "partner_search", partnerRevisionId: "partner_revision_search", registryRevision: 1,
      skills: ["agents/tavily-search"], tools: ["bash"],
    });

    const result = await runtime.runEphemeral(
      { actionId: "action_search", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "search", workId: "work_1" },
      revision,
      { knowledgeSection: "", skillEnvironmentKeys: ["TAVILY_API_KEY"], skillSection: "<available_skills><name>tavily-search</name></available_skills>" },
    );

    expect(result.status).toBe("WAITING_INPUT");
    expect(result.output.pendingQuestion).toContain("TAVILY_API_KEY");
    expect(result.output.pendingQuestion).toContain("JOI_PARTNER_ENV_PASSTHROUGH");
    expect(result.output.pendingQuestion).toContain("restart");
    expect(result.output.pendingQuestion).not.toContain("PRIVATE");
    expect(result.output.pendingQuestion).not.toContain("token=secret");
    expect(result.output.body).not.toContain("BLOCKED");
    expect(faux.state.callCount).toBe(1);
    expect(toolEnvironmentRequests).toEqual([["TAVILY_API_KEY"]]);
    expect(firstSystemPrompt).not.toContain("TAVILY_API_KEY");
  });

  it("lets the Pi Agent progressively read a selected Skill after receiving metadata only", async () => {
    const root = mkdtempSync(join(tmpdir(), "joi-pi-skill-runtime-"));
    const workspace = join(root, "workspace");
    const skillRoot = join(root, "selected-skill");
    mkdirSync(workspace);
    mkdirSync(skillRoot);
    const skillFile = join(skillRoot, "SKILL.md");
    writeFileSync(skillFile, "SKILL_BODY_SENTINEL: answer with the verified workflow");
    const faux = fauxProvider({ provider: "local-partner-skill" });
    let firstSystemPrompt = "";
    faux.setResponses([
      (context) => {
        firstSystemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage([fauxToolCall("read", { path: skillFile })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage([fauxText("verified workflow followed")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      contexts: { loadForExecution: async () => ({ promptSection: "Workbench context", sanitized: {}, workspacePath: workspace }) },
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: new BuiltinPiCodingToolFactory(),
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Skill user", kind: "local-pi",
      partnerId: "partner_skill", partnerRevisionId: "partner_revision_skill", registryRevision: 1,
      skills: ["agents/selected-skill"], tools: ["read"],
    });
    try {
      const result = await runtime.runEphemeral(
        { actionId: "action_skill", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "use the selected workflow", workId: "work_1" },
        revision,
        {
          knowledgeSection: "",
          skillEnvironmentKeys: [],
          skillSection: `<available_skills><skill><name>selected-skill</name><description>Verified workflow</description><location>${skillFile}</location></skill></available_skills>`,
        },
      );
      expect(result.output.body).toBe("verified workflow followed");
      expect(faux.state.callCount).toBe(2);
      expect(firstSystemPrompt).toContain("Verified workflow");
      expect(firstSystemPrompt).not.toContain("SKILL_BODY_SENTINEL");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("converts provider error messages into safe transient facts without returning their raw text", async () => {
    const faux = fauxProvider({ provider: "local-partner-error" });
    faux.setResponses([fauxAssistantMessage([], {
      errorMessage: "HTTP 503 PRIVATE upstream payload token=secret", stopReason: "error",
    })]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Local", kind: "local-pi",
      partnerId: "partner_local", partnerRevisionId: "partner_revision_local", registryRevision: 1, skills: [], tools: [],
    });

    const run = runtime.runEphemeral(
      { actionId: "action_error", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "task", workId: "work_1" },
      revision,
      { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
    );
    await expect(run).rejects.toMatchObject({
      partnerRunFailure: { phase: "MODEL", reasonCode: "http_503", retryable: true, sideEffectState: "NONE" },
    });
    await expect(run).rejects.not.toThrow("PRIVATE upstream payload");
  });

  it("continues once after a transient model disconnect without replaying completed tool calls", async () => {
    const faux = fauxProvider({ provider: "local-partner-transient-continuation" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "git diff --stat" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([], { errorMessage: "Connection error.", stopReason: "error" }),
      fauxAssistantMessage([fauxText("review completed after reconnect")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let toolRuns = 0;
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: {
        create: () => [{
          description: "test bash",
          execute: async () => { toolRuns += 1; return { content: [{ text: "diff inspected", type: "text" as const }], details: {} }; },
          label: "bash",
          name: "bash",
          parameters: Type.Object({ command: Type.String() }),
        }],
        names: ["bash"],
      },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Reviewer", kind: "local-pi",
      partnerId: "partner_review", partnerRevisionId: "partner_revision_review", registryRevision: 1,
      skills: [], tools: ["bash"],
    });

    await expect(runtime.runEphemeral(
      { actionId: "action_review", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "review", workId: "work_review" },
      revision,
      { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
    )).resolves.toMatchObject({ output: { body: "review completed after reconnect" }, status: "COMPLETED" });
    expect(toolRuns).toBe(1);
    expect(faux.state.callCount).toBe(3);
  });

  it("classifies an exhausted generic connection failure as safely retryable before side effects", async () => {
    const faux = fauxProvider({ provider: "local-partner-connection-error" });
    faux.setResponses([
      fauxAssistantMessage([], { errorMessage: "Connection error.", stopReason: "error" }),
      fauxAssistantMessage([], { errorMessage: "Connection error.", stopReason: "error" }),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Local", kind: "local-pi",
      partnerId: "partner_local", partnerRevisionId: "partner_revision_local", registryRevision: 1, skills: [], tools: [],
    });

    await expect(runtime.runEphemeral(
      { actionId: "action_connection", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "task", workId: "work_1" },
      revision,
      { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
    )).rejects.toMatchObject({
      partnerRunFailure: { phase: "MODEL", reasonCode: "connection_error", retryable: true, sideEffectState: "NONE" },
    });
  });

  it("aborts only after the partner produces no progress for the configured idle interval", async () => {
    const faux = fauxProvider({ provider: "local-partner-idle-timeout" });
    faux.setResponses([
      async () => {
        await wait(80);
        return fauxAssistantMessage([fauxText("too late")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      runIdleTimeoutMillis: 25,
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-08-24T11:30:00.000Z", displayName: "Idle partner", kind: "local-pi",
      partnerId: "partner_idle", partnerRevisionId: "partner_revision_idle", registryRevision: 1, skills: [], tools: [],
    });

    await expect(runtime.runEphemeral(
      { actionId: "action_idle", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "wait", workId: "work_idle" },
      revision,
      { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
    )).rejects.toMatchObject({
      partnerRunFailure: { phase: "MODEL", reasonCode: "partner_run_idle_timed_out", sideEffectState: "NONE" },
    });
  });

  it("allows a model stream to run longer than the idle interval while deltas keep arriving", async () => {
    const faux = fauxProvider({ provider: "local-partner-model-progress", tokenSize: { max: 1, min: 1 }, tokensPerSecond: 100 });
    faux.setResponses([fauxAssistantMessage([fauxText("progress ".repeat(20))])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      runIdleTimeoutMillis: 40,
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-08-24T11:30:00.000Z", displayName: "Streaming partner", kind: "local-pi",
      partnerId: "partner_streaming", partnerRevisionId: "partner_revision_streaming", registryRevision: 1, skills: [], tools: [],
    });

    await expect(runtime.runEphemeral(
      { actionId: "action_streaming", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "stream", workId: "work_streaming" },
      revision,
      { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
    )).resolves.toMatchObject({ status: "COMPLETED" });
  });

  it("allows a tool to run longer than the idle interval while tool updates keep arriving", async () => {
    const faux = fauxProvider({ provider: "local-partner-tool-progress" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "long task" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("tool completed")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      runIdleTimeoutMillis: 35,
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: {
        create: () => [{
          description: "progressive test bash",
          execute: async (_toolCallId, _params, _signal, onUpdate) => {
            for (let index = 0; index < 5; index += 1) {
              await wait(20);
              onUpdate?.({ content: [{ text: `step ${String(index + 1)}`, type: "text" as const }], details: {} });
            }
            return { content: [{ text: "done", type: "text" as const }], details: {} };
          },
          label: "bash",
          name: "bash",
          parameters: Type.Object({ command: Type.String() }),
        }],
        names: ["bash"],
      },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-08-24T11:30:00.000Z", displayName: "Tool partner", kind: "local-pi",
      partnerId: "partner_tool_progress", partnerRevisionId: "partner_revision_tool_progress", registryRevision: 1, skills: [], tools: ["bash"],
    });

    await expect(runtime.runEphemeral(
      { actionId: "action_tool_progress", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "run tool", workId: "work_tool_progress" },
      revision,
      { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
    )).resolves.toMatchObject({ output: { body: "tool completed" }, status: "COMPLETED" });
  });

  it("caps each tool execution independently and returns a stable timeout result to the model", async () => {
    const faux = fauxProvider({ provider: "local-partner-tool-timeout" });
    let sawStableToolTimeout = false;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "hang" })], { stopReason: "toolUse" }),
      (context) => {
        sawStableToolTimeout = JSON.stringify(context.messages).includes("partner_tool_timed_out");
        return fauxAssistantMessage([fauxText("handled tool timeout")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      runIdleTimeoutMillis: 200,
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      toolTimeoutMillis: 30,
      tools: {
        create: () => [{
          description: "hanging test bash",
          execute: async (_toolCallId, _params, signal) => await new Promise((_resolve, reject) => {
            const rejectFromAbort = (): void => {
              reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
            };
            if (signal?.aborted === true) rejectFromAbort();
            else signal?.addEventListener("abort", rejectFromAbort, { once: true });
          }),
          label: "bash",
          name: "bash",
          parameters: Type.Object({ command: Type.String() }),
        }],
        names: ["bash"],
      },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-08-24T11:30:00.000Z", displayName: "Timed tool partner", kind: "local-pi",
      partnerId: "partner_tool_timeout", partnerRevisionId: "partner_revision_tool_timeout", registryRevision: 1, skills: [], tools: ["bash"],
    });

    await expect(runtime.runEphemeral(
      { actionId: "action_tool_timeout", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "run hanging tool", workId: "work_tool_timeout" },
      revision,
      { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
    )).resolves.toMatchObject({ output: { body: "handled tool timeout" }, status: "COMPLETED" });
    expect(sawStableToolTimeout).toBe(true);
  });

  it("releases the run idle deadline and tool deadline after a successful run", async () => {
    vi.useFakeTimers({ toFake: ["clearTimeout", "setTimeout"] });
    try {
      const faux = fauxProvider({ provider: "local-partner-timeout-cleanup" });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("bash", { command: "quick" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("finished")]),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const runtime = new PiPartnerEngineRuntime({
        contexts,
        prompts: { read: async () => null },
        resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
        runIdleTimeoutMillis: 1_000,
        sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
        toolTimeoutMillis: 1_000,
        tools: {
          create: () => [{
            description: "quick test bash",
            execute: async () => ({ content: [{ text: "done", type: "text" as const }], details: {} }),
            label: "bash",
            name: "bash",
            parameters: Type.Object({ command: Type.String() }),
          }],
          names: ["bash"],
        },
      });
      const revision = createPartnerRevision({
        capabilities: [], createdAt: "2026-08-24T11:30:00.000Z", displayName: "Cleanup partner", kind: "local-pi",
        partnerId: "partner_cleanup", partnerRevisionId: "partner_revision_cleanup", registryRevision: 1, skills: [], tools: ["bash"],
      });

      await expect(runtime.runEphemeral(
        { actionId: "action_cleanup", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "run quick tool", workId: "work_cleanup" },
        revision,
        { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
      )).resolves.toMatchObject({ status: "COMPLETED" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies overloaded, oversized-context and refusal failures into distinct actionable codes", async () => {
    const cases: { errorMessage: string; reasonCode: string; retryable: boolean }[] = [
      { errorMessage: "529 {\"type\":\"overloaded_error\",\"message\":\"upstream busy\"}", reasonCode: "server_error", retryable: true },
      { errorMessage: "400 {\"error\":{\"message\":\"prompt is too long: 210000 tokens > 128000 maximum\"}}", reasonCode: "context_too_large", retryable: false },
      { errorMessage: "The model refused to complete the request", reasonCode: "model_refused", retryable: false },
    ];
    for (const expected of cases) {
      const faux = fauxProvider({ provider: "local-partner-classify" });
      faux.setResponses([fauxAssistantMessage([], { errorMessage: expected.errorMessage, stopReason: "error" })]);
      const models = createModels();
      models.setProvider(faux.provider);
      const runtime = new PiPartnerEngineRuntime({
        contexts,
        prompts: { read: async () => null },
        resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
        sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
        tools: { create: () => [], names: [] },
      });
      const revision = createPartnerRevision({
        capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Local", kind: "local-pi",
        partnerId: "partner_local", partnerRevisionId: "partner_revision_local", registryRevision: 1, skills: [], tools: [],
      });
      await expect(runtime.runEphemeral(
        { actionId: "action_classify", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "task", workId: "work_1" },
        revision,
        { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
      )).rejects.toMatchObject({
        partnerRunFailure: { phase: "MODEL", reasonCode: expected.reasonCode, retryable: expected.retryable },
      });
    }
  });

  it("continues a resident conversation across turns, rebuilds after eviction and keeps ephemeral runs isolated", async () => {
    const faux = fauxProvider({ provider: "local-partner-instances" });
    faux.setResponses([
      fauxAssistantMessage([fauxText("first answer")]),
      fauxAssistantMessage([fauxText("second answer")]),
      fauxAssistantMessage([fauxText("ephemeral answer")]),
      fauxAssistantMessage([fauxText("rebuilt answer")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      contexts,
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Local", kind: "local-pi",
      partnerId: "partner_local", partnerRevisionId: "partner_revision_local", registryRevision: 1,
      skills: [], tools: [],
    });
    const request = { actionId: "action_1", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "first task", workId: "work_1" };

    const first = await runtime.runResidentTurn({ instanceId: "instance_1", knowledgeSection: "KB_SECTION", request, restoredMessages: null, revision, skillEnvironmentKeys: [], skillSection: "" });
    expect(first.status).toBe("COMPLETED");
    expect(first.externalSessionRef).toBe("partner_instance_messages:instance_1");

    const second = await runtime.runResidentTurn({
      instanceId: "instance_1", knowledgeSection: "KB_SECTION",
      request: { ...request, actionId: "action_2", taskProjection: "second task" },
      restoredMessages: first.messages ?? null,
      revision,
      skillEnvironmentKeys: [],
      skillSection: "",
    });
    expect(second.messages?.length).toBeGreaterThan(first.messages?.length ?? 0);

    const ephemeral = await runtime.runEphemeral(
      { actionId: "action_3", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "one shot", workId: "work_3" },
      revision,
      { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" },
    );
    expect(ephemeral).toMatchObject({ externalRunId: "local_pi:action_3", output: { body: "ephemeral answer" }, status: "COMPLETED" });

    runtime.evictFromMemory("instance_1");
    const rebuilt = await runtime.runResidentTurn({
      instanceId: "instance_1", knowledgeSection: "KB_SECTION",
      request: { ...request, actionId: "action_4", taskProjection: "after eviction" },
      restoredMessages: second.messages ?? null,
      revision,
      skillEnvironmentKeys: [],
      skillSection: "",
    });
    expect(rebuilt.status).toBe("COMPLETED");
    expect(rebuilt.messages?.length).toBeGreaterThan(second.messages?.length ?? 0);

    expect(runtime.engineOf()).toBe("pi-core");
    await expect(runtime.health()).resolves.toEqual({ available: true });
  });
});
