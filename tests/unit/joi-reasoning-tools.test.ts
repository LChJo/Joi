/* eslint-disable @typescript-eslint/require-await */
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createJoiReasoningTools, goalFromInputIdPrefix, selectJoiReasoningToolsForInput } from "../../src/main/infrastructure/pi/joi-reasoning-tools.js";
import { JOI_REASONING_TOOL_NAMES } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { DomainError } from "../../src/main/domain/errors.js";
import { harnessReviewInputId } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-review-identity.js";
import type { CreateAutomationInput, UpdateAutomationInput } from "../../src/shared/automation.js";
import type { ModelSourceDto, PartnerDto } from "../../src/shared/joi.js";
import type { GoalRequirementsRepository } from "../../src/main/application/ports/goal-requirements.js";
import type { GoalWorkListPage,GoalWorkListQuery } from "../../src/main/application/ports/work-orchestration.js";
import type { MethodEvidenceRead } from "../../src/main/application/ports/method-learning.js";

const partnerDto: PartnerDto = {
  capabilities: ["code"], createdBy: "user", displayName: "Coder", engine: "pi-core", inFlightCount: 0,
  kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId: "partner_1",
  partnerRevisionId: "partner_revision_1", registryRevision: 1, skills: [], status: "ACTIVE", tools: ["read"],
};

describe("partner tool access guidance", () => {
  it("allows external reads while limiting workspace writes", () => {
    const tool = makeTools().tools.find(candidate => candidate.name === "partner_set_tools");
    expect(tool?.description).toContain("read task inputs inside or outside the Workbench workspace");
    expect(tool?.description).toContain("workspace write access");
    expect(tool?.description).not.toContain("or paths outside the Workbench");
  });
});

const readySource: ModelSourceDto = {
  accessMode: "api", activeModel: { capability: "release-tested", id: "kimi-k2.5", revisionId: "model_r" },
  activeSourceRevisionId: "source_revision_r", credential: { configured: true, version: 1 }, displayName: "Kimi",
  kind: "kimi", order: 0, primary: true, protocol: "anthropic", sourceId: "source_ready", status: "READY",
};
const draftSource: ModelSourceDto = { ...readySource, displayName: "Draft", primary: false, sourceId: "source_draft", status: "DRAFT" };

const instanceRecord = {
  workbenchId: "workbench_1", createdAt: "2026-07-29T10:00:00.000Z", engine: "pi-core" as const, instanceId: "instance_1",
  lastUsedAt: "2026-07-29T10:00:00.000Z", partnerId: "partner_1", partnerRevisionId: "partner_revision_1",
  sessionPolicy: "RESIDENT" as const, status: "IDLE" as const,
};

interface HarnessRecorder {
  calls: { args: Record<string, unknown>; method: string }[];
}

function makeTools(options: {
  requirements?: GoalRequirementsRepository;
  workPage?: (query: GoalWorkListQuery) => Promise<GoalWorkListPage>;
  automationCalls?: { input: Record<string, unknown>; key?: string; method: string }[];
  attachmentIds?: string[];
  attachments?: { read(attachmentId: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }> };
  goalInputId?: string;
  harness?: HarnessRecorder;
  clearMapResult?: boolean;
  inputId?: string;
  partners?: PartnerDto[];
  planError?: Error;
  commitError?: Error;
  briefError?: Error;
  resumeCalls?: { inputId: string; turnId: string }[];
  resumeError?: Error;
  refineCalls?: { args: { workbenchId: string; input: Record<string, unknown> }[] };
  workspaceBindCalls?: { workbenchId: string; rootPath: string }[];
  workspaceCurrent?: { displayName: string; kind: "BOUND" | "MANAGED"; status: "FAILED" | "PROVISIONING" | "READY" } | null;
  workspacePicker?: () => Promise<string | null>;
  workspaceBlocked?: boolean;
  workResumeCalls?: Record<string, unknown>[];
  workCancelCalls?: string[];
  recordEvidenceRead?: (receipt: MethodEvidenceRead) => void;
  resultReadError?: Error;
  evidenceReadError?: Error;
} = {}) {
  const addCalls: unknown[] = [];
  const setModelCalls: unknown[] = [];
  const setSkillsCalls: unknown[] = [];
  const setToolsCalls: unknown[] = [];
  const ensureCalls: unknown[] = [];
  const disposeCalls: { instanceId: string; reason: string }[] = [];
  const planCalls: unknown[] = [];
  const evidenceCalls: unknown[] = [];
  const clarificationCalls: { inputId: string; prompt?: string; reasonCode: string }[] = [];
  const changeBase = { createdAt: "2026-07-29T10:00:00.000Z", requestId: "change_1", status: "PENDING" as const };
  const harnessCalls = options.harness?.calls ?? [];
  const push = (method: string, args: Record<string, unknown>): void => { harnessCalls.push({ args, method }); };
  const tools = createJoiReasoningTools({
    ...(options.recordEvidenceRead === undefined ? {} : { recordEvidenceRead: options.recordEvidenceRead }),
    ...(options.requirements === undefined ? {} : { requirements: options.requirements }),
    ...(options.automationCalls === undefined ? {} : { automation: {
      create: async (automationInput: CreateAutomationInput, key?: string) => { options.automationCalls?.push({ input: automationInput as unknown as Record<string, unknown>, ...(key === undefined ? {} : { key }), method: "create" }); return {} as never; },
      delete: async () => undefined,
      get: async () => ({} as never),
      list: async () => [],
      revealPrompt: async () => ({ prompt: "" }),
      runNow: async () => ({} as never),
      setEnabled: async () => ({} as never),
      update: async (routineId: string, updatePatch: UpdateAutomationInput, key?: string) => { options.automationCalls?.push({ input: { routineId, ...updatePatch }, ...(key === undefined ? {} : { key }), method: "update" }); return {} as never; },
    } }),
    workbenchId: "workbench_1",
    workbenchChanges: {
      suggestArchive: async (input) => ({ ...changeBase, ...input, kind: "ARCHIVE" as const, sourceWorkbenchId: input.workbenchId }),
      suggestMerge: async (input) => ({ ...changeBase, ...input, kind: "MERGE" as const }),
    },
    directoryPicker: options.workspacePicker ?? (() => Promise.resolve(null)),
    workbenchWorkspaces: {
      bindExisting: async (workbenchId, rootPath) => {
        options.workspaceBindCalls?.push({ workbenchId, rootPath });
        return { displayName: "绑定目录", kind: "BOUND", status: "READY" };
      },
      current: async () => options.workspaceCurrent ?? null,
    },
    clarifications: {
      requireClarification: async (inputId, reasonCode, prompt) => {
        clarificationCalls.push({ inputId, ...(prompt === undefined ? {} : { prompt }), reasonCode });
      },
      ...(options.resumeCalls === undefined ? {} : { resumeGoal: async (input: { inputId: string; turnId: string }) => {
        if (options.resumeError !== undefined) throw options.resumeError;
        options.resumeCalls?.push(input);
        return { status: "OPEN" as const };
      } }),
    },
    workbenches: { getWorkbench: async () => null, listSummaries: async () => [] },
    ...(options.attachmentIds === undefined ? {} : { attachmentIds: options.attachmentIds }),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.goalInputId === undefined ? {} : { goalInputId: options.goalInputId }),
    harness: {
      chartPath: async (args) => {
        push("chartPath", args);
        return args.close !== undefined
          ? { pathId: args.close.pathId, status: args.close.status }
          : { pathId: "path_1", status: "OPEN" as const };
      },
      clearMap: async (args) => { push("clearMap", args); return options.clearMapResult ?? true; },
      graduateFog: async (args) => { push("graduateFog", args); return { fogId: args.fogId, pathId: "path_1" }; },
      nameDestination: async (args) => { push("nameDestination", args); return { destination: args.destination, revision: 1 }; },
      noteFog: async (args) => { push("noteFog", args); return { fogId: "fog_1" }; },
      recordDecision: async (args) => { push("recordDecision", args); return { decisionId: "decision_1" }; },
    },
    instances: {
      dispose: async ({ instanceId, reason }) => { disposeCalls.push({ instanceId, reason }); },
      ensure: async (input) => { ensureCalls.push(input); return instanceRecord; },
      list: async () => [instanceRecord],
    },
    memory: { digest: async () => ({ last3: [{ at: "2026-07-29T10:00:00.000Z", outcome: "COMPLETED" as const, title: "old task" }], successRate: 0.5, summary: "DIGEST_SUMMARY" }) },
    inputId: options.inputId ?? "input_1",
    models: { list: async () => [readySource, draftSource] },
    partners: {
      add: async (input) => { addCalls.push(input); return partnerDto; },
      inspect: async () => partnerDto,
      list: async () => options.partners ?? [partnerDto],
      setModel: async (partnerId, model) => { setModelCalls.push({ model, partnerId }); return { ...partnerDto, ...model }; },
      setSkills: async (partnerId, skills) => { setSkillsCalls.push({ partnerId, skills }); return { ...partnerDto, skills }; },
      setTools: async (partnerId, tools) => { setToolsCalls.push({ partnerId, tools }); return { ...partnerDto, tools }; },
    },
    skills: { listForEngine: () => [{ description: "演示", displayName: "演示技能", id: "claude-code/demo-skill", modifiedAt: 1 }] },
    results: {
      read: async ({ resultId }) => { if (options.resultReadError !== undefined) throw options.resultReadError; return { content: "result", resultId }; },
      index: async args => { evidenceCalls.push(args); return { content: "index",totalCharacters: 5 }; },
      readConclusion: async args => { if (options.evidenceReadError !== undefined) throw options.evidenceReadError; evidenceCalls.push(args); return { content: "conclusion",totalCharacters: 10 }; },
      readHandoff: async args => { if (options.evidenceReadError !== undefined) throw options.evidenceReadError; evidenceCalls.push(args); return { content: "handoff",totalCharacters: 7,resultId: args.resultId,handoffStatus: "PROVIDED" as const }; },
      readState: async args => { if (options.evidenceReadError !== undefined) throw options.evidenceReadError; evidenceCalls.push(args); return { content: "state",totalCharacters: 5,outcomeId: args.outcomeId,stateStatus: "PROVIDED" as const }; },
      readChanges: async args => { evidenceCalls.push(args); return { changedResults: [],totalChanges: 0 }; },
    },
    turnId: "turn_1",
    work: {
      ...(options.workPage === undefined ? {} : { listGoalPage: options.workPage,listForGoal: () => Promise.reject(new Error("Full Work list lookup is unavailable in this fixture.")) }),
      plan: async (input) => {
        planCalls.push(input);
        if (options.workspaceBlocked === true) throw new DomainError("workbench_workspace_not_ready", "workspace required");
        if (options.planError !== undefined) throw options.planError;
        if (options.briefError !== undefined && input.work.some((item) => item.instructions === undefined)) throw options.briefError;
        input.onCommitStart?.();
        if (options.commitError !== undefined) throw options.commitError;
        return { denied: [], queued: [], dispatchPlanId: "plan_1", waves: [] };
      },
      reassign: async (input) => ({
        ...input,
        actionId: "action_r",
        dispatchAttemptId: "attempt_r",
        outbox: {
          availableAt: "2026-07-29T10:00:00.000Z",
          kind: "partner.dispatch" as const,
          outboxId: "outbox_r",
          payload: { actionId: "action_r", dispatchAttemptId: "attempt_r", workId: input.workId },
        },
        partnerRevisionId: "partner_revision_1",
        registryRevision: 1,
      }),
      resume: async (input) => {
        if (options.briefError !== undefined && input.instructions === undefined) throw options.briefError;
        options.workResumeCalls?.push(input);
        return {
          actionId: "action_resume",
          dispatchAttemptId: "attempt_resume",
          outbox: {
            availableAt: "2026-07-29T10:00:00.000Z",
            kind: "partner.dispatch" as const,
            outboxId: "outbox_resume",
            payload: { actionId: "action_resume", dispatchAttemptId: "attempt_resume", sessionPolicy: "RESIDENT" as const, workId: input.workId },
          },
          partnerId: "partner_1",
          partnerRevisionId: "partner_revision_1",
          registryRevision: 1,
          workId: input.workId,
        };
      },
      cancel: async (input) => { options.workCancelCalls?.push(input.workId); return { workId: input.workId }; },
      supplement: async (input) => {
        if (options.briefError !== undefined && input.instructions === undefined) throw options.briefError;
        return { attemptNo: 1, dispatchPlanId: "plan_recovery", evidenceResultIds: ["result_1"], waves: [[input.sourceWorkId]] };
      },
    },
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    /** Mirrors the runtime's pi-ai argument validation (throws on schema violation). */
    async validate(name: string, args: Record<string, unknown>): Promise<unknown> {
      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`missing tool ${name}`);
      return validateToolArguments(tool as never, { arguments: args as never, id: "tool_call_1", name, type: "toolCall" });
    },
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`missing tool ${name}`);
      const output = await tool.execute("tool_call_1", args) as { content: { text: string }[] };
      return JSON.parse(output.content[0]?.text ?? "null") as unknown;
    },
    addCalls,
    setModelCalls,
    setSkillsCalls,
    setToolsCalls,
    disposeCalls,
    ensureCalls,
    planCalls,
    evidenceCalls,
    clarificationCalls,
    tools,
  };
}

