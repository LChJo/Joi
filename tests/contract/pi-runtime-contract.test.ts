/* Test doubles implement asynchronous Pi contracts with deterministic immediate values. */
/* eslint-disable @typescript-eslint/require-await */
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

import type {
  JoiReasoningSessionSnapshot,
  ReasoningSessionStore,
} from "../../src/main/application/ports/primary-reasoning-runtime.js";
import {
  JOI_REASONING_TOOL_NAMES,
  PiReasoningRuntime,
} from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import {
  MODEL_SOURCE_OPTIONS,
  MODEL_SOURCE_PRESETS,
} from "../../src/main/infrastructure/pi/provider-presets.js";
import { boundRequestByChars, modelContextMaxChars } from "../../src/main/infrastructure/pi/pi-model-budget.js";
import { createPiSourceProvider } from "../../src/main/infrastructure/pi/source-provider-factory.js";
import { ConfiguredPiReasoningRuntime } from "../../src/main/infrastructure/pi/configured-pi-reasoning-runtime.js";
import { JoiSkillRuntime } from "../../src/main/infrastructure/pi/joi-skill-runtime.js";

class MemorySessionStore implements ReasoningSessionStore {
  readonly snapshots = new Map<string, JoiReasoningSessionSnapshot>();

  async load(sessionId: string): Promise<JoiReasoningSessionSnapshot | null> {
    return this.snapshots.get(sessionId) ?? null;
  }

  async save(snapshot: JoiReasoningSessionSnapshot): Promise<void> {
    this.snapshots.set(snapshot.sessionId, structuredClone(snapshot));
  }
}

class MemoryCredentialStore implements CredentialStore {
  readonly credentials = new Map<string, Credential>();

  async read(providerId: string): Promise<Credential | undefined> { return this.credentials.get(providerId); }
  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const next = await fn(this.credentials.get(providerId));
    if (next !== undefined) this.credentials.set(providerId, next);
    return next;
  }
  async delete(providerId: string): Promise<void> { this.credentials.delete(providerId); }
}

