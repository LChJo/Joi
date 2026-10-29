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
import { vi } from "vitest";

import type {
  JoiReasoningSessionSnapshot,
  ReasoningSessionStore,
  PrimaryReasoningEvent,
} from "../../src/main/application/ports/primary-reasoning-runtime.js";
import {
  compactionHeadroom,
  JOI_REASONING_TOOL_NAMES,
  PiReasoningRuntime,
} from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import {
  MODEL_SOURCE_OPTIONS,
  MODEL_SOURCE_PRESETS,
} from "../../src/main/infrastructure/pi/provider-presets.js";
import { boundRequestByChars, modelContextMaxChars } from "../../src/main/infrastructure/pi/pi-model-budget.js";
import { GOAL_REQUIREMENTS_MAX_CHARS } from "../../src/main/application/ports/goal-requirements.js";
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
  it.each([
    { code: "goal_resume_not_allowed", proof: true, safe: true },
    { code: "goal_resume_conflict", proof: true, safe: true },
    { code: "goal_resume_not_allowed", proof: false, safe: false },
    { code: "storage_failed", proof: true, safe: false },
  ])("forwards only trusted transactional rejection proofs: %j", async ({ code, proof, safe }) => {
    const faux = fauxProvider({ provider: `review-proof-${code}-${String(proof)}` });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("goal_resume", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Review interrupted.")]),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const events: PrimaryReasoningEvent[] = [];
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, sessionStore: new MemorySessionStore(), thinkingLevel: "off",
      tools: [{ name: "goal_resume", label: "Resume", description: "Resume this version", parameters: Type.Object({}),
        execute: async () => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ reasonCode: code, status: "REJECTED" }) }],
          details: proof ? { replaySafeRejection: true } : {} }) }],
    });
    await runtime.startTurn({ inputId: "joi_goal_resume:goal:g:v1", workbenchId: "wb", prompt: "Review",
      sessionId: "review-proof", modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake",
      systemPrompt: "POLICY", turnId: "turn", onEvent: event => events.push(event) });
    const finished = events.find(event => event.type === "tool_finished");
    expect(finished).toMatchObject({ type: "tool_finished", isError: true, reasonCode: code });
    if (safe) expect(finished).toHaveProperty("replaySafeRejection", true);
    else expect(finished).not.toHaveProperty("replaySafeRejection");
  });

  it("reads a long source in one turn while preserving requirements and bounding every request", async () => {
    const faux = fauxProvider({ provider: "required-long-source" });
    const model = { ...faux.getModel(), contextWindow: 64000 };
    const requiredContext = "REQUIRED_CURRENT_DAY";
    const requests: string[] = [];
    faux.setResponses([
      ...Array.from({ length: 14 }, (_, index) => (context: { messages?: unknown }) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage([fauxToolCall("goal_read_inputs", { offset: index * 4000 })], { stopReason: "toolUse" });
      }),
      (context: { messages?: unknown }) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage([fauxText("Source read completely.")]);
      },
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    const offsets: number[] = [];
    const tools = [{ name: "goal_read_inputs", label: "Read", description: "Read a source page", parameters: Type.Object({ offset: Type.Integer() }),
      execute: async (_id: string, raw: unknown) => {
        const args = raw as { offset: number };
        offsets.push(args.offset);
        return { content: [{ type: "text" as const, text: `page=${String(args.offset)} `.padEnd(4000, "x") }], details: {} };
      } }];
    const runtime = new PiReasoningRuntime({ model, models, sessionStore: store, thinkingLevel: "off", tools });
    await expect(runtime.startTurn({ requiredContext, refreshRequiredContext: async () => requiredContext,
      inputId: "goal", workbenchId: "wb", prompt: "Read the entire source", sessionId: "long-source", modelId: "fake", modelRevisionId: "fake",
      sourceId: "fake", sourceRevisionId: "fake", systemPrompt: "POLICY", turnId: "turn" })).resolves.toBeUndefined();
    expect(offsets).toEqual(Array.from({ length: 14 }, (_, index) => index * 4000));
    expect(requests).toHaveLength(15);
    for (const request of requests) {
      expect(request).toContain(requiredContext);
      expect(request.length + JSON.stringify(tools).length).toBeLessThanOrEqual(modelContextMaxChars(model));
    }
    expect(requests.at(-1)).toContain("page=52000");
    expect(requests.at(-1)).toContain("joi context notice");
    expect(JSON.stringify(store.snapshots.get("long-source"))).not.toContain(requiredContext);
  });

  it("compacts an overflowing restored history before checking protected requirements capacity", async () => {
    const faux = fauxProvider({ provider: "required-restored-history" });
    const requests: string[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxText("Earlier pages recorded.")]),
      context => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage([fauxText("continued")]); },
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    await store.save({ workbenchId: "wb", modelRevisionId: "fake", sourceRevisionId: "fake", sessionId: "restored-long", systemPrompt: "POLICY",
      updatedAt: "2026-10-11T00:00:00Z", messages: Array.from({ length: 70 }, (_, index) => ({ role: "user" as const, content: `page-${String(index)} `.padEnd(4000, "x"), timestamp: index })) });
    const runtime = new PiReasoningRuntime({ model: { ...faux.getModel(), contextWindow: 64000 }, models, sessionStore: store, thinkingLevel: "off", tools: [] });
    await expect(runtime.startTurn({ requiredContext: "REQUIRED_CURRENT_DAY", inputId: "goal", workbenchId: "wb", prompt: "Continue reading", sessionId: "restored-long",
      modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake", systemPrompt: "POLICY", turnId: "turn" })).resolves.toBeUndefined();
    expect(requests.at(-1)).toContain("REQUIRED_CURRENT_DAY");
    expect(requests.at(-1)).toContain("Continue reading");
    expect(store.snapshots.get("restored-long")?.compaction?.count).toBeGreaterThan(0);
  });

  it.each([32000, 200000, 0])("protects current requirements with a %i window without storing copies", async (window) => {
    const faux = fauxProvider({ provider: `requirements-${String(window)}` });
    const requests: string[] = [];
    faux.setResponses(Array.from({ length: 3 }, () => context => {
      requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage([fauxText("done")]);
    }));
    const models = createModels(); models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    const runtime = new PiReasoningRuntime({ model: { ...faux.getModel(), contextWindow: window }, models, sessionStore: store, thinkingLevel: "off", tools: [] });
    for (let index = 0; index < 3; index++) {
      await runtime.startTurn({ requiredContext: `REQUIRED_DAY_RULE_${String(index)}`, backgroundContext: "x".repeat(24000), backgroundContextVariants: ["y".repeat(40000), "z".repeat(60000)],
        inputId: "input", workbenchId: "wb", prompt: "continue", sessionId: "requirements", modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake", systemPrompt: "POLICY", turnId: `turn-${String(index)}` });
      expect(requests.at(-1)).toContain(`REQUIRED_DAY_RULE_${String(index)}`);
      expect((requests.at(-1)?.match(/REQUIRED_DAY_RULE/gu) ?? [])).toHaveLength(1);
      expect(JSON.stringify(store.snapshots.get("requirements"))).not.toContain("REQUIRED_DAY_RULE");
    }
  });

  it("rejects mandatory context that cannot fit rather than truncating it", async () => {
    const faux = fauxProvider({ provider: "required-capacity" });
    const models = createModels(); models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({ model: { ...faux.getModel(), contextWindow: 32000 }, models, sessionStore: new MemorySessionStore(), thinkingLevel: "off", tools: [] });
    // The policy prompt is measured at its production length here: on a 32k route it leaves only a
    // few hundred characters of room, so a contract this size has nowhere to go and must be refused
    // rather than silently cut down.
    await expect(runtime.startTurn({ requiredContext: "RULE".repeat(3000), inputId: "input", workbenchId: "wb", prompt: "continue", sessionId: "capacity", modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake", systemPrompt: "POLICY ".repeat(2232).trimEnd(), turnId: "turn" })).rejects.toMatchObject({ code: "goal_requirements_capacity_exceeded" });
  });
  it("shrinks escaped optional background before rejecting mandatory requirements", async () => {
    const faux = fauxProvider({ provider: "required-escaped-background" });
    const requests: string[] = [];
    faux.setResponses([context => {
      requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage([fauxText("done")]);
    }]);
    const models = createModels(); models.setProvider(faux.provider);
    const model = { ...faux.getModel(), contextWindow: 32000 };
    const runtime = new PiReasoningRuntime({ model, models, sessionStore: new MemorySessionStore(), thinkingLevel: "off", tools: [] });
    await expect(runtime.startTurn({ requiredContext: "REQUIRED_CURRENT_DAY", backgroundContext: "OPTIONAL_EVIDENCE " + "\u0001".repeat(24000),
      inputId: "input", workbenchId: "wb", prompt: "continue", sessionId: "escaped-background", modelId: "fake", modelRevisionId: "fake",
      sourceId: "fake", sourceRevisionId: "fake", systemPrompt: "POLICY", turnId: "turn" })).resolves.toBeUndefined();
    expect(requests[0]).toContain("REQUIRED_CURRENT_DAY");
    expect(requests[0]).toContain("OPTIONAL_EVIDENCE");
    expect((requests[0]?.length ?? 0) + 2).toBeLessThanOrEqual(modelContextMaxChars(model));
  });
  it("reports a response whose terminating tool left a later call unanswered", async () => {
    const faux = fauxProvider({ provider: "dangling-report" });
    const events: { event: string; fields: unknown }[] = [];
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("turn_complete", { outcome: "DIRECT_ANSWER" }),
        fauxToolCall("memory_search", { query: "unreached" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const tools = [
      { name: "turn_complete", label: "Complete", description: "commits and ends the turn",
        parameters: Type.Object({ value: Type.Optional(Type.String()) }),
        execute: async () => ({ content: [{ type: "text" as const, text: "committed" }], details: {}, terminate: true }) },
      { name: "memory_search", label: "Search", description: "the call behind it",
        parameters: Type.Object({ query: Type.String() }),
        execute: async () => ({ content: [{ type: "text" as const, text: "ran" }], details: {} }) },
    ];
    const runtime = new PiReasoningRuntime({
      diagnostics: { emit: (event: string, fields: unknown) => { events.push({ event, fields }); } },
      model: { ...faux.getModel(), contextWindow: 200000 }, models, sessionStore: new MemorySessionStore(), thinkingLevel: "off", tools,
    });
    await runtime.startTurn({ inputId: "input", workbenchId: "wb", prompt: "go", sessionId: "dangling", modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake", systemPrompt: "POLICY", turnId: "turn" });
    // The second call never ran and emits nothing of its own, so this report is the only place its
    // absence becomes observable — which is the point of recording it.
    const report = events.find((entry) => entry.event === "joi.turn.dangling_tool_call");
    expect(report?.fields).toMatchObject({ danglingCount: 1, observedToolCount: 2 });
  });

  it("carries a requirements contract that the write path accepted on a mid-sized window", async () => {
    const faux = fauxProvider({ provider: "required-write-ceiling" });
    const requests: string[] = [];
    faux.setResponses([(context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage([fauxText("done")]); }]);
    const models = createModels(); models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({ model: { ...faux.getModel(), contextWindow: 64000 }, models, sessionStore: new MemorySessionStore(), thinkingLevel: "off", tools: [] });
    // The requirements store accepts a contract up to GOAL_REQUIREMENTS_MAX_CHARS, so one at that
    // ceiling is writable by construction — a route that cannot carry it makes the write ceiling
    // a lie, and the goal runs until it happens to land on a bigger model.
    const requiredContext = `Effective user requirements (user scope; runtime permissions remain authoritative):\nrequirementsRevision=1 sourceRevision=1 processedSourceRevision=1 status=READY\n${JSON.stringify({ id: "r1", kind: "CONSTRAINT", mandatory: true, scope: "GLOBAL", text: "x".repeat(15_000) })}`;
    expect(requiredContext.length).toBeLessThanOrEqual(GOAL_REQUIREMENTS_MAX_CHARS);
    await runtime.startTurn({ requiredContext, inputId: "input", workbenchId: "wb", prompt: "continue", sessionId: "ceiling", modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake", systemPrompt: "POLICY", turnId: "turn" });
    expect(requests.at(-1)).toContain("requirementsRevision=1");
  });
  it("starts a goal turn on a mid-sized window when the real policy prompt fills its share", async () => {
    const faux = fauxProvider({ provider: "required-share-floor" });
    const requests: string[] = [];
    faux.setResponses([(context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage([fauxText("done")]); }]);
    const models = createModels(); models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({ model: { ...faux.getModel(), contextWindow: 64000 }, models, sessionStore: new MemorySessionStore(), thinkingLevel: "off", tools: [] });
    // The production policy prompt measures 15,621 characters; the share the background budget
    // reserves for it (a third of the window) is smaller than that on any route under ~64k, so a
    // real goal turn must still start and carry its requirements rather than fail outright.
    const systemPrompt = "POLICY ".repeat(2232).trimEnd();
    const requiredContext = [
      "Effective user requirements (user scope; runtime permissions remain authoritative):",
      "requirementsRevision=1 sourceRevision=1 processedSourceRevision=1 status=READY",
      JSON.stringify({ id: "r1", kind: "DELIVERABLE", mandatory: true, scope: "GLOBAL", text: "The report must name the root cause and cite the file that carries it." }),
      JSON.stringify({ id: "r2", kind: "CONSTRAINT", mandatory: true, scope: "GLOBAL", text: "Do not modify production data while investigating; read-only access only." }),
      JSON.stringify({ id: "r3", kind: "OBJECTIVE", mandatory: true, scope: "GLOBAL", text: "Explain why the retry loop reproduced its own failure before proposing a fix." }),
      JSON.stringify({ id: "r4", kind: "PREFERENCE", mandatory: false, scope: "SCOPED", text: "Prefer Chinese in the final summary." }),
    ].join("\n");
    await runtime.startTurn({ requiredContext, inputId: "input", workbenchId: "wb", prompt: "continue", sessionId: "share", modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake", systemPrompt, turnId: "turn" });
    expect(requests.at(-1)).toContain("Do not modify production data");
  });
  it.each(["empty", "medium", "busy", "prompt", "tools", "unknown"] as const)("chooses continuation evidence using the %s session's remaining capacity", async (state) => {
    const faux = fauxProvider({ provider: `joi-adaptive-background-${state}` });
    const requests: string[] = [];
    faux.setResponses([(context) => {
      requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage([fauxText("done")]);
    }]);
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    if (state === "busy") vi.spyOn(models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("HISTORY_TO_KEEP retained in checkpoint")]));
    if (state === "busy") await store.save({
      workbenchId: "workbench", modelRevisionId: "fake", sourceRevisionId: "fake", sessionId: "adaptive", systemPrompt: "POLICY", updatedAt: "2026-10-10T00:00:00.000Z",
      messages: [
        { role: "system", content: "POLICY", timestamp: 0 },
        { role: "user", content: "OLD_REQUEST", timestamp: 1 },
        fauxAssistantMessage([fauxText("HISTORY_TO_KEEP " + "x".repeat(135_000))]),
      ],
    });
    const model = { ...faux.getModel(), contextWindow: state === "unknown" ? 0 : 200_000 };
    const tools = state === "tools" ? [{
      name: "memory_search", label: "Search", description: "TOOL_SCHEMA " + "x".repeat(135_000),
      parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }),
    }] : [];
    await new PiReasoningRuntime({ model, models, sessionStore: store, thinkingLevel: "off", tools }).startTurn({
      backgroundContext: `SOFT_EVIDENCE ${"材料".repeat(11_000)}`,
      backgroundContextVariants: [`MEDIUM_EVIDENCE ${"材料".repeat(19_000)}`, `LARGE_EVIDENCE ${"材料".repeat(29_000)}`],
      inputId: "input", workbenchId: "workbench", prompt: "REPAIR_NOW" + (state === "prompt" ? "x".repeat(135_000) : ""), sessionId: "adaptive",
      modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake",
      systemPrompt: "POLICY" + (state === "medium" ? "x".repeat(10_000) : ""), turnId: "adaptive_turn",
    });
    const request = requests.at(-1) ?? "";
    const expectedEvidence = state === "empty" || state === "busy" ? "LARGE_EVIDENCE" : state === "medium" ? "MEDIUM_EVIDENCE" : "SOFT_EVIDENCE";
    expect(request.includes(expectedEvidence)).toBe(true);
    if (state === "busy") expect(request).toContain("HISTORY_TO_KEEP");
    expect(request).toContain("REPAIR_NOW");
    expect(JSON.stringify(store.snapshots.get("adaptive"))).not.toContain("EVIDENCE");
  });

  it("refreshes continuation evidence without accumulating copies in the session", async () => {
    const faux = fauxProvider({ provider: "joi-continuation-background" });
    const requests: string[] = [];
    faux.setResponses(Array.from({ length: 12 }, () => (context) => {
      requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage([fauxText("done")]);
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, sessionStore: store, thinkingLevel: "off", tools: [] });
    for (let index = 0; index < 12; index += 1) {
      const subject = index < 6 ? runtime : new PiReasoningRuntime({ model: faux.getModel(), models, sessionStore: store, thinkingLevel: "off", tools: [] });
      await subject.startTurn({
        backgroundContext: `EVIDENCE_VERSION_${String(index)} ${"参考材料".repeat(1000)} CONCLUSION_END`,
        inputId: "input", workbenchId: "workbench", prompt: `继续 ${String(index)}`, sessionId: "session_background",
        modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake",
        systemPrompt: "You are Joi.", turnId: `turn_${String(index)}`,
      });
      expect(requests.at(-1)).toContain(`EVIDENCE_VERSION_${String(index)}`);
      expect((requests.at(-1)?.match(/CONCLUSION_END/gu) ?? [])).toHaveLength(1);
      expect(JSON.stringify(store.snapshots.get("session_background"))).not.toContain("EVIDENCE_VERSION_");
    }
    expect((requests.at(-1)?.length ?? 0) - (requests[0]?.length ?? 0)).toBeLessThan(6000);
  });

  it("budgets temporary evidence against a small model window while preserving policy and the new request", async () => {
    const faux = fauxProvider({ provider: "joi-small-background" });
    let request = "";
    faux.setResponses([(context) => {
      request = JSON.stringify(context.messages);
      return fauxAssistantMessage([fauxText("done")]);
    }]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { ...faux.getModel(), contextWindow: 32_000 };
    const store = new MemorySessionStore();
    await new PiReasoningRuntime({ model, models, sessionStore: store, thinkingLevel: "off", tools: [] }).startTurn({
      backgroundContext: `CURRENT_ROOT_CAUSE ${"参考材料".repeat(20_000)}`,
      inputId: "input", workbenchId: "workbench", prompt: "REPAIR_NOW", sessionId: "small_background",
      modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake",
      systemPrompt: "FIXED_PERMISSION_BOUNDARY", turnId: "small_turn",
    });
    expect(request).toContain("CURRENT_ROOT_CAUSE");
    expect(request).toContain("FIXED_PERMISSION_BOUNDARY");
    expect(request).toContain("REPAIR_NOW");
    expect(request).toContain("truncated");
    expect(request.length).toBeLessThan(modelContextMaxChars(model));
    expect(JSON.stringify(store.snapshots.get("small_background"))).not.toContain("CURRENT_ROOT_CAUSE");
  });

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
    const resolve = vi.fn(async () => ({ model: faux.getModel(), models, thinkingLevel: "off" as const }));
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
      thinkingLevel: "off" as const,
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
      thinkingLevel: "off" as const,
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
      thinkingLevel: "off" as const,
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
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, sessionStore: store, thinkingLevel: "off" as const, tools: [] });
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
      "context_read_history",
      "goal_read_inputs", "goal_update_requirements", "work_list_goal", "work_read_brief", "work_update_brief",
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
      "work_read_evidence",
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
        thinkingLevel: "off" as const,
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
      thinkingLevel: "off" as const,
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
      thinkingLevel: "off" as const,
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

  it("turns the configured threshold into the output headroom compaction waits for", () => {
    // A lower threshold leaves more headroom, so it compacts sooner; a higher one waits longer.
    // This is the whole effect of the setting, and it scales with the route's window — which a
    // fixed message count could never do.
    expect(compactionHeadroom(200_000, 50)).toBe(100_000);
    expect(compactionHeadroom(200_000, 85)).toBe(30_000);
    expect(compactionHeadroom(200_000, 95)).toBe(10_000);
    // Small or unknown windows fall back to a floor, so the summary request itself still fits.
    expect(compactionHeadroom(8_000, 85)).toBe(4_096);
    expect(compactionHeadroom(0, 85)).toBe(4_096);
  });

  it("rejects a compaction threshold outside the supported range", () => {
    const faux = fauxProvider({ provider: "joi-compaction-range" });
    const models = createModels();
    models.setProvider(faux.provider);
    const build = (compactAtPercent: number) => new PiReasoningRuntime({
      compaction: { compactAtPercent, keepRecentMessages: 2, maxMessages: 6, maxSummaryCharacters: 240 },
      model: faux.getModel(),
      models,
      sessionStore: new MemorySessionStore(),
      thinkingLevel: "off" as const,
      tools: [],
    });
    // 100 would mean the request already fills the window before compaction runs, which is the
    // failure the threshold exists to prevent.
    expect(() => build(100)).toThrow("reasoning_compaction_invalid");
    expect(() => build(49)).toThrow("reasoning_compaction_invalid");
    expect(() => build(50)).not.toThrow();
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
      thinkingLevel: "off" as const,
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
    // The transcript leads with the prompt pi keeps inside it; the checkpoint replaces the turns
    // that follow. The list is held at the configured cap rather than growing with the session,
    // and the cap now counts the prompt too, because the prompt is inside the list.
    expect(compacted?.messages[0]).toMatchObject({ role: "system" });
    expect(compacted?.messages.length).toBeLessThanOrEqual(6);
    expect(JSON.stringify(compacted?.messages[1])).toContain("joi session checkpoint");
    expect(compacted?.compaction).toMatchObject({ count: 1 });
    // The prompt is preserved rather than summarized, so it is not part of this count.
    expect(compacted?.compaction?.compactedMessages).toBeGreaterThanOrEqual(4);

    const restored = new PiReasoningRuntime({
      compaction: { keepRecentMessages: 2, maxMessages: 6, maxSummaryCharacters: 240 },
      model: faux.getModel(),
      models,
      sessionStore: store,
      thinkingLevel: "off" as const,
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

  it("sizes a known model to the completion cap its vendor documents", () => {
    const glm = createPiSourceProvider({ accessMode: "api", kind: "glm", modelId: "glm-4.7", protocol: "openai", sourceId: "src_glm" });
    expect(glm.getModels()[0]).toMatchObject({ maxTokens: 131_072 });
    // A generic gateway forwards to a model joi cannot know, so it keeps the conservative ceiling.
    const gateway = createPiSourceProvider({
      baseUrl: "https://gateway.example/v1", displayName: "gw", kind: "generic-openai",
      modelId: "vendor/unknown", protocol: "openai", sourceId: "src_gw",
    });
    expect(gateway.getModels()[0]).toMatchObject({ maxTokens: 16_384 });
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
      // The task is what the model must still be told; the prompt now leads the transcript, so it
      // is no longer the message that carries it.
      openings.push(messages.find((message) => (message as { role?: string }).role === "user"));
      return index < 5
        ? fauxAssistantMessage([fauxToolCall("memory_search", { query: String(index) })], { stopReason: "toolUse" })
        : fauxAssistantMessage([fauxText("done")]);
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({
      model,
      thinkingLevel: "off" as const,
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

  it("names the history a mid-Turn bound had to drop, instead of leaving it as an absence", async () => {
    const faux = fauxProvider({ provider: "joi-mid-turn-omission" });
    const model = { ...faux.getModel(), contextWindow: 32_000 };
    const bound = modelContextMaxChars(model);
    const requests: string[] = [];
    faux.setResponses(Array.from({ length: 6 }, (_, index) => (context: { messages?: unknown }) => {
      requests.push(JSON.stringify(context.messages ?? []));
      return index < 5
        ? fauxAssistantMessage([fauxToolCall("memory_search", { query: String(index) })], { stopReason: "toolUse" })
        : fauxAssistantMessage([fauxText("done")]);
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({
      model,
      thinkingLevel: "off" as const,
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
      inputId: "input_omission",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      prompt: "look things up",
      sessionId: "session_omission",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn-omission",
    });

    // The bound did drop history: without a word, that is the same silent loss a long partner run
    // was diagnosed with, and it produced the same wrong conclusion about who changed the workspace.
    const last = requests.at(-1) ?? "";
    expect(requests.some((request) => request.includes("joi context notice"))).toBe(true);
    expect(last).toContain("no other process modified your workspace");
    // The omission is confined to this request; it is not a new fact about the session.
    expect(last.length).toBeLessThanOrEqual(bound + 2_000);
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

  // pi 0.82 keeps the system prompt out of the transcript (`AgentState.systemPrompt`), so the
  // message list opens on the user's request; later pi versions seed a leading system message
  // instead. A trim that only recognised the first shape would drop the second — taking the runtime
  // permission boundary with it, so the model reads its own constraints as ordinary conversation.
  it("keeps a leading system message through a trim, in both transcript shapes", () => {
    const filler = (role: string, text: string) => ({ content: [{ text, type: "text" }], role, timestamp: 1 }) as never;
    const tail = Array.from({ length: 8 }, (_, index) => filler(index % 2 === 0 ? "assistant" : "toolResult", "y".repeat(1_000)));

    const withSystem = [filler("system", "PERMISSION_BOUNDARY"), filler("user", "TASK_ANCHOR"), ...tail];
    const bounded = boundRequestByChars(withSystem, 4_000);
    expect(bounded.length).toBeLessThan(withSystem.length);
    expect((bounded[0] as { role?: string }).role).toBe("system");
    expect(JSON.stringify(bounded[0])).toContain("PERMISSION_BOUNDARY");
    expect(JSON.stringify(bounded[1])).toContain("TASK_ANCHOR");
    // The anchor is not re-added on top of a tail that still carries it.
    expect(bounded.filter((message) => JSON.stringify(message).includes("TASK_ANCHOR"))).toHaveLength(1);

    const withoutSystem = [filler("user", "TASK_ANCHOR"), ...tail];
    expect((boundRequestByChars(withoutSystem, 4_000)[0] as { role?: string }).role).toBe("user");
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
      thinkingLevel: "off" as const,
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
    expect(JSON.stringify(saved?.messages)).toContain("joi session checkpoint");
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
      thinkingLevel: "off" as const,
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

  // A failed Turn is re-queued and prompted again on the same session, so whatever it wrote is
  // read back as this run's own precedent. A Turn that answered with its tool calls written as
  // plain text taught every retry to do the same until the crash-loop breaker parked the input.
  const rollbackTurnInput = (turnId: string, prompt: string) => ({
    workbenchId: "workbench_1",
    inputId: `input_${turnId}`,
    modelId: "contract-model",
    modelRevisionId: "model_rev_1",
    prompt,
    sessionId: "session_rollback",
    sourceId: "contract-source",
    sourceRevisionId: "source_rev_1",
    systemPrompt: "You are joi.",
    turnId,
  });

  it("takes a Turn that failed at the provider back out of the session", async () => {
    const faux = fauxProvider({ provider: "joi-failed-turn-rollback" });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, sessionStore: store, thinkingLevel: "off" as const, tools: [] });

    faux.setResponses([fauxAssistantMessage([fauxText("第一次回答")])]);
    await runtime.startTurn(rollbackTurnInput("turn_ok", "第一次"));

    faux.setResponses([fauxAssistantMessage([], { errorMessage: "400 aborted", stopReason: "error" })]);
    await expect(runtime.startTurn(rollbackTurnInput("turn_killed", "第二次")))
      .rejects.toMatchObject({ code: "reasoning_stream_error" });

    const saved = JSON.stringify(store.snapshots.get("session_rollback")?.messages);
    expect(saved).toContain("第一次回答");
    expect(saved).not.toContain("第二次");
  });

  it("keeps a committed tool call in the session when a later provider request fails", async () => {
    const faux = fauxProvider({ provider: "joi-tool-then-provider-error" });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    let calls = 0;
    const runtime = new PiReasoningRuntime({
      model: faux.getModel(), models, sessionStore: store, thinkingLevel: "off" as const,
      tools: [{
        name: "work_dispatch", label: "Dispatch Work", description: "Commit a plan.",
        parameters: Type.Object({}),
        execute: async () => {
          calls += 1;
          return { content: [{ type: "text" as const, text: "committed" }], details: {} };
        },
      }],
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("work_dispatch", {})], { stopReason: "toolUse" }),
      () => { throw new Error("provider unavailable after dispatch"); },
    ]);
    await expect(runtime.startTurn(rollbackTurnInput("turn_after_dispatch", "派发并继续"))).rejects.toThrow();
    expect(calls).toBe(1);
    const saved = JSON.stringify(store.snapshots.get("session_rollback")?.messages);
    expect(saved).toContain("work_dispatch");
    expect(saved).toContain("committed");
  });

  it("rolls a Turn's transcript back on request, for a failure only the caller can see", async () => {
    const faux = fauxProvider({ provider: "joi-explicit-rollback" });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, sessionStore: store, thinkingLevel: "off" as const, tools: [] });

    faux.setResponses([fauxAssistantMessage([fauxText("保留的回答")])]);
    await runtime.startTurn(rollbackTurnInput("turn_keep", "第一个问题"));
    faux.setResponses([fauxAssistantMessage([fauxText("要回滚的回答")])]);
    await runtime.startTurn(rollbackTurnInput("turn_undo", "第二个问题"));
    expect(JSON.stringify(store.snapshots.get("session_rollback")?.messages)).toContain("要回滚的回答");

    // The Turn ended normally; only the caller knows it failed — a recovery Turn that never
    // called the tool its gate required rejects after startTurn has already resolved.
    expect(await runtime.rollbackTurn("session_rollback", "turn_undo")).toBe(true);

    const saved = JSON.stringify(store.snapshots.get("session_rollback")?.messages);
    expect(saved).toContain("保留的回答");
    expect(saved).not.toContain("要回滚的回答");
    expect(saved).not.toContain("第二个问题");
  });

  it("removes every attempt of a Turn, not just the last one", async () => {
    const faux = fauxProvider({ provider: "joi-turn-attempts" });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, sessionStore: store, thinkingLevel: "off" as const, tools: [] });

    faux.setResponses([fauxAssistantMessage([fauxText("原回答")])]);
    await runtime.startTurn(rollbackTurnInput("turn_base", "原问题"));

    // The coordinator repairs an uncommitted outcome by continuing the same session, and every
    // attempt shares the turnId. Rolling back only the last would leave the earlier ones behind.
    faux.setResponses([
      fauxAssistantMessage([fauxText("第一次尝试")]),
      fauxAssistantMessage([fauxText("第二次尝试")]),
      fauxAssistantMessage([fauxText("第三次尝试")]),
    ]);
    await runtime.startTurn(rollbackTurnInput("turn_retry", "重试问题"));
    await runtime.startTurn(rollbackTurnInput("turn_retry", "重试问题"));
    await runtime.startTurn(rollbackTurnInput("turn_retry", "重试问题"));
    expect(await runtime.rollbackTurn("session_rollback", "turn_retry")).toBe(true);

    const saved = JSON.stringify(store.snapshots.get("session_rollback")?.messages);
    expect(saved).toContain("原回答");
    for (const attempt of ["第一次尝试", "第二次尝试", "第三次尝试", "重试问题"]) expect(saved).not.toContain(attempt);
  });

  it("reports a rollback it could not perform instead of silently keeping the failure", async () => {
    const faux = fauxProvider({ provider: "joi-rollback-miss" });
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({
      model: faux.getModel(),
      thinkingLevel: "off" as const,
      models,
      sessionStore: new MemorySessionStore(),
      tools: [],
    });
    // No Turn has marked a point for this session, so there is nothing to take back — the caller
    // needs the false to know the retry will inherit whatever the failed Turn wrote.
    expect(await runtime.rollbackTurn("session_unknown", "turn_unknown")).toBe(false);
  });

  it("leaves an empty assistant message out of the request a killed stream parked in the session", async () => {
    const faux = fauxProvider({ provider: "joi-empty-assistant" });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = new MemorySessionStore();
    // An assistant message with no content is not a legal request input, and this one survives
    // every save and restore. Re-sending it is the other half of the poisoning above: the filter
    // lives in request shaping, so it covers history read back from the store as well.
    await store.save({
      compaction: undefined,
      messages: [
        { content: [{ text: "先看这个", type: "text" }], role: "user", timestamp: 1 },
        { content: [], role: "assistant", stopReason: "error", timestamp: 2 },
        { content: [{ text: "继续", type: "text" }], role: "user", timestamp: 3 },
      ],
      modelRevisionId: "model_rev_1",
      sessionId: "session_empty_assistant",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      updatedAt: "2026-07-15T12:00:00.000Z",
      workbenchId: "workbench_1",
    });

    let seen: readonly unknown[] = [];
    faux.setResponses([(context) => {
      seen = context.messages;
      return fauxAssistantMessage([fauxText("好")]);
    }]);
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, sessionStore: store, thinkingLevel: "off" as const, tools: [] });
    await runtime.startTurn({
      workbenchId: "workbench_1",
      inputId: "input_empty_assistant",
      modelId: "contract-model",
      modelRevisionId: "model_rev_1",
      prompt: "接着做",
      sessionId: "session_empty_assistant",
      sourceId: "contract-source",
      sourceRevisionId: "source_rev_1",
      systemPrompt: "You are joi.",
      turnId: "turn_empty_assistant",
    });

    const empties = seen.filter((message) => {
      const record = message as { content?: unknown[]; role?: unknown };
      return record.role === "assistant" && Array.isArray(record.content) && record.content.length === 0;
    });
    expect(empties).toEqual([]);
  });
});