describe("joi reasoning tools", () => {
  it("AC-WR-08 preserves resource-waiting Work unless cancellation has an explicit intent", async () => {
    const requirements = { load: async () => null } as unknown as GoalRequirementsRepository;
    const canceled: string[] = [];
    const harness = makeTools({ requirements, workCancelCalls: canceled, workPage: async () => ({ items: [
      { workId: "waiting", title: "Waiting", status: "RUNNING", executionPhase: "WRITE_QUEUED", waitReason: "WORKSPACE_WRITE" },
    ] }) });
    await expect(harness.call("work_cancel", { workId: "waiting" })).resolves.toMatchObject({
      status: "WAITING", workId: "waiting", waitReason: "WORKSPACE_WRITE", automaticResume: true,
    });
    expect(canceled).toEqual([]);
    await harness.validate("work_cancel", { workId: "waiting", reason: "USER_REQUEST" });
    await expect(harness.call("work_cancel", { workId: "waiting", reason: "USER_REQUEST" })).resolves.toMatchObject({ workId: "waiting" });
    expect(canceled).toEqual(["waiting"]);
  });
  it("wires paged goal Work lookups through the production tool factory and guarded cancellation",async () => {
    const requirements: GoalRequirementsRepository = {
      ensure: () => Promise.reject(new Error("unused")),load: () => Promise.resolve(null),readSource: () => Promise.reject(new Error("unused")),
      resolveSource: () => Promise.reject(new Error("unused")),update: () => Promise.reject(new Error("unused")),
      assertReady: () => Promise.resolve(null),checkpointTurn: () => Promise.resolve(),
    };
    const queries: GoalWorkListQuery[] = [];
    const harness = makeTools({ requirements,workPage: query => { queries.push(query); return Promise.resolve({ items: [{ workId: "selected",title: "Selected",status: "READY",requirementsRevision: 2 }],nextCursor: "next" }); } });
    await expect(harness.call("work_list_goal",{ statuses: ["READY"],requirementsRevisionNot: 2,limit: 3,cursor: "cursor" })).resolves.toMatchObject({ items: [{ workId: "selected" }],nextCursor: "next" });
    await expect(harness.call("work_cancel",{ workId: "selected" })).resolves.toMatchObject({ workId: "selected" });
    expect(queries).toEqual([
      { goalInputId: "input_1",workbenchId: "workbench_1",statuses: ["READY"],requirementsRevisionNot: 2,limit: 3,cursor: "cursor" },
      { goalInputId: "input_1",workbenchId: "workbench_1",workId: "selected",limit: 1 },
    ]);
  });
  it.each([undefined, []])("requires nonempty dispatch acceptance checks in the advertised schema: %j", async (acceptanceChecks) => {
    const harness = makeTools();
    await expect(harness.validate("work_dispatch", { work: [{
      accessMode: "READ", key: "read", partnerId: "partner_1", title: "Read", instructions: "Return evidence.",
      ...(acceptanceChecks === undefined ? {} : { acceptanceChecks }),
    }] })).rejects.toThrow();
  });

  it("offers one nonterminating acceptance correction before closing a repeated rejection", async () => {
    const harness = makeTools({ planError: new DomainError("work_acceptance_checks_required", "invalid") });
    const tool = harness.tools.find((candidate) => candidate.name === "work_dispatch");
    if (tool === undefined) throw new Error("missing dispatch tool");
    const args = { work: [{ accessMode: "READ", key: "read", partnerId: "partner_1", title: "Read", instructions: "Return evidence." }] };
    const first = await tool.execute("missing-check", args);
    expect(JSON.parse(first.content[0]?.type === "text" ? first.content[0].text : "null"))
      .toMatchObject({ reasonCode: "work_acceptance_checks_required", status: "RETRY_REQUIRED" });
    expect(first).not.toHaveProperty("terminate", true);
    expect(first).toHaveProperty("details.replaySafeRejection", true);
    const second = await tool.execute("still-missing-check", args);
    expect(JSON.parse(second.content[0]?.type === "text" ? second.content[0].text : "null"))
      .toMatchObject({ reasonCode: "work_acceptance_checks_required", status: "FAILED" });
    expect(second).toHaveProperty("terminate", true);
    expect(second).toMatchObject({ isError: true, details: { replaySafeRejection: true } });
    expect(harness.clarificationCalls).toEqual([]);
  });

  it("keeps host rejection proof out of successful, submitted and user-question results", async () => {
    const args = { work: [{ accessMode: "READ", key: "one", partnerId: "partner_1", title: "Synthetic" }] };
    const success = makeTools();
    const submitted = makeTools({ commitError: new Error("Synthetic commit failure") });
    const question = makeTools({ workspaceBlocked: true });
    for (const harness of [success, submitted, question]) {
      const tool = harness.tools.find(candidate => candidate.name === "work_dispatch");
      if (tool === undefined) throw new Error("missing dispatch tool");
      const output = await tool.execute("proof", args);
      expect(output).not.toHaveProperty("details.replaySafeRejection");
    }
    expect(question.clarificationCalls).toHaveLength(1);
  });

  it.each(["work_dispatch", "work_supplement", "work_resume"])("offers one instruction correction for %s without asking the user", async (name) => {
    const harness = makeTools({ briefError: new DomainError("work_instructions_invalid", "invalid") });
    const args = name === "work_dispatch" ? { work: [{ accessMode: "NONE", key: "one", partnerId: "partner_1", title: "核对" }] }
      : name === "work_supplement" ? { accessMode: "NONE", partnerId: "partner_1", sourceWorkId: "work_1", title: "核对" }
        : { workId: "work_1" };
    await expect(harness.call(name, args)).resolves.toMatchObject({ reasonCode: "work_instructions_invalid", status: "RETRY_REQUIRED" });
    await expect(harness.call(name, args)).resolves.toMatchObject({ reasonCode: "work_instructions_invalid", status: "FAILED" });
    expect(harness.clarificationCalls).toEqual([]);
  });

  it.each(["work_dispatch", "work_supplement", "work_resume"])("accepts a corrected brief for %s in the same turn", async (name) => {
    const harness = makeTools({ briefError: new DomainError("work_instructions_invalid", "invalid") });
    const work = { accessMode: "NONE", key: "one", partnerId: "partner_1", title: "核对" };
    const args = name === "work_dispatch" ? { work: [work] }
      : name === "work_supplement" ? { accessMode: "NONE", partnerId: "partner_1", sourceWorkId: "work_1", title: "核对" }
        : { workId: "work_1" };
    await expect(harness.call(name, args)).resolves.toMatchObject({ status: "RETRY_REQUIRED" });
    const corrected = name === "work_dispatch" ? { work: [{ ...work, instructions: "只核对当前主题，返回裁决。" }] }
      : { ...args, instructions: "只核对当前主题，返回裁决。" };
    const response = await harness.call(name, corrected);
    expect(response).not.toHaveProperty("status", "FAILED");
    expect(response).not.toHaveProperty("status", "RETRY_REQUIRED");
    expect(harness.clarificationCalls).toEqual([]);
  });

  it("keeps every registered reasoning tool inside the runtime allowlist", () => {
    const allowed = new Set<string>(JOI_REASONING_TOOL_NAMES);
    expect(makeTools().tools.map((tool) => tool.name).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("can schedule a fixed continuation against the current goal context", async () => {
    const automationCalls: { input: Record<string, unknown>; key?: string; method: string }[] = [];
    const fixture = makeTools({ automationCalls, goalInputId: "goal-root", inputId: "joi_harness_review:goal:goal-root:r1" });

    await fixture.call("create_automation", {
      frequency: { hours: 1, kind: "interval" },
      name: "继续检查",
      prompt: "核对新增证据",
      targetKind: "GOAL_CONTINUATION",
    });

    expect(automationCalls).toHaveLength(1);
    expect(automationCalls[0]?.method).toBe("create");
    expect(automationCalls[0]?.input).toMatchObject({
      name: "继续检查",
      prompt: "核对新增证据",
      target: { goalId: "goal-root", kind: "GOAL_CONTINUATION" },
    });
    expect(automationCalls[0]?.input).not.toHaveProperty("workbenchId");
  });

  it("lets a goal result turn inspect a safe failure, switch a partner revision and reassign the same Work", () => {
    const tools = selectJoiReasoningToolsForInput(makeTools().tools, "joi_result_input:goal:goal-1");
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "model_list_sources", "partner_list_available", "partner_set_model", "work_read_result", "work_reassign", "turn_complete",
    ]));
  });

  it("turns a missing Workbench workspace into a visible clarification instead of opening the picker", async () => {
    const workspaceBindCalls: { workbenchId: string; rootPath: string }[] = [];
    const workspacePicker = vi.fn(async () => "C:\\projects\\private-docs");
    const harness = makeTools({
      workspaceBindCalls,
      workspacePicker,
    });
    const result = await harness.call("workbench_bind_workspace", {});
    expect(result).toEqual({ reasonCode: "workbench_workspace_not_ready", status: "CLARIFICATION_REQUIRED" });
    expect(harness.clarificationCalls).toEqual([{
      inputId: "input_1",
      prompt: "这个工作需要读写文件。请先从 joi 卡片选择当前 Workbench 的工作目录，确认后我再继续派发。",
      reasonCode: "workbench_workspace_not_ready",
    }]);
    expect(workspacePicker).not.toHaveBeenCalled();
    expect(workspaceBindCalls).toEqual([]);
  });
  it("reports an existing READY binding instead of re-asking for an already bound directory", async () => {
    const harness = makeTools({ workspaceCurrent: { displayName: "Zgame_20190440", kind: "BOUND", status: "READY" } });
    const result = await harness.call("workbench_bind_workspace", {});
    expect(result).toEqual({ alreadyBound: true, displayName: "Zgame_20190440", kind: "BOUND", status: "READY" });
    expect(harness.clarificationCalls).toEqual([]);
  });
  it.each(["PROVISIONING", "FAILED", "READY"] as const)("allows managed %s bindings to prepare an independent directory at dispatch", async status => {
    const harness = makeTools({ workspaceCurrent: { displayName: "Managed", kind: "MANAGED", status } });
    expect(await harness.call("workbench_bind_workspace", {})).toEqual({
      alreadyBound: true, displayName: "Managed", dispatchAllowed: true, kind: "MANAGED", status,
    });
    expect(harness.clarificationCalls).toEqual([]);
  });
  it("binds an explicit workspace path from the user request without another card action", async () => {
    const workspaceBindCalls: { workbenchId: string; rootPath: string }[] = [];
    const harness = makeTools({ workspaceBindCalls });
    const result = await harness.call("workbench_bind_workspace", { workspacePath: "I:\\aimana\\manaagentsdk" });
    expect(result).toEqual({ displayName: "绑定目录", kind: "BOUND", status: "READY" });
    expect(JSON.stringify(result)).not.toContain("manaagentsdk");
    expect(harness.clarificationCalls).toEqual([]);
    expect(workspaceBindCalls).toEqual([{ workbenchId: "workbench_1", rootPath: "I:\\aimana\\manaagentsdk" }]);
  });
  it("rejects a relative workspace path instead of guessing its root", async () => {
    const workspaceBindCalls: { workbenchId: string; rootPath: string }[] = [];
    const harness = makeTools({ workspaceBindCalls });
    await expect(harness.call("workbench_bind_workspace", { workspacePath: "manaagentsdk" }))
      .rejects.toMatchObject({ code: "workbench_workspace_path_invalid" });
    expect(workspaceBindCalls).toEqual([]);
  });
  it("never rebinds a directory the user bound, even when a path is supplied", async () => {
    const workspaceBindCalls: { workbenchId: string; rootPath: string }[] = [];
    const harness = makeTools({
      workspaceBindCalls,
      workspaceCurrent: { displayName: "manaagentsdk", kind: "BOUND", status: "READY" },
    });
    const result = await harness.call("workbench_bind_workspace", { workspacePath: "I:\\aimana\\ai_mana_front_debug" });
    expect(result).toEqual({ alreadyBound: true, displayName: "manaagentsdk", kind: "BOUND", status: "READY" });
    expect(workspaceBindCalls).toEqual([]);
    expect(harness.clarificationCalls).toEqual([]);
  });
  it("still binds an explicit path onto a Workbench that only runs on its default managed directory", async () => {
    const workspaceBindCalls: { workbenchId: string; rootPath: string }[] = [];
    const harness = makeTools({
      workspaceBindCalls,
      workspaceCurrent: { displayName: "ManaAgentSDK 工作区", kind: "MANAGED", status: "READY" },
    });
    const result = await harness.call("workbench_bind_workspace", { workspacePath: "I:\\aimana\\manaagentsdk" });
    expect(result).toEqual({ displayName: "绑定目录", kind: "BOUND", status: "READY" });
    expect(workspaceBindCalls).toEqual([{ workbenchId: "workbench_1", rootPath: "I:\\aimana\\manaagentsdk" }]);
  });
  it("asks the user to repair a bound workspace that is not usable instead of rebinding it", async () => {
    const workspaceBindCalls: { workbenchId: string; rootPath: string }[] = [];
    const harness = makeTools({
      workspaceBindCalls,
      workspaceCurrent: { displayName: "manaagentsdk", kind: "BOUND", status: "FAILED" },
    });
    const result = await harness.call("workbench_bind_workspace", { workspacePath: "I:\\aimana\\other" });
    expect(result).toEqual({ reasonCode: "workbench_workspace_not_ready", status: "CLARIFICATION_REQUIRED" });
    expect(workspaceBindCalls).toEqual([]);
    expect(harness.clarificationCalls).toHaveLength(1);
  });
  it("creates partners on behalf of joi with the joi creator badge", async () => {
    const harness = makeTools();
    const created = await harness.call("partner_create", { description: "写文档", displayName: "Writer" }) as { partnerId: string };
    expect(created.partnerId).toBe("partner_1");
    expect(harness.addCalls[0]).toMatchObject({ capabilities: [], createdBy: "joi", description: "写文档", kind: "local-pi", skills: [], tools: [] });
    expect(String((harness.addCalls[0] as { prompt?: unknown }).prompt)).toContain("Writer");
  });

  it("lists available skills and lets joi attach only an engine-compatible skill", async () => {
    const harness = makeTools();
    await expect(harness.call("partner_list_skills", { engine: "pi-core" })).resolves.toEqual({
      engine: "pi-core",
      items: [{ description: "演示", displayName: "演示技能", id: "claude-code/demo-skill" }],
    });
    await expect(harness.call("partner_set_skills", { partnerId: "partner_1", skills: ["claude-code/demo-skill"] }))
      .resolves.toMatchObject({ partnerId: "partner_1", skills: ["claude-code/demo-skill"] });
    expect(harness.setSkillsCalls).toEqual([{ partnerId: "partner_1", skills: ["claude-code/demo-skill"] }]);
    await expect(harness.call("partner_set_skills", { partnerId: "partner_1", skills: ["missing-skill"] }))
      .rejects.toMatchObject({ code: "partner_skill_not_available" });
  });

  it("uses a cluster name when joi creates a role-named senior programmer partner", async () => {
    const harness = makeTools();
    await harness.call("partner_create", { description: "负责前端调试分析", displayName: "资深程序员搭档" });
    expect(harness.addCalls[0]).toMatchObject({ createdBy: "joi", displayName: "编码搭档", description: "负责前端调试分析" });
  });

  it("pins a chosen model source when creating a partner", async () => {
    const harness = makeTools();
    await harness.call("partner_create", { displayName: "Writer", modelIdOverride: "kimi-k2.5", modelSourceId: "source_ready" });
    expect(harness.addCalls[0]).toMatchObject({ createdBy: "joi", displayName: "Writer", modelIdOverride: "kimi-k2.5", modelSourceId: "source_ready" });
  });

  it("synthesizes description and prompt when the model leaves them blank", async () => {
    const harness = makeTools();
    await harness.call("partner_create", { description: "  ", displayName: "股票分析搭档", prompt: "", skills: ["基本面", "技术面"] });
    const call = harness.addCalls[0] as { description?: unknown; prompt?: unknown };
    expect(call.description).toBe("股票分析搭档：覆盖基本面、技术面。");
    expect(String(call.prompt)).toContain("DO：围绕被分配的目标主动推进，覆盖基本面、技术面");
  });

  it("reuses an active same-name joi partner instead of creating a duplicate", async () => {
    const existing = { ...partnerDto, createdBy: "joi" as const };
    const harness = makeTools({ partners: [existing] });
    const created = await harness.call("partner_create", { displayName: "  Coder  " }) as { partnerId: string; reused?: boolean };
    expect(created).toMatchObject({ partnerId: "partner_1", partnerRevisionId: "partner_revision_1", reused: true });
    expect(harness.addCalls).toEqual([]);
  });

  it("does not reuse a partner whose settings require repair", async () => {
    const existing = {
      ...partnerDto,
      configuration: { reasonCodes: ["partner_skill_ref_invalid"], status: "ACTION_REQUIRED" as const },
      createdBy: "joi" as const,
    };
    const harness = makeTools({ partners: [existing] });
    await harness.call("partner_create", { displayName: "  Coder  " });
    expect(harness.addCalls).toHaveLength(1);
  });

  it("reuses an active partner whose cluster key matches after stripping one-off model tokens", async () => {
    const existing = { ...partnerDto, createdBy: "user" as const, displayName: "模型调研搭档" };
    const harness = makeTools({ partners: [existing] });
    const created = await harness.call("partner_create", { displayName: "Grok4.6 模型调研搭档" }) as { partnerId: string; reused?: boolean };
    expect(created).toMatchObject({ partnerId: "partner_1", partnerRevisionId: "partner_revision_1", reused: true });
    expect(harness.addCalls).toEqual([]);
  });

  it("rejects hallucinated coding tools before persisting a partner", async () => {
    const harness = makeTools();
    await expect(harness.call("partner_create", {
      displayName: "Researcher", tools: ["afs1_client", "read"],
    })).rejects.toMatchObject({ code: "partner_tool_not_allowed" });
    expect(harness.addCalls).toEqual([]);
  });

  it("allows the built-in public web tools for a research partner", async () => {
    const harness = makeTools();
    await harness.call("partner_create", {
      description: "读取公开网页资料",
      displayName: "网页调研搭档",
      prompt: "只研究公开来源",
      tools: ["web_search", "fetch_content", "get_search_content"],
    });
    expect(harness.addCalls[0]).toMatchObject({
      tools: ["web_search", "fetch_content", "get_search_content"],
    });
  });

  it("lists only READY model sources with the fields partner_create needs", async () => {
    const harness = makeTools();
    const sources = await harness.call("model_list_sources", {}) as unknown[];
    expect(sources).toEqual([{ displayName: "Kimi", kind: "kimi", modelId: "kimi-k2.5", primary: true, protocol: "anthropic", sourceId: "source_ready" }]);
  });

  it("switches a partner to a READY model source by creating a new immutable partner revision", async () => {
    const harness = makeTools();
    await expect(harness.call("partner_set_model", {
      modelId: "kimi-k2.5", partnerId: "partner_1", sourceId: "source_ready",
    })).resolves.toMatchObject({ modelIdOverride: "kimi-k2.5", modelSourceId: "source_ready", partnerId: "partner_1" });
    expect(harness.setModelCalls).toEqual([{
      model: { modelIdOverride: "kimi-k2.5", modelSourceId: "source_ready" }, partnerId: "partner_1",
    }]);
    await expect(harness.call("partner_set_model", {
      modelId: "draft", partnerId: "partner_1", sourceId: "source_draft",
    })).rejects.toMatchObject({ code: "partner_model_source_not_ready" });
  });

  it("creates, lists and disposes partner instances with explicit session policies", async () => {
    const harness = makeTools();
    const instance = await harness.call("partner_create_instance", { partnerId: "partner_1", sessionPolicy: "resident" });
    expect(harness.ensureCalls[0]).toMatchObject({ partnerId: "partner_1", sessionPolicy: "RESIDENT" });
    expect(instance).toMatchObject({ instanceId: "instance_1", sessionPolicy: "RESIDENT" });

    const listed = await harness.call("partner_list_instances", { partnerId: "partner_1" }) as unknown[];
    expect(listed).toHaveLength(1);

    await harness.call("partner_dispose_instance", { instanceId: "instance_1" });
    expect(harness.disposeCalls[0]).toEqual({ instanceId: "instance_1", reason: "joi disposed the instance" });
  });

  it("enriches partner_list_available with live instances and the working-memory digest", async () => {
    const harness = makeTools();
    const listed = await harness.call("partner_list_available", {}) as { activeInstanceCount: number; instances: unknown[]; memoryDigest: { summary: string } }[];
    expect(listed[0]).toMatchObject({
      activeInstanceCount: 1,
      displayName: "Coder",
      memoryDigest: { summary: "DIGEST_SUMMARY" },
      partnerId: "partner_1",
    });
    expect(listed[0]?.instances).toHaveLength(1);
    expect(listed[0]).toMatchObject({ toolCount: 1 });
    expect(listed[0]).not.toHaveProperty("tools");
  });

  it("inspects one redacted partner revision", async () => {
    const harness = makeTools();
    const inspected = await harness.call("partner_inspect_revision", { partnerId: "partner_1" }) as Record<string, unknown>;
    expect(inspected).toMatchObject({ displayName: "Coder", partnerId: "partner_1", toolCount: 1 });
    expect(inspected).not.toHaveProperty("tools");
  });

  it("forwards an existing instance without adding a competing session policy", async () => {
    const harness = makeTools();
    await harness.call("work_dispatch", {
      dependencies: [],
      work: [{
        acceptanceChecks: [{ expectedText: "hellow", kind: "FILE_CONTAINS_EXACT", relativePath: "hello.txt" }],
        accessMode: "WRITE", instanceId: "instance_1", instructions: "写入用户要求的原始拼写", key: "w1",
        partnerId: "partner_1", title: "继续上次的会话",
      }],
    });
    const call = harness.planCalls[0] as { inputId?: string; work: { instanceId?: string; sessionPolicy?: string }[] };
    expect(call.inputId).toBe("input_1");
    const planned = call.work;
    expect(planned[0]).toMatchObject({
      acceptanceChecks: [{ expectedText: "hellow", kind: "FILE_CONTAINS_EXACT", relativePath: "hello.txt" }],
      instanceId: "instance_1", instructions: "写入用户要求的原始拼写",
    });
    expect(planned[0]).not.toHaveProperty("sessionPolicy");
  });

  it("AC-WR-07 offers one access correction without a user clarification", async () => {
    const harness = makeTools({ planError: new DomainError("work_execution_access_conflict", "fixture") });
    const args = { work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], executionNeeds: ["SHELL"], accessMode: "READ", key: "w", partnerId: "p", title: "verify" }] };
    await expect(harness.call("work_dispatch",args)).resolves.toMatchObject({ status: "RETRY_REQUIRED",reasonCode: "work_execution_access_conflict" });
    await expect(harness.call("work_dispatch",args)).resolves.toMatchObject({ status: "FAILED",reasonCode: "work_execution_access_conflict" });
    expect(harness.clarificationCalls).toEqual([]);
  });

  it("AC-WR-07 accepts a corrected WRITE dispatch with explicit execution needs", async () => {
    const options: { planError?: Error } = { planError: new DomainError("work_execution_access_conflict","fixture") };
    const harness = makeTools(options);
    const item = { acceptanceChecks: [{ kind: "BODY_PRESENT" }],executionNeeds: ["SHELL","FILE_WRITE"],accessMode: "READ",key: "w",partnerId: "p",title: "report" };
    await expect(harness.call("work_dispatch",{ work: [item] })).resolves.toMatchObject({ status: "RETRY_REQUIRED" });
    delete options.planError;
    await expect(harness.call("work_dispatch",{ work: [{ ...item,accessMode: "WRITE" }] })).resolves.toMatchObject({ dispatchPlanId: "plan_1" });
    expect((harness.planCalls[1] as { work: unknown[] }).work[0]).toMatchObject({ accessMode: "WRITE",executionNeeds: ["SHELL","FILE_WRITE"] });
    expect(harness.clarificationCalls).toEqual([]);
  });

  it("tolerates omitted dependencies when a model dispatches an edge-free DAG", async () => {
    // glm-style models drop empty required arrays; a failed argument validation
    // aborts the whole Turn (pi-ai validateToolArguments throws), so both the
    // schema and the execution path must accept the missing field.
    const harness = makeTools();
    const args = { work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], executionNeeds: ["FILE_WRITE"], accessMode: "WRITE", key: "w1", partnerId: "partner_1", title: "落实修复" }] };
    // Schema accepts the omission; the execute path coerces it to [].
    await expect(harness.validate("work_dispatch", args)).resolves.toEqual(args);
    await harness.call("work_dispatch", args);
    expect(harness.planCalls).toHaveLength(1);
    expect((harness.planCalls[0] as { dependencies?: unknown }).dependencies).toEqual([]);
  });

  it("lets joi expand a local partner to all bounded built-in tools", async () => {
    const harness = makeTools();
    await expect(harness.call("partner_set_tools", { partnerId: "partner_1", tools: [] }))
      .resolves.toMatchObject({ partnerId: "partner_1", tools: [] });
    expect(harness.setToolsCalls).toEqual([{ partnerId: "partner_1", tools: [] }]);
  });

  it("mechanically drops an instance reference from one-shot ephemeral work", async () => {
    const harness = makeTools();
    await harness.call("work_dispatch", {
      dependencies: [],
      work: [{
        accessMode: "READ", instanceId: "stale-instance", key: "w1", partnerId: "partner_1",
        sessionPolicy: "ephemeral", title: "一次性分析",
      }],
    });
    const planned = (harness.planCalls[0] as { work: Record<string, unknown>[] }).work[0];
    expect(planned).toMatchObject({ partnerId: "partner_1", sessionPolicy: "EPHEMERAL" });
    expect(planned).not.toHaveProperty("instanceId");
    expect(harness.clarificationCalls).toEqual([]);
  });

  it("persists a concrete blocking question through user_ask", async () => {
    const harness = makeTools();
    await harness.call("user_ask", { question: "验收必须覆盖哪些浏览器？" });
    expect(harness.clarificationCalls).toEqual([{
      inputId: "input_1", prompt: "验收必须覆盖哪些浏览器？", reasonCode: "question_required",
    }]);
  });

  it("opens a goal only through the versioned recovery turn", async () => {
    const resumeCalls: { inputId: string; turnId: string }[] = [];
    const harness = makeTools({ inputId: "joi_goal_resume:goal:goal-1:v2", resumeCalls });
    await expect(harness.call("goal_resume", {})).resolves.toEqual({ status: "OPEN" });
    expect(resumeCalls).toEqual([{ inputId: "joi_goal_resume:goal:goal-1:v2", turnId: "turn_1" }]);
  });

  it.each(["input_1", "joi_harness_review:goal:goal-1:r2:q1", "joi_harness_review:goal:goal-1:r2:q1:resume:2026-10-28T10:00:00.000Z"])(
    "does not expose goal_resume outside its matching recovery input: %s", (inputId) => {
      const harness = makeTools({ inputId, resumeCalls: [] });
      expect(harness.tools.map(tool => tool.name)).not.toContain("goal_resume");
    },
  );

  it.each(["goal_resume_not_allowed", "goal_resume_conflict"])("proves a transactional resume rejection is safe: %s", async code => {
    const harness = makeTools({ inputId: "joi_goal_resume:goal:goal-1:v2", resumeCalls: [], resumeError: new DomainError(code, "Rejected") });
    const tool = harness.tools.find(candidate => candidate.name === "goal_resume");
    const output = await tool?.execute("resume-rejected", {});
    expect(output).toMatchObject({ isError: true, details: { replaySafeRejection: true } });
    expect(output?.content).toEqual([{ type: "text", text: JSON.stringify({ reasonCode: code, status: "REJECTED" }) }]);
  });

  it("does not classify an unknown resume error as a safe rejection", async () => {
    const error = new Error("storage_failed");
    const harness = makeTools({ inputId: "joi_goal_resume:goal:goal-1:v2", resumeCalls: [], resumeError: error });
    const tool = harness.tools.find(candidate => candidate.name === "goal_resume");
    await expect(tool?.execute("resume-unknown", {})).rejects.toBe(error);
  });

  it("preserves a resolved action id when resuming waiting work", async () => {
    const workResumeCalls: Record<string, unknown>[] = [];
    const harness = makeTools({ workResumeCalls });
    await harness.call("work_resume", { requirementIds: [], allRequirements: false, actionId: "attention-1", instructions: "按用户确认，以 bot 身份只回复 T25。", workId: "work-1" });
    expect(workResumeCalls).toEqual([{
      requirementIds: [], allRequirements: false, actionId: "attention-1", instructions: "按用户确认，以 bot 身份只回复 T25。", turnId: "turn_1", workbenchId: "workbench_1", workId: "work-1",
    }]);
  });

  it("marks a tool-using direct response as an explicit completed outcome", async () => {
    const harness = makeTools();
    await expect(harness.call("turn_complete", { outcome: "DIRECT_ANSWER" })).resolves.toEqual({
      outcome: "DIRECT_ANSWER", status: "COMMITTED",
    });
  });

  it("turns a workspace-blocked dispatch into a resumable clarification", async () => {
    const harness = makeTools({ workspaceBlocked: true });
    const result = await harness.call("work_dispatch", {
      dependencies: [],
      work: [{ accessMode: "WRITE", key: "w1", partnerId: "partner_1", title: "修改工程" }],
    });
    expect(result).toEqual({ reasonCode: "workbench_workspace_not_ready", status: "CLARIFICATION_REQUIRED" });
    expect(harness.clarificationCalls).toEqual([{
      inputId: "input_1",
      prompt: "选择这个 Workbench 的工作目录后，我会继续派发需要读写文件的工作。",
      reasonCode: "workbench_workspace_not_ready",
    }]);
  });

  it("supports BODY_PRESENT for text-only partner deliverables", async () => {
    const harness = makeTools();
    await harness.call("work_dispatch", {
      dependencies: [],
      work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", key: "research", partnerId: "partner_1", title: "研究" }],
    });
    expect((harness.planCalls[0] as { work?: unknown }).work).toEqual([expect.objectContaining({ acceptanceChecks: [{ kind: "BODY_PRESENT" }] })]);
  });

  it("keeps a missing partner's first correction inside the Turn", async () => {
    const harness = makeTools({ planError: new DomainError("partner_not_found", "private detail") });
    const result = await harness.call("work_dispatch", {
      dependencies: [],
      work: [{ accessMode: "READ", key: "w1", partnerId: "partner_1", title: "读取工程" }],
    });
    expect(result).toMatchObject({ reasonCode: "partner_not_found", status: "RETRY_REQUIRED" });
    expect(result).toHaveProperty("hint", expect.stringContaining("partner_list_available"));
    expect(harness.clarificationCalls).toEqual([]);
  });

  it("creates an independent bounded supplemental Work for a failed Work", async () => {
    const harness = makeTools();
    await expect(harness.call("work_supplement", {
      acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", partnerId: "partner_1",
      sourceWorkId: "failed-work", strategy: "SUPPLEMENT", title: "补齐报告",
    })).resolves.toMatchObject({ attemptNo: 1, dispatchPlanId: "plan_recovery", evidenceResultIds: ["result_1"] });
  });

  it("treats an unknown historical dependency as a bounded self-correction", async () => {
    const harness = makeTools({ planError: new DomainError("work_dependency_unknown", "private detail") });
    const result = await harness.call("work_dispatch", {
      dependencies: [{ dependsOnKey: "historical-work", workKey: "supplement" }],
      work: [{ accessMode: "READ", key: "supplement", partnerId: "partner_1", title: "补充缺失交付物" }],
    });
    expect(result).toEqual({ reasonCode: "work_dependency_unknown", status: "RETRY_REQUIRED" });
    expect(harness.clarificationCalls).toEqual([]);
  });

  it("commits an explicitly blocked goal synthesis outcome", async () => {
    const harness = makeTools({ goalInputId: "goal-1", inputId: "joi_result_input:goal:goal-1" });

    await expect(harness.call("turn_complete", { outcome: "RESULT_BLOCKED" })).resolves.toEqual({
      outcome: "RESULT_BLOCKED",
      status: "COMMITTED",
    });
  });

  it("commits a non-blocking request for another evidence layer", async () => {
    const harness = makeTools({ goalInputId: "goal-1", inputId: "joi_result_input:goal:goal-1" });

    await expect(harness.call("turn_complete", { outcome: "RESULT_CONTINUE" })).resolves.toEqual({
      outcome: "RESULT_CONTINUE",
      status: "COMMITTED",
    });
  });

  it("rejects result dispositions outside a goal synthesis Turn", async () => {
    await expect(makeTools().call("turn_complete", { outcome: "RESULT_BLOCKED" }))
      .rejects.toMatchObject({ code: "goal_synthesis_outcome_not_allowed" });
    await expect(makeTools().call("turn_complete", { outcome: "RESULT_CONTINUE" }))
      .rejects.toMatchObject({ code: "goal_synthesis_outcome_not_allowed" });
  });

  it.each(["partner_not_found", "partner_not_available", "partner_instance_unavailable", "partner_instance_partner_mismatch"])(
    "returns %s as a bounded retry request without creating a clarification",
    async (reasonCode) => {
      const harness = makeTools({ planError: new DomainError(reasonCode, "private detail") });
      const response = await harness.call("work_dispatch", {
        dependencies: [],
        work: [{ accessMode: "READ", key: "w1", partnerId: "partner_1", title: "读取工程" }],
      });
      expect(response).toMatchObject({ reasonCode, status: "RETRY_REQUIRED" });
      expect(harness.clarificationCalls).toEqual([]);
    },
  );

  it.each(["partner_not_found", "partner_not_available"])("offers at most one automatic dispatch correction for %s in a Turn", async (reasonCode) => {
    const harness = makeTools({ planError: new DomainError(reasonCode, "private detail") });
    const input = { dependencies: [], work: [{ accessMode: "READ", key: "w1", partnerId: "partner_1", title: "读取工程" }] };
    await expect(harness.call("work_dispatch", input)).resolves.toMatchObject({ reasonCode, status: "RETRY_REQUIRED" });
    await expect(harness.call("work_dispatch", input)).resolves.toEqual({ reasonCode: "partner_selection_required", status: "CLARIFICATION_REQUIRED" });
    expect(harness.clarificationCalls).toEqual([expect.objectContaining({
      reasonCode: "partner_selection_required",
    })]);
  });

  it("lets a recovery Turn call goal_resume after an early dispatch hits the closed gate", async () => {
    const harness = makeTools({
      inputId: "joi_goal_resume:goal:goal-1:v2",
      goalInputId: "goal-1",
      planError: new DomainError("goal_execution_paused", "private detail"),
      resumeCalls: [],
    });
    await expect(harness.call("work_dispatch", {
      dependencies: [],
      work: [{ accessMode: "READ", key: "w1", partnerId: "partner_1", title: "补充证据" }],
    })).resolves.toEqual({
      hint: "Call goal_resume first, then retry this dispatch once the goal gate is open.",
      reasonCode: "goal_execution_paused",
      status: "RETRY_REQUIRED",
    });
    expect(harness.clarificationCalls).toEqual([]);
    await expect(harness.call("goal_resume", {})).resolves.toMatchObject({ status: "OPEN" });
  });

  it("documents that instanceId is an exact queried instance and is mutually exclusive with sessionPolicy", () => {
    const tool = makeTools().tools.find((candidate) => candidate.name === "work_dispatch");
    expect(tool?.description).toContain("exact instance id returned by partner_list_available or partner_list_instances");
    expect(tool?.description).toContain("Never pass instanceId together with sessionPolicy");
    expect(tool?.description).toContain("current invocation");
  });

  it("parses the goal input id out of synthetic input prefixes", () => {
    expect(goalFromInputIdPrefix("joi_result_input:goal:goal-1")).toBe("goal-1");
    expect(goalFromInputIdPrefix("joi_result_input:goal:goal-1:r7:q2")).toBe("goal-1");
    expect(goalFromInputIdPrefix("joi_result_input:goal:goal-1:resume:1792370000000")).toBe("goal-1");
    expect(goalFromInputIdPrefix("joi_result_input:goal:goal-1:r7:q2:resume:1792370000000")).toBe("goal-1");
    expect(goalFromInputIdPrefix("joi_harness_review:goal:goal-1:r3")).toBe("goal-1");
    expect(goalFromInputIdPrefix(harnessReviewInputId("goal-1", 3, 2, "2026-10-27T10:00:00.000Z"))).toBe("goal-1");
    expect(goalFromInputIdPrefix("plain-input")).toBeUndefined();
    expect(goalFromInputIdPrefix("joi_signal_input:sig-1")).toBeUndefined();
  });

  it.each(["joi_harness_review:goal:goal-1:r1", harnessReviewInputId("goal-1", 1, 0, "2026-10-27T10:00:00.000Z")])("binds work dispatched from review %s back to the original goal", async (inputId) => {
    const harness = makeTools({
      goalInputId: goalFromInputIdPrefix(inputId) ?? inputId,
      inputId,
    });
    await harness.call("work_dispatch", {
      dependencies: [],
      work: [{ accessMode: "READ", key: "w1", partnerId: "partner_1", title: "下一层工作" }],
    });
    const call = harness.planCalls[0] as { inputId?: string };
    expect(call.inputId).toBe("goal-1");
  });

  it("writes harness map artifacts against the goal context", async () => {
    const recorder: HarnessRecorder = { calls: [] };
    const harness = makeTools({ goalInputId: "goal-1", harness: recorder, inputId: "joi_harness_review:goal:goal-1:r1" });
    await harness.call("harness_name_destination", { destination: "完成股票分析" });
    await harness.call("harness_chart_path", { open: { layer: 2, title: "深入财报" } });
    await harness.call("harness_chart_path", { close: { pathId: "path_9", status: "CLOSED" } });
    await harness.call("harness_record_decision", { closePathId: "path_9", summary: "采用财报路线" });
    await harness.call("harness_note_fog", { note: "数据源未定" });
    await harness.call("harness_note_fog", { graduate: { fogId: "fog_1", graduateTitle: "确认数据源" } });
    expect(recorder.calls.map((entry) => entry.method)).toEqual([
      "nameDestination", "chartPath", "chartPath", "recordDecision", "noteFog", "graduateFog",
    ]);
    for (const entry of recorder.calls) {
      expect(entry.args.goalInputId).toBe("goal-1");
    }
    expect(recorder.calls[5]?.args).toMatchObject({ layer: 1, title: "确认数据源" });
  });

  it("falls back to the current input as the goal context for direct goal turns", async () => {
    const recorder: HarnessRecorder = { calls: [] };
    const harness = makeTools({ harness: recorder });
    await harness.call("harness_name_destination", { destination: "首轮目标" });
    expect(recorder.calls[0]?.args.goalInputId).toBe("input_1");
  });

  it("rejects harness chart and fog calls without exactly one mode", async () => {
    const harness = makeTools();
    await expect(harness.call("harness_chart_path", {})).rejects.toMatchObject({ code: "harness_path_invalid" });
    await expect(harness.call("harness_chart_path", {
      close: { pathId: "p", status: "CLOSED" }, open: { layer: 1, title: "t" },
    })).rejects.toMatchObject({ code: "harness_path_invalid" });
    await expect(harness.call("harness_note_fog", {})).rejects.toMatchObject({ code: "harness_fog_invalid" });
  });

  it("does not expose autonomous persona or scope mutation", () => {
    const recorder: HarnessRecorder = { calls: [] };
    const refineCalls = { args: [] as { workbenchId: string; input: Record<string, unknown> }[] };
    const harness = makeTools({ goalInputId: "goal-1", harness: recorder, refineCalls });
    expect(harness.tools.map((tool) => tool.name)).not.toContain("harness_refine_workbench");
    expect(refineCalls.args).toEqual([]);
  });

  it("lets only a harness review turn clear the goal map", async () => {
    const recorder: HarnessRecorder = { calls: [] };
    const reviewHarness = makeTools({ goalInputId: "goal-1", harness: recorder, inputId: "joi_harness_review:goal:goal-1:r1" });
    await expect(reviewHarness.call("turn_complete", { outcome: "MAP_CLEARED" }))
      .resolves.toEqual({ cleared: true, outcome: "MAP_CLEARED", status: "COMMITTED" });
    expect(recorder.calls).toEqual([{ args: { goalInputId: "goal-1", turnId: "turn_1" }, method: "clearMap" }]);
    const plainHarness = makeTools({ harness: { calls: [] } });
    await expect(plainHarness.call("turn_complete", { outcome: "MAP_CLEARED" }))
      .rejects.toMatchObject({ code: "harness_clear_not_allowed" });
    const incompleteHarness = makeTools({ clearMapResult: false, goalInputId: "goal-1", harness: { calls: [] }, inputId: "joi_harness_review:goal:goal-1:r1" });
    await expect(incompleteHarness.call("turn_complete", { outcome: "MAP_CLEARED" }))
      .rejects.toMatchObject({ code: "harness_clear_preconditions_unmet" });
  });

  it("reads attachment text in bounded chunks with a continuation cursor", async () => {
    const encoder = new TextEncoder();
    const body = `${"A".repeat(8_000)}${"B".repeat(8_000)}tail`;
    const harness = makeTools({
      attachmentIds: ["att_1"],
      attachments: { read: async () => ({ bytes: encoder.encode(body), filename: "long.txt", mimeType: "text/plain" }) },
    });
    const first = await harness.call("attachment_read", { attachmentId: "att_1" }) as Record<string, unknown>;
    expect(first).toMatchObject({ attachmentId: "att_1", content: "A".repeat(8_000), filename: "long.txt", nextCursor: "8000" });
    const second = await harness.call("attachment_read", { attachmentId: "att_1", cursor: "8000" }) as Record<string, unknown>;
    expect(second).toMatchObject({ content: "B".repeat(8_000), nextCursor: "16000" });
    const last = await harness.call("attachment_read", { attachmentId: "att_1", cursor: "16000" }) as Record<string, unknown>;
    expect(last).toMatchObject({ attachmentId: "att_1", content: "tail" });
    expect(last).not.toHaveProperty("nextCursor");
  });

  it("rejects out-of-scope and missing attachments with the same code and validates cursors", async () => {
    const encoder = new TextEncoder();
    const harness = makeTools({
      attachmentIds: ["att_1"],
      attachments: {
        read: async (attachmentId) => {
          if (attachmentId !== "att_1") throw new DomainError("joi_attachment_not_found", "missing");
          return { bytes: encoder.encode("body"), filename: "a.txt", mimeType: "text/plain" };
        },
      },
    });
    await expect(harness.call("attachment_read", { attachmentId: "att_other" }))
      .rejects.toMatchObject({ code: "joi_attachment_not_found" });
    await expect(harness.call("attachment_read", { attachmentId: "att_1", cursor: "-1" }))
      .rejects.toMatchObject({ code: "attachment_cursor_invalid" });
    await expect(harness.call("attachment_read", { attachmentId: "att_1", cursor: "01" }))
      .rejects.toMatchObject({ code: "attachment_cursor_invalid" });
  });

  it("reports NOT_TEXT for binary attachments instead of erroring", async () => {
    const harness = makeTools({
      attachmentIds: ["att_bin"],
      attachments: { read: async () => ({ bytes: new Uint8Array([0x7b, 0x00, 0x01]), filename: "blob.bin", mimeType: "application/octet-stream" }) },
    });
    await expect(harness.call("attachment_read", { attachmentId: "att_bin" }))
      .resolves.toEqual({ attachmentId: "att_bin", reasonCode: "attachment_content_not_text", status: "NOT_TEXT" });
  });

  it("registers attachment_read only when the turn input carries attachments", () => {
    expect(makeTools().tools.map((tool) => tool.name)).not.toContain("attachment_read");
    expect(makeTools({ attachments: { read: async () => ({ bytes: new Uint8Array(), filename: "x", mimeType: "text/plain" }) } })
      .tools.map((tool) => tool.name)).not.toContain("attachment_read");
    expect(makeTools({ attachmentIds: ["att_1"] }).tools.map((tool) => tool.name)).not.toContain("attachment_read");
    expect(makeTools({
      attachmentIds: ["att_1"],
      attachments: { read: async () => ({ bytes: new Uint8Array(), filename: "x", mimeType: "text/plain" }) },
    }).tools.map((tool) => tool.name)).toContain("attachment_read");
  });
});