describe("Pi reasoning runtime contract", () => {
  it("loads selected main Skills into cached sessions and refreshes them on the next turn", async () => {
    const faux = fauxProvider({ provider: "joi-selected-skills" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("joi_read_skill", { skillId: "agents/example" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Skill read.")]),
      fauxAssistantMessage([fauxText("No selected skills.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let joiSkills = ["agents/example"];
    const readInstructions = vi.fn(() => "private skill body");
    const store = new MemorySessionStore();
    const resolve = vi.fn(async () => ({ model: faux.getModel(), models }));
    const runtime = new ConfiguredPiReasoningRuntime({
      resolver: { resolve }, sessionStore: store, tools: [],
      skills: new JoiSkillRuntime({
        catalog: { listForEngine: () => [{ id: "agents/example", displayName: "example" }], validateRefs: () => undefined, readInstructions },
        settings: { get: async () => ({ joiSkills }) },
      }),
    });
    const events: unknown[] = [];
    const input = {
      workbenchId: "workbench_skills", inputId: "input_skills", modelId: "model", modelRevisionId: "model_rev",
      prompt: "Use the selected skill", sessionId: "session_skills", sourceId: "source", sourceRevisionId: "source_rev",
      systemPrompt: "You are Joi.", turnId: "turn_skills",
      onEvent: (event: unknown) => { events.push(event); },
    };
    await runtime.startTurn(input);
    expect(readInstructions).toHaveBeenCalledWith(["agents/example"]);
    expect(store.snapshots.get(input.sessionId)?.systemPrompt).toContain("agents/example");
    expect(store.snapshots.get(input.sessionId)?.systemPrompt).not.toContain("private skill body");
    expect(JSON.stringify(events)).not.toContain("private skill body");
    joiSkills = [];
    await runtime.startTurn({ ...input, turnId: "turn_without_skills" });
    expect(store.snapshots.get(input.sessionId)?.systemPrompt).toBe(input.systemPrompt);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(readInstructions).toHaveBeenCalledTimes(1);
  });

  it.each(["DIRECT_ANSWER", "RESULT_CONTINUE", "RESULT_BLOCKED"] as const)("projects the safe %s Turn outcome from a turn_complete result", async (committedOutcome) => {
    const faux = fauxProvider({ provider: "joi-turn-outcome" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn_complete", { outcome: committedOutcome })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("我是 Joi。")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const events: unknown[] = [];
    const runtime = new PiReasoningRuntime({
      model: faux.getModel(),
      models,
      sessionStore: new MemorySessionStore(),
      tools: [{
        description: "Commit a direct answer.",
        execute: async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ outcome: committedOutcome, privatePayload: "must-not-cross" }) }], details: {} }),
        label: "Complete Turn",
        name: "turn_complete",
        parameters: Type.Object({ outcome: Type.Literal(committedOutcome) }),
      }],
    });
    await runtime.startTurn({
      workbenchId: "workbench_1", inputId: "input_direct", modelId: "contract-model", modelRevisionId: "model_rev_1",
      onEvent: (event) => { if (event.type === "tool_finished") events.push(event); }, prompt: "你是谁", sessionId: "session_direct",
      sourceId: "contract-source", sourceRevisionId: "source_rev_1", systemPrompt: "You are joi.", turnId: "turn_direct",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      isError: false, outcome: committedOutcome, toolName: "turn_complete", turnId: "turn_direct", type: "tool_finished",
    });
    expect(JSON.stringify(events)).not.toContain("privatePayload");
  });

  it("ships provider-specific API and subscription presets plus one generic option", () => {
    expect([...new Set(MODEL_SOURCE_OPTIONS.map((option) => option.kind))]).toEqual([
      "kimi",
      "glm",
      "qwen",
      "doubao",
      "minimax",
      "deepseek",
      "generic-openai",
    ]);
    expect(MODEL_SOURCE_PRESETS).toHaveLength(20);
    expect(MODEL_SOURCE_PRESETS.filter((preset) => preset.accessMode === "coding-plan" && preset.protocol === "anthropic").map((preset) => preset.kind))
      .toEqual(["kimi", "glm", "qwen", "doubao", "minimax"]);
    expect(MODEL_SOURCE_PRESETS.find((preset) => (
      preset.kind === "kimi" && preset.accessMode === "coding-plan" && preset.protocol === "anthropic"
    ))?.models.map((entry) => entry.id)).toEqual(["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]);
    expect(MODEL_SOURCE_PRESETS.find((preset) => (
      preset.kind === "qwen" && preset.accessMode === "token-plan" && preset.protocol === "openai"
    ))?.endpoint).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    expect(MODEL_SOURCE_PRESETS.find((preset) => (
      preset.kind === "qwen" && preset.accessMode === "token-plan" && preset.protocol === "anthropic"
    ))?.endpoint).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic");
    for (const preset of MODEL_SOURCE_PRESETS) {
      expect(preset.endpoint).toMatch(/^https:\/\//u);
      expect(preset.defaultModelId.length).toBeGreaterThan(0);
      expect(preset.models.map((model) => model.id)).toContain(preset.defaultModelId);
      expect(preset.endpointEditable).toBe(false);
      expect(preset.presetVersion).toBe("2026-08-06");
    }
    expect(JSON.stringify(MODEL_SOURCE_OPTIONS)).not.toMatch(/openrouter|siliconflow|火山引擎方舟以外的转发|聚合平台/iu);
  });

  it("creates isolated Pi providers whose auth resolves only from the injected credential store", async () => {
    const credentials = new MemoryCredentialStore();
    const direct = createPiSourceProvider({ accessMode: "api", kind: "glm", modelId: "glm-4.7", protocol: "openai", sourceId: "source_a" });
    const generic = createPiSourceProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      displayName: "本机模型",
      kind: "generic-openai",
      modelId: "local-tool-model",
      protocol: "openai",
      sourceId: "source_b",
    });
    const models = createModels({
      authContext: { env: async () => "must-not-be-read", fileExists: async () => false },
      credentials,
    });
    models.setProvider(direct);
    models.setProvider(generic);

    expect(direct.id).toBe("joi-source:source_a");
    expect(direct.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(direct.getModels()[0]).toMatchObject({ id: "glm-4.7", provider: direct.id });
    expect(generic.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(await models.getAuth(direct.id)).toBeUndefined();

    credentials.credentials.set(direct.id, { key: "stored-test-key", type: "api_key" });
    expect(await models.getAuth(direct.id)).toMatchObject({ auth: { apiKey: "stored-test-key" }, source: "joi credential store" });
    expect(await models.getAuth(generic.id)).toMatchObject({ auth: {}, source: "keyless local source" });
  });

  it("uses Pi's Kimi Code Anthropic transport and required client identity", () => {
    const anthropic = createPiSourceProvider({
      accessMode: "coding-plan",
      kind: "kimi",
      modelId: "kimi-for-coding",
      protocol: "anthropic",
      sourceId: "kimi_code",
    });
    const openai = createPiSourceProvider({
      accessMode: "coding-plan",
      kind: "kimi",
      modelId: "kimi-for-coding",
      protocol: "openai",
      sourceId: "kimi_code_openai",
    });

    expect(anthropic.baseUrl).toBe("https://api.kimi.com/coding");
    expect(anthropic.headers).toMatchObject({ "User-Agent": "KimiCLI/1.5" });
    expect(anthropic.getModels()[0]).toMatchObject({
      api: "anthropic-messages",
      id: "kimi-for-coding",
      provider: "joi-source:kimi_code",
    });
    expect(openai.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(openai.headers).toMatchObject({ "User-Agent": "KimiCLI/1.5" });
    expect(openai.getModels()[0]).toMatchObject({ api: "openai-responses", provider: "joi-source:kimi_code_openai" });

    const k3 = createPiSourceProvider({
      accessMode: "coding-plan",
      kind: "kimi",
      modelId: "k3",
      protocol: "anthropic",
      sourceId: "kimi_k3",
    }).getModels()[0];
    expect(k3).toMatchObject({
      compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
      contextWindow: 1_048_576,
      id: "k3",
      maxTokens: 131_072,
      reasoning: true,
    });
  });

  it("streams text, executes only registered joi tools, queues steer/follow-up, and restores the session", async () => {
    const faux = fauxProvider({ provider: "joi-contract" });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    let releaseTool: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      releaseTool = () => resolve();
    });
    let signalToolStarted: (() => void) | undefined;
    const observedToolStart = new Promise<void>((resolve) => { signalToolStarted = resolve; });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("workbench_list_summaries", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("收到插话")]),
      fauxAssistantMessage([fauxText("继续处理后续")]),
    ]);

    const events: string[] = [];
    const runtime = new PiReasoningRuntime({
      model: faux.getModel(),
      models,
      sessionStore: store,
      tools: [{
        name: "workbench_list_summaries",
        label: "List Workbench summaries",
        description: "Lists redacted Workbench summaries.",
        parameters: Type.Object({}),
        execute: async () => {
          signalToolStarted?.();
          await toolStarted;
          return { content: [{ type: "text", text: "[]" }], details: {} };
        },
      }],
    });

    const turn = runtime.startTurn({
      workbenchId: "workbench_1",
      inputId: "input_1",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      onEvent: (event) => { if (event.type === "text_delta") events.push(event.delta); },
      prompt: "检查当前 Workbench",
      sessionId: "session_1",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn_1",
    });
    await observedToolStart;
    runtime.steer("session_1", "先回应这个变化");
    runtime.followUp("session_1", "然后继续后续");
    releaseTool?.();
    await turn;

    expect(events.join("")).toContain("收到插话");
    expect(events.join("")).toContain("继续处理后续");
    expect(store.snapshots.get("session_1")).toMatchObject({
      workbenchId: "workbench_1",
      modelRevisionId: "model_rev_1",
      sourceRevisionId: "source_rev_1",
    });

    faux.setResponses([fauxAssistantMessage([fauxText("已从会话恢复")])]);
    const restoredEvents: string[] = [];
    const restored = new PiReasoningRuntime({
      model: faux.getModel(),
      models,
      sessionStore: store,
      tools: [],
    });
    expect(await restored.restore("session_1")).toBe(true);
    await restored.startTurn({
      workbenchId: "workbench_1",
      inputId: "input_2",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      onEvent: (event) => { if (event.type === "text_delta") restoredEvents.push(event.delta); },
      prompt: "继续",
      sessionId: "session_1",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn_2",
    });
    expect(restoredEvents.join("")).toContain("已从会话恢复");
  });

  it("persists image attachment parts into the session's first user message", async () => {
    const faux = fauxProvider({ provider: "joi-images" });
    faux.setResponses([fauxAssistantMessage([fauxText("看到图片了")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, sessionStore: store, tools: [] });
    await runtime.startTurn({
      workbenchId: "workbench_1",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
      inputId: "input_img",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      prompt: "看这张图",
      sessionId: "session_images",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn_img",
    });
    const snapshot = store.snapshots.get("session_images");
    const userMessage = snapshot?.messages.find((message) => (message as { role?: unknown }).role === "user") as { content?: unknown } | undefined;
    const serialized = JSON.stringify(userMessage?.content ?? null);
    expect(serialized).toContain('"type":"image"');
    expect(serialized).toContain("aGVsbG8=");
    expect(serialized).toContain("看这张图");
  });

  it("never exposes arbitrary execution tools and can abort an active turn", async () => {
    expect(JOI_REASONING_TOOL_NAMES).toEqual([
      "workbench_list_summaries",
      "workbench_select",
      "workbench_create",
      "workbench_bind_workspace",
      "workbench_suggest_merge",
      "workbench_suggest_archive",
      "model_list_sources",
      "partner_list_skills",
      "joi_read_skill",
      "partner_list_available",
      "partner_inspect_revision",
      "partner_create",
      "partner_set_model",
      "partner_set_skills",
      "partner_set_tools",
      "partner_create_instance",
      "partner_list_instances",
      "partner_dispose_instance",
      "work_create",
      "work_add_dependency",
      "work_dispatch",
      "work_supplement",
      "work_read_result",
      "attachment_read",
      "work_wait",
      "work_cancel",
      "work_reassign",
      "work_resume",
      "memory_search",
      "memory_append_candidate",
      "schedule_plan",
      "create_automation",
      "list_automations",
      "get_automation",
      "update_automation",
      "delete_automation",
      "run_automation_now",
      "goal_resume",
      "user_ask",
      "turn_complete",
      "harness_name_destination",
      "harness_chart_path",
      "harness_record_decision",
      "harness_note_fog",
    ]);
    expect(JOI_REASONING_TOOL_NAMES).not.toEqual(expect.arrayContaining(["bash", "read", "write", "edit", "find", "grep", "ls"]));

    let unsafeRegistration: unknown;
    try {
      new PiReasoningRuntime({
        model: fauxProvider({ provider: "unsafe-registration" }).getModel(),
        models: createModels(),
        sessionStore: new MemorySessionStore(),
        tools: [{
          description: "must be rejected",
          execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: {} }),
          label: "unsafe",
          name: "bash",
          parameters: Type.Object({}),
        }],
      });
    } catch (error) {
      unsafeRegistration = error;
    }
    expect(unsafeRegistration).toMatchObject({ code: "unsafe_reasoning_tool" });

    const faux = fauxProvider({ provider: "joi-abort", tokensPerSecond: 10 });
    faux.setResponses([fauxAssistantMessage([fauxText("这是一段会持续输出很久的内容".repeat(30))])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({
      model: faux.getModel(),
      models,
      sessionStore: new MemorySessionStore(),
      tools: [],
    });
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const running = runtime.startTurn({
      workbenchId: "workbench_1",
      inputId: "input_abort",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      onEvent: (event) => { if (event.type === "text_delta") signalStarted?.(); },
      prompt: "开始",
      sessionId: "session_abort",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn_abort",
    });
    await started;
    runtime.abort("session_abort");
    await running;
    await runtime.waitForIdle("session_abort");
    expect(runtime.isRunning("session_abort")).toBe(false);
  });

  it("stops a sequential tool batch immediately after user_ask commits", async () => {
    const faux = fauxProvider({ provider: "joi-user-ask-stop" });
    faux.setResponses([fauxAssistantMessage([
      fauxToolCall("user_ask", { question: "请选择验收范围" }),
      fauxToolCall("turn_complete", { outcome: "DIRECT_ANSWER" }),
    ], { stopReason: "toolUse" })]);
    const models = createModels();
    models.setProvider(faux.provider);
    const calls: string[] = [];
    const tool = (name: "user_ask" | "turn_complete") => ({
      description: name,
      execute: async () => {
        calls.push(name);
        return { content: [{ type: "text" as const, text: "{}" }], details: {} };
      },
      label: name,
      name,
      parameters: Type.Object({}),
    });
    const runtime = new PiReasoningRuntime({
      model: faux.getModel(),
      models,
      sessionStore: new MemorySessionStore(),
      tools: [tool("user_ask"), tool("turn_complete")],
    });

    await runtime.startTurn({
      workbenchId: "workbench_1", inputId: "input_ask", modelId: "contract-model", modelRevisionId: "model_rev_1",
      onEvent: () => undefined, prompt: "安排任务", sessionId: "session_ask", sourceId: "contract-source",
      sourceRevisionId: "source_rev_1", systemPrompt: "You are joi.", turnId: "turn_ask",
    });
    expect(calls).toEqual(["user_ask"]);
  });

  it("compacts completed turns into a bounded recoverable checkpoint", async () => {
    const faux = fauxProvider({ provider: "joi-compaction" });
    faux.setResponses(Array.from({ length: 6 }, (_, index) => fauxAssistantMessage([
      fauxText(`answer-${String(index + 1)}-${"context ".repeat(10)}`),
    ])));
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    const runtime = new PiReasoningRuntime({
      compaction: { keepRecentMessages: 2, maxMessages: 6, maxSummaryCharacters: 240 },
      model: faux.getModel(),
      models,
      sessionStore: store,
      tools: [],
    });

    for (let index = 0; index < 4; index += 1) {
      await runtime.startTurn({
        workbenchId: "workbench_1",
        inputId: `input-${String(index + 1)}`,
        modelId: "contract-model",
        modelRevisionId: "model_rev_1",
        prompt: `prompt-${String(index + 1)}`,
        sessionId: "session_compact",
        sourceId: "contract-source",
        sourceRevisionId: "source_rev_1",
        systemPrompt: "You are joi.",
        turnId: `turn-${String(index + 1)}`,
      });
    }

    const compacted = store.snapshots.get("session_compact");
    expect(compacted?.messages.length).toBeLessThanOrEqual(3);
    expect(compacted?.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(compacted?.messages[0])).toContain("joi session checkpoint");
    expect(compacted?.compaction).toMatchObject({ count: 1 });
    expect(compacted?.compaction?.compactedMessages).toBeGreaterThanOrEqual(6);

    const restored = new PiReasoningRuntime({
      compaction: { keepRecentMessages: 2, maxMessages: 6, maxSummaryCharacters: 240 },
      model: faux.getModel(),
      models,
      sessionStore: store,
      tools: [],
    });
    expect(await restored.restore("session_compact")).toBe(true);
    await restored.startTurn({
      workbenchId: "workbench_1",
      inputId: "input-after-restore",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      prompt: "prompt-after-restore",
      sessionId: "session_compact",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn-after-restore",
    });
    expect(store.snapshots.get("session_compact")?.compaction?.count).toBe(1);
  });

  it("bounds every request inside the window when one Turn keeps calling tools", async () => {
    const faux = fauxProvider({ provider: "joi-mid-turn-bound" });
    // A 32k window sizes the request budget to 16k characters, small enough to exceed mid-Turn.
    const model = { ...faux.getModel(), contextWindow: 32_000 };
    const budget = modelContextMaxChars(model);
    const requestChars: number[] = [];
    const openings: unknown[] = [];
    faux.setResponses(Array.from({ length: 6 }, (_, index) => (context: { messages?: unknown }) => {
      const messages = (context.messages ?? []) as unknown[];
      requestChars.push(JSON.stringify(messages).length);
      openings.push(messages[0]);
      return index < 5
        ? fauxAssistantMessage([fauxToolCall("memory_search", { query: String(index) })], { stopReason: "toolUse" })
        : fauxAssistantMessage([fauxText("done")]);
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({
      model,
      models,
      sessionStore: new MemorySessionStore(),
      tools: [{
        name: "memory_search",
        label: "Search memory",
        description: "Searches memory.",
        parameters: Type.Object({ query: Type.String() }),
        execute: async () => ({ content: [{ type: "text", text: `tool-output ${"x".repeat(5_000)}` }], details: {} }),
      }],
    });

    await runtime.startTurn({
      workbenchId: "workbench_1",
      inputId: "input_bound",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      prompt: "look things up",
      sessionId: "session_bound",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn-bound",
    });

    // Compaction only runs at Turn boundaries, so without this bound the later requests of the Turn
    // would carry the whole grown history past the window and lose their output budget to a clamped
    // max_tokens — the Turn then ends truncated with no committed outcome.
    expect(requestChars).toHaveLength(6);
    expect(Math.max(...requestChars)).toBeLessThanOrEqual(budget + 2_000);
    expect(requestChars.at(-1)).toBeGreaterThan(requestChars[0] ?? 0);
    // The opening request survives as the anchor, so the model still sees what it was asked.
    expect(JSON.stringify(openings.at(-1))).toContain("look things up");
  });

  it("keeps the request anchor and never opens on an orphaned tool result", () => {
    const filler = (role: string, text: string) => ({ content: [{ text, type: "text" }], role, timestamp: 1 }) as never;
    const messages = [
      filler("user", "TASK_ANCHOR"),
      ...Array.from({ length: 8 }, (_, index) => filler(index % 2 === 0 ? "assistant" : "toolResult", "y".repeat(1_000))),
    ];
    const bounded = boundRequestByChars(messages, 4_000);
    expect(bounded.length).toBeLessThan(messages.length);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(4_000 + 2_000);
    expect(JSON.stringify(bounded[0])).toContain("TASK_ANCHOR");
    expect((bounded[1] as { role?: string }).role).not.toBe("toolResult");
  });

  it("compacts a token-overflowing session before prompting even below the message cap", async () => {
    const faux = fauxProvider({ provider: "joi-token-overflow" });
    faux.setResponses([
      fauxAssistantMessage([fauxText("checkpoint summary")]),
      fauxAssistantMessage([fauxText("压缩后的回答")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    const flood = Array.from({ length: 24 }, (_, index) => ({
      // Keep this fixture above the SDK's estimated token window, not merely large in characters.
      content: `填充 ${String(index)} ${"上下文".repeat(1000)}`,
      role: "user",
      timestamp: 1_700_000_000_000 + index * 1000,
    }));
    await store.save({
      messages: flood,
      modelRevisionId: "model_rev_1",
      sessionId: "session_overflow",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      updatedAt: "2026-09-08T10:00:00.000Z",
      workbenchId: "workbench_1",
    });
    const runtime = new PiReasoningRuntime({
      model: { ...faux.getModel(), contextWindow: 16_000, maxTokens: 8_000 },
      models,
      sessionStore: store,
      tools: [],
    });
    await runtime.startTurn({
      workbenchId: "workbench_1",
      inputId: "input_overflow",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      prompt: "hi",
      sessionId: "session_overflow",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn_overflow",
    });
    const saved = store.snapshots.get("session_overflow");
    expect(saved?.messages.length).toBeLessThan(flood.length);
    expect(JSON.stringify(saved?.messages[0])).toContain("joi session checkpoint");
    expect(saved?.compaction).toMatchObject({ count: 1 });
  });

  it("surfaces a killed stream that delivered nothing as reasoning_stream_error", async () => {
    const faux = fauxProvider({ provider: "joi-stream-error" });
    faux.setResponses([fauxAssistantMessage([], {
      errorMessage: "400 event:error max_completion_tokens [1] must be greater than thinking_budget [1024]",
      stopReason: "error",
    })]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({
      model: faux.getModel(),
      models,
      sessionStore: new MemorySessionStore(),
      tools: [],
    });
    await expect(runtime.startTurn({
      workbenchId: "workbench_1",
      inputId: "input_stream_error",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      prompt: "hi",
      sessionId: "session_stream_error",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn_stream_error",
    })).rejects.toMatchObject({ code: "reasoning_stream_error" });
  });
});
