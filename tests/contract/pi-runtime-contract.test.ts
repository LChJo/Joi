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
import { createPiSourceProvider } from "../../src/main/infrastructure/pi/source-provider-factory.js";

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
  it("ships provider-specific API and coding-plan presets plus one generic option", () => {
    expect([...new Set(MODEL_SOURCE_OPTIONS.map((option) => option.kind))]).toEqual([
      "kimi",
      "glm",
      "qwen",
      "doubao",
      "minimax",
      "deepseek",
      "generic-openai",
    ]);
    expect(MODEL_SOURCE_PRESETS).toHaveLength(18);
    expect(MODEL_SOURCE_PRESETS.filter((preset) => preset.accessMode === "coding-plan" && preset.protocol === "anthropic").map((preset) => preset.kind))
      .toEqual(["kimi", "glm", "qwen", "doubao", "minimax"]);
    expect(MODEL_SOURCE_PRESETS.find((preset) => (
      preset.kind === "kimi" && preset.accessMode === "coding-plan" && preset.protocol === "anthropic"
    ))?.models.map((entry) => entry.id)).toEqual(["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]);
    for (const preset of MODEL_SOURCE_PRESETS) {
      expect(preset.endpoint).toMatch(/^https:\/\//u);
      expect(preset.defaultModelId.length).toBeGreaterThan(0);
      expect(preset.models.map((model) => model.id)).toContain(preset.defaultModelId);
      expect(preset.endpointEditable).toBe(false);
      expect(preset.presetVersion).toBe("2026-07-30");
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
    expect(openai.getModels()[0]).toMatchObject({ api: "openai-completions", provider: "joi-source:kimi_code_openai" });

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
      fauxAssistantMessage([fauxToolCall("avatar.list_summaries", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("收到插话")]),
      fauxAssistantMessage([fauxText("继续处理后续")]),
    ]);

    const events: string[] = [];
    const runtime = new PiReasoningRuntime({
      model: faux.getModel(),
      models,
      sessionStore: store,
      tools: [{
        name: "avatar.list_summaries",
        label: "List Avatar summaries",
        description: "Lists redacted Avatar summaries.",
        parameters: Type.Object({}),
        execute: async () => {
          signalToolStarted?.();
          await toolStarted;
          return { content: [{ type: "text", text: "[]" }], details: {} };
        },
      }],
    });

    const turn = runtime.startTurn({
      avatarId: "avatar_1",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      onEvent: (event) => { if (event.type === "text_delta") events.push(event.delta); },
      prompt: "检查当前 Avatar",
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
      avatarId: "avatar_1",
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
      avatarId: "avatar_1",
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

  it("never exposes arbitrary execution tools and can abort an active turn", async () => {
    expect(JOI_REASONING_TOOL_NAMES).toEqual([
      "avatar.list_summaries",
      "avatar.select",
      "avatar.create",
      "avatar.suggest_merge",
      "avatar.suggest_archive",
      "model.list_sources",
      "partner.list_available",
      "partner.inspect_revision",
      "partner.create",
      "partner.create_instance",
      "partner.list_instances",
      "partner.dispose_instance",
      "work.create",
      "work.add_dependency",
      "work.dispatch",
      "work.wait",
      "work.cancel",
      "work.reassign",
      "memory.search",
      "memory.append_candidate",
      "schedule.plan",
      "user.ask",
    ]);
    expect(JOI_REASONING_TOOL_NAMES).not.toEqual(expect.arrayContaining(["bash", "read", "write", "edit", "find", "grep", "ls"]));

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
      avatarId: "avatar_1",
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
        avatarId: "avatar_1",
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
      avatarId: "avatar_1",
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
});