describe("AC-43/48 evidence tools", () => {
  it("records only stable read provenance after a full result succeeds", async () => {
    const record = vi.fn<(receipt: MethodEvidenceRead) => void>();
    const harness = makeTools({ goalInputId: "original", inputId: "derived", recordEvidenceRead: record });
    expect(await harness.call("work_read_result", { resultId: "immutable-result", cursor: "8000" })).toEqual({ content: "result", resultId: "immutable-result" });
    expect(record.mock.calls).toEqual([[{ workbenchId: "workbench_1", goalId: "original", turnId: "turn_1",
      toolCallId: "tool_call_1", tool: "work_read_result", resultId: "immutable-result", cursor: "8000", mode: null }]]);
  });
  it.each(["handoff", "conclusion", "state"] as const)("records an immutable %s read without content", async (mode) => {
    const record = vi.fn<(receipt: MethodEvidenceRead) => void>();
    const harness = makeTools({ recordEvidenceRead: record });
    await harness.call("work_read_evidence", { mode, ...(mode === "handoff" ? { resultId: "result" } : { outcomeId: "r6:q2" }) });
    expect(record.mock.calls).toEqual([[{ workbenchId: "workbench_1", goalId: "input_1", turnId: "turn_1",
      toolCallId: "tool_call_1", tool: "work_read_evidence", resultId: mode === "handoff" ? "result" : "r6:q2", cursor: null, mode }]]);
  });
  it("does not record unsuccessful or unversioned reads", async () => {
    const record = vi.fn<(receipt: MethodEvidenceRead) => void>();
    const error = new DomainError("goal_evidence_not_found", "Unavailable.");
    const failed = makeTools({ recordEvidenceRead: record, resultReadError: error, evidenceReadError: error });
    await expect(failed.call("work_read_result", { resultId: "missing" })).rejects.toBe(error);
    for (const mode of ["handoff", "conclusion", "state"]) await expect(failed.call("work_read_evidence", {
      mode, resultId: "missing", outcomeId: "missing",
    })).rejects.toBe(error);
    const harness = makeTools({ recordEvidenceRead: record });
    await harness.call("work_read_evidence", {});
    await harness.call("work_read_evidence", { mode: "index", cursor: "next-page" });
    await harness.call("work_read_evidence", { mode: "changes", resultRevision: 7, requirementsRevision: 2, afterResultRevision: 6 });
    expect(record).not.toHaveBeenCalled();
  });
  it("keeps successful foreground results unchanged when recording fails", async () => {
    const record = vi.fn(() => { throw new Error("unavailable recorder"); });
    const harness = makeTools({ recordEvidenceRead: record });
    await expect(harness.call("work_read_result", { resultId: "result" })).resolves.toEqual({ content: "result", resultId: "result" });
    await expect(harness.call("work_read_evidence", { mode: "handoff", resultId: "result" })).resolves.toMatchObject({ content: "handoff" });
    expect(record).toHaveBeenCalledTimes(2);
  });
  it("passes semantic evidence modes, scope, versions and opaque cursors through the production factory",async () => {
    const harness = makeTools({ inputId: "joi_result_input:goal:original:r7:q2",goalInputId: "original" });
    await harness.call("work_read_evidence",{ mode: "handoff",resultId: "result",cursor: "c1:handoff" });
    await harness.call("work_read_evidence",{ mode: "state",outcomeId: "r6:q2",cursor: "c1:state" });
    await harness.call("work_read_evidence",{ mode: "changes",resultRevision: 7,requirementsRevision: 2,afterResultRevision: 6,afterUpdatedAt: "2026-10-19",cursor: "d1:changes" });
    expect(harness.evidenceCalls).toEqual([
      { goalInputId: "original",workbenchId: "workbench_1",resultId: "result",cursor: "c1:handoff" },
      { goalInputId: "original",workbenchId: "workbench_1",outcomeId: "r6:q2",cursor: "c1:state" },
      { goalInputId: "original",workbenchId: "workbench_1",resultRevision: 7,requirementsRevision: 2,afterResultRevision: 6,afterUpdatedAt: "2026-10-19",cursor: "d1:changes" },
    ]);
    await expect(harness.call("work_read_evidence",{ mode: "changes",resultRevision: 7,requirementsRevision: 2 })).rejects.toMatchObject({ code: "goal_evidence_revision_invalid" });
  });

  it("keeps synthesis state private in tool details and rejects it on ordinary inputs",async () => {
    const state = { version: 1,claims: [{ statement: "PRIVATE_SYNTHESIS_STATE",requirementIds: ["requirement"],resultIds: ["result"] }],unresolved: [],conflicts: [] };
    const synthesis = makeTools({ inputId: "joi_result_input:goal:original:r7:q2",goalInputId: "original" });
    const tool = synthesis.tools.find(value => value.name === "turn_complete");
    if (tool === undefined) throw new Error("Missing completion tool.");
    const output = await tool.execute("complete",{ outcome: "RESULT_CONTINUE",synthesisState: state });
    expect(output.details).toEqual({ synthesisState: state });
    expect(JSON.stringify(output.content)).not.toContain("PRIVATE_SYNTHESIS_STATE");
    expect(JSON.stringify(output.content)).toContain("COMMITTED");
    await expect(makeTools().call("turn_complete",{ outcome: "DIRECT_ANSWER",synthesisState: state })).rejects.toMatchObject({ code: "goal_synthesis_state_invalid" });
  });

  it("scopes historical index and conclusion pages to the original goal", async () => {
    const harness = makeTools({ inputId: "joi_result_input:goal:original:r7:q2",goalInputId: "original" });
    await harness.call("work_read_evidence", { cursor: "8000" });
    await harness.call("work_read_evidence", { mode: "conclusion",outcomeId: "r6:q2" });
    expect(harness.evidenceCalls).toEqual([
      { goalInputId: "original",workbenchId: "workbench_1",cursor: "8000" },
      { goalInputId: "original",workbenchId: "workbench_1",outcomeId: "r6:q2" },
    ]);
  });
  it("persists explicit citations from dispatch and resume parameters", async () => {
    const resume: unknown[] = [];
    const harness = makeTools({ workResumeCalls: resume as Record<string, unknown>[] });
    await harness.call("work_dispatch", { work: [{ key: "one",title: "Read",partnerId: "partner_1",accessMode: "NONE",executionNeeds: [],evidenceResultIds: ["r81"],instructions: "Read the cited middle result.",acceptanceChecks: [{ kind: "BODY_PRESENT" }] }] });
    expect(harness.planCalls[0]).toMatchObject({ work: [{ evidenceResultIds: ["r81"] }] });
    await harness.call("work_resume", { workId: "waiting",evidenceResultIds: ["r81"],instructions: "Continue with the cited evidence." });
    expect(resume[0]).toMatchObject({ evidenceResultIds: ["r81"] });
  });
});
