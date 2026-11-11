/* In-memory doubles keep instance lifecycle tests free of SQLite. */
/* eslint-disable @typescript-eslint/require-await */
import { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager.js";
import type { NativeAgentEvent } from "../../src/main/application/ports/native-agent-events.js";
import type { PartnerRunRequest, PartnerRunStatus } from "../../src/main/application/ports/partner-execution.js";
import type { ToolTraceDraft } from "../../src/main/application/partners/tool-trace-presentation.js";
import type {
  PartnerEngineRuntime,
  PartnerInstanceRecord,
  PartnerInstanceRepository,
  PartnerInstanceMessageStore,
  ResidentTurnInput,
  ResidentTurnResult,
} from "../../src/main/application/ports/partner-instances.js";
import type { ModelSourceTurnPin } from "../../src/main/domain/model-sources/model-source.js";
import { createPartnerRevision, type PartnerRevision } from "../../src/main/domain/partners/partner.js";
import { DomainError } from "../../src/main/domain/errors.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const revision: PartnerRevision = createPartnerRevision({
  capabilities: ["code"], createdAt: "2026-07-29T10:00:00.000Z", displayName: "Local", kind: "local-pi",
  partnerId: "partner_1", partnerRevisionId: "partner_revision_1", registryRevision: 1,
  skills: [], tools: ["read"],
});

const request: PartnerRunRequest = { actionId: "action_1", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "do the work", workId: "work_1" };

class MemoryInstanceRepository implements PartnerInstanceRepository {
  readonly linked: [string, string][] = [];
  readonly records: PartnerInstanceRecord[] = [];
  async countActive(workbenchId: string, partnerId: string) { return this.records.filter((record) => record.workbenchId === workbenchId && record.partnerId === partnerId && record.status !== "DISPOSED").length; }
  async countActiveGlobal() { return this.records.filter((record) => record.status !== "DISPOSED").length; }
  async create(input: { workbenchId: string; createdAt: string; engine: PartnerRevision["engine"]; instanceId: string; partnerId: string; partnerRevisionId: string; sessionPolicy: PartnerInstanceRecord["sessionPolicy"] }) {
    const record: PartnerInstanceRecord = {
      workbenchId: input.workbenchId, createdAt: input.createdAt, engine: input.engine, instanceId: input.instanceId, lastUsedAt: input.createdAt,
      partnerId: input.partnerId, partnerRevisionId: input.partnerRevisionId, sessionPolicy: input.sessionPolicy, status: "IDLE",
    };
    this.records.push(record);
    return record;
  }
  async get(instanceId: string) { return this.records.find((record) => record.instanceId === instanceId) ?? null; }
  async linkDispatch(dispatchAttemptId: string, instanceId: string) { this.linked.push([dispatchAttemptId, instanceId]); }
  async listActive(filter?: { workbenchId?: string; partnerId?: string }) {
    return this.records.filter((record) => record.status !== "DISPOSED"
      && (filter?.workbenchId === undefined || record.workbenchId === filter.workbenchId)
      && (filter?.partnerId === undefined || record.partnerId === filter.partnerId));
  }
  async markDisposed(instanceId: string, reason: string, at: string) {
    const record = this.records.find((item) => item.instanceId === instanceId);
    if (record === undefined) return;
    record.disposalReason = reason;
    record.disposedAt = at;
    record.status = "DISPOSED";
  }
  async markTurnComplete(instanceId: string, at: string, externalSessionRef?: string) {
    const record = this.records.find((item) => item.instanceId === instanceId);
    if (record === undefined) return;
    if (externalSessionRef !== undefined) record.externalSessionRef = externalSessionRef;
    record.lastUsedAt = at;
    record.status = "IDLE";
  }
  async markSuspended(instanceId: string, at: string, externalSessionRef?: string) {
    await this.markTurnComplete(instanceId, at, externalSessionRef);
    const record = await this.get(instanceId);
    if (record !== null) record.status = "SUSPENDED";
  }
  async recoverCrashed() {
    let ephemeralDisposed = 0;
    let residentRecovered = 0;
    for (const record of this.records) {
      if (record.status !== "BUSY") continue;
      if (record.sessionPolicy === "RESIDENT") { record.status = "IDLE"; residentRecovered += 1; }
      else { record.disposalReason = "crash"; record.status = "DISPOSED"; ephemeralDisposed += 1; }
    }
    return { ephemeralDisposed, residentRecovered };
  }
  async setStatusBusy(instanceId: string, at: string, resume = false) {
    const record = this.records.find((item) => item.instanceId === instanceId);
    if (record === undefined || (record.status !== "IDLE" && !(resume && record.status === "SUSPENDED"))) return false;
    record.lastUsedAt = at;
    record.status = "BUSY";
    return true;
  }
}

class MemoryInstanceMessageStore implements PartnerInstanceMessageStore {
  readonly cleared: string[] = [];
  readonly saved = new Map<string, unknown[]>();
  async clear(instanceId: string) { this.cleared.push(instanceId); this.saved.delete(instanceId); }
  async load(instanceId: string) { return this.saved.get(instanceId) ?? null; }
  async save(instanceId: string, messages: unknown[]) { this.saved.set(instanceId, messages); }
}

function traceDraft(toolName: string): ToolTraceDraft {
  return { command: `${toolName} --private`, isError: false, result: "PRIVATE_TRACE_RESULT", toolCallId: `toolu_${toolName}`, toolName, truncated: false };
}

class FakeEngine implements PartnerEngineRuntime {
  readonly ephemeralRuns: { knowledgeSection: string; request: PartnerRunRequest; skillEnvironmentKeys?: readonly string[]; skillSection: string }[] = [];
  readonly evicted: string[] = [];
  readonly residentTurns: ResidentTurnInput[] = [];
  failEphemeral?: Error;
  failResident = false;
  includeEphemeralConversation = true;
  includeResidentConversation = false;
  pendingQuestion?: string;
  events: NativeAgentEvent[] = [];
  preflightPin?: ModelSourceTurnPin;
  engineOf() { return "pi-core" as const; }
  evictFromMemory(instanceId: string) { this.evicted.push(instanceId); }
  async health() { return { available: true }; }
  async preflight() { return this.preflightPin; }
  toolOptions() { return [] as readonly string[]; }
  async runEphemeral(runRequest: PartnerRunRequest, _revision: PartnerRevision, context: { onEvent?: (event: NativeAgentEvent) => void | Promise<void>; onProgress?: () => void; onToolTrace?: (trace: ToolTraceDraft) => void | Promise<void>; knowledgeSection: string; skillEnvironmentKeys?: readonly string[]; skillSection: string }) {
    context.onProgress?.();
    for (const event of this.events) await context.onEvent?.(event);
    await context.onToolTrace?.(traceDraft("read"));
    this.ephemeralRuns.push({
      knowledgeSection: context.knowledgeSection,
      request: runRequest,
      ...(context.skillEnvironmentKeys === undefined ? {} : { skillEnvironmentKeys: context.skillEnvironmentKeys }),
      skillSection: context.skillSection,
    });
    if (this.failEphemeral !== undefined) throw this.failEphemeral;
    const conversation = [
      { kind: "MARKDOWN" as const, role: "USER" as const, text: runRequest.taskProjection },
      { kind: "TOOL_CALL" as const, role: "TOOL" as const, text: "read", toolName: "read" },
      { kind: "MARKDOWN" as const, role: "AGENT" as const, text: "done" },
    ];
    const status: PartnerRunStatus = this.pendingQuestion === undefined ? "COMPLETED" : "WAITING_INPUT";
    return {
      ...(this.includeEphemeralConversation ? { conversation } : {}),
      externalRunId: `local_pi:${runRequest.actionId}`,
      output: { artifacts: [], body: "done", ...(this.pendingQuestion === undefined ? {} : { pendingQuestion: this.pendingQuestion }) },
      status,
    };
  }
  async runResidentTurn(input: ResidentTurnInput): Promise<ResidentTurnResult> {
    input.onProgress?.();
    for (const event of this.events) await input.onEvent?.(event);
    await input.onToolTrace?.(traceDraft("bash"));
    this.residentTurns.push(input);
    if (this.failResident) throw new Error("turn_failed");
    const messages = [...(input.restoredMessages ?? []), { content: input.request.taskProjection, role: "user" }];
    const status: PartnerRunStatus = this.pendingQuestion === undefined ? "COMPLETED" : "WAITING_INPUT";
    return {
      ...(this.includeResidentConversation ? { conversation: [{ kind: "MARKDOWN" as const, role: "AGENT" as const, text: "done" }] } : {}),
      externalRunId: `local_pi:${input.request.actionId}`,
      externalSessionRef: `partner_instance_messages:${input.instanceId}`,
      messages,
      output: { artifacts: [], body: "done", ...(this.pendingQuestion === undefined ? {} : { pendingQuestion: this.pendingQuestion }) },
      status,
    };
  }
}

function makeManager(
  limits?: { maxResidentGlobal?: number; maxResidentPerPartner?: number },
  skillOverrides?: Partial<{
    readInstructions: () => string;
    resolveForPi: () => { environmentKeys: readonly string[]; promptSection: string; skillCount: number };
    validateRefs: () => void;
  }>,
) {
  const clock = new TestClock();
  const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
  const engine = new FakeEngine();
  const messages = new MemoryInstanceMessageStore();
  const repository = new MemoryInstanceRepository();
  const manager = new PartnerInstanceManager({
    clock,
    diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
    engines: new Map([["pi-core", engine], ["claude-code", engine]]),
    ids: new TestIds(),
    knowledge: { readForInjection: async () => "KB_SECTION" },
    ...(limits === undefined ? {} : { limits }),
    messages,
    registry: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "partner_revision_1", registryRevision: 1 }) },
    repository,
    revisions: { getActive: async () => revision },
    skills: {
      readInstructions: skillOverrides?.readInstructions ?? (() => ""),
      resolveForPi: skillOverrides?.resolveForPi ?? (() => ({ environmentKeys: [], promptSection: "", skillCount: 0 })),
      validateRefs: skillOverrides?.validateRefs ?? (() => undefined),
    },
  });
  return { clock, diagnostics, engine, manager, messages, repository };
}

describe("partner-instance-manager", () => {
  it("AC-WR-05 requires the owning native engine to validate a suspended session", async () => {
    const { engine, manager } = makeManager();
    const reference = "native-agent:v1:claude:fixture-session";
    vi.spyOn(engine, "runResidentTurn").mockResolvedValueOnce({ externalRunId: "same", externalSessionRef: reference,
      output: { artifacts: [], body: "" }, status: "SUSPENDED" });
    const paused = await manager.dispatch({ revision: createPartnerRevision({ ...revision, engine: "claude-code" }), sessionPolicy: "EPHEMERAL",
      request: { ...request, workspaceExecution: { accessCeiling: "WRITE", generation: 1, phase: "READ_RUNNING" } } });
    if (paused.instanceId === undefined) throw new Error("missing_instance");
    expect(await manager.validateCheckpoint(paused.instanceId, reference)).toBe(false);
    const validate = vi.fn(async () => true);
    Object.assign(engine, { checkpointAvailable: validate });
    expect(await manager.validateCheckpoint(paused.instanceId, reference)).toBe(true);
    expect(await manager.validateCheckpoint(paused.instanceId, "another-reference")).toBe(false);
    expect(validate).toHaveBeenCalledOnce();
  });
  it.each(["EPHEMERAL", "RESIDENT"] as const)("AC-WR-02/05 keeps a suspended %s instance exclusive and resumes without another Agent", async sessionPolicy => {
    const { engine, manager, messages, repository, diagnostics, clock } = makeManager({ maxResidentPerPartner: 1 });
    vi.spyOn(engine, "runResidentTurn").mockResolvedValueOnce({ externalRunId: "same", messages: [{ role: "user", content: "checkpoint" }],
      output: { artifacts: [], body: "" }, status: "SUSPENDED" });
    const paused = await manager.dispatch({ request: { ...request, workspaceExecution: { accessCeiling: "WRITE", generation: 1, phase: "READ_RUNNING" } }, revision, sessionPolicy });
    expect(paused).toMatchObject({ status: "SUSPENDED", body: "" });
    expect(repository.records).toHaveLength(1);
    expect(repository.records[0]?.status).toBe("SUSPENDED");
    if (paused.instanceId === undefined || paused.checkpointRef === undefined) throw new Error("missing_checkpoint");
    expect(await manager.validateCheckpoint(paused.instanceId, paused.checkpointRef)).toBe(true);
    expect(await manager.validateCheckpoint("missing-instance", paused.checkpointRef)).toBe(false);
    expect(await manager.validateCheckpoint(paused.instanceId, "invalid-checkpoint")).toBe(false);
    vi.spyOn(messages, "load").mockRejectedValueOnce(new Error("corrupt_checkpoint"));
    expect(await manager.validateCheckpoint(paused.instanceId, paused.checkpointRef)).toBe(false);
    expect(diagnostics.some(event => event.event === "joi.partner.instance.completed")).toBe(false);
    clock.advance(60 * 60_000);
    expect(await manager.sweepIdleFor(request.workbenchId, clock.now())).toEqual({ disposed: 0, evicted: 0 });
    await manager.recoverOnBoot();
    expect(repository.records[0]?.status).toBe("SUSPENDED");
    await expect(manager.dispatch({ request, revision, instanceId: paused.instanceId })).rejects.toMatchObject({ code: "partner_instance_busy" });
    const resumed = await manager.dispatch({ instanceId: paused.instanceId, revision,
      request: { ...request, workspaceExecution: { accessCeiling: "WRITE", generation: 2, phase: "WRITE_RUNNING" } } });
    expect(resumed.instanceId).toBe(paused.instanceId);
    expect(repository.records).toHaveLength(1);
    expect(engine.residentTurns[0]?.restoredMessages).toEqual([{ role: "user", content: "checkpoint" }]);
    expect(repository.records[0]?.status).toBe(sessionPolicy === "EPHEMERAL" ? "DISPOSED" : "IDLE");
    expect(messages.cleared).toEqual(sessionPolicy === "EPHEMERAL" ? [paused.instanceId] : []);
  });
  it.each(["EPHEMERAL", "RESIDENT"] as const)("preserves the timestamped live timeline on %s completion", async (sessionPolicy) => {
    const { manager, engine, clock } = makeManager();
    const first = clock.now().toISOString();
    engine.events = [
      { type: "message", role: "agent", parts: [{ type: "text", text: "investigating" }] },
      { type: "tool_activity", toolCallId: "toolu_read", toolName: "read", state: "started" },
      { type: "tool_activity", toolCallId: "toolu_read", toolName: "read", state: "completed" },
      { type: "message", role: "agent", parts: [{ type: "text", text: "done" }] },
    ];
    const result = await manager.dispatch({ request, revision, sessionPolicy, onConversation: async () => { clock.advance(1000); } });
    expect(result.conversation).toHaveLength(4);
    expect(result.conversation?.[0]).toMatchObject({ text: "investigating", createdAt: first });
    expect(result.conversation?.[3]).toMatchObject({ text: "done", createdAt: new Date(new Date(first).getTime() + 3000).toISOString() });
  });
  it.each(["EPHEMERAL", "RESIDENT"] as const)("forwards activity without conversation projection for %s", async (sessionPolicy) => {
    const { manager } = makeManager();
    const onProgress = vi.fn();
    await manager.dispatch({ request, revision, sessionPolicy, onProgress });
    expect(onProgress).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["EPHEMERAL", "RESIDENT"] as const)("stamps the running instance onto %s tool traces", async (sessionPolicy) => {
    const { manager } = makeManager();
    const onToolTrace = vi.fn();
    const result = await manager.dispatch({ onToolTrace, request, revision, sessionPolicy });

    expect(onToolTrace).toHaveBeenCalledTimes(1);
    expect(onToolTrace).toHaveBeenCalledWith({ instanceId: result.instanceId, trace: traceDraft(sessionPolicy === "EPHEMERAL" ? "read" : "bash") });
  });

  it("leaves the private tool body out of everything the dispatch returns", async () => {
    const { manager } = makeManager();
    const result = await manager.dispatch({ onToolTrace: vi.fn(), request, revision, sessionPolicy: "EPHEMERAL" });
    // The trace travels only on its own channel; the conversation projection stays payload-free.
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TRACE_RESULT");
  });

  it("passes the preflight source pin into resident turns", async () => {
    const { engine, manager } = makeManager();
    engine.preflightPin = {
      modelId: "model-b",
      modelRevisionId: "model-revision-b",
      sourceId: "source-b",
      sourceRevisionId: "source-revision-b",
      turnId: request.actionId,
    };

    await manager.dispatch({ request, revision, sessionPolicy: "RESIDENT" });

    expect(engine.residentTurns[0]?.sourcePin).toEqual(engine.preflightPin);
  });
  it("CHAT-04 rejects a settings revision changed after conversation submission before creating an instance", async () => {
    const { engine,manager,repository } = makeManager();
    engine.preflightPin = { sourceId: "network",sourceRevisionId: "new-source",modelId: "model",modelRevisionId: "new-model",turnId: request.actionId };
    await expect(manager.dispatch({ request,revision,expectedSource: { sourceId: "network",sourceRevisionId: "old-source",modelRevisionId: "old-model" } }))
      .rejects.toMatchObject({ code: "conversation_configuration_changed" });
    expect(repository.records).toHaveLength(0);
    expect(engine.residentTurns).toHaveLength(0);
  });
  it("CHAT-05 releases a stopped conversation's suspended ephemeral checkpoint without disposing an active run", async () => {
    const { manager,repository,engine } = makeManager();
    const record = await repository.create({ workbenchId: request.workbenchId,createdAt: "2026-11-11",engine: "pi-core",instanceId: "suspended-chat",partnerId: revision.partnerId,partnerRevisionId: revision.partnerRevisionId,sessionPolicy: "EPHEMERAL" });
    record.status = "BUSY";
    await manager.abandonSuspended({ workbenchId: request.workbenchId,instanceId: record.instanceId });
    expect(record.status).toBe("BUSY");
    record.status = "SUSPENDED";
    await manager.abandonSuspended({ workbenchId: request.workbenchId,instanceId: record.instanceId });
    expect(record.status).toBe("DISPOSED");
    expect(engine.evicted).toContain(record.instanceId);
  });

  it("classifies an unavailable requested instance as a safe preflight failure", async () => {
    const { diagnostics, engine, manager } = makeManager();
    await expect(manager.dispatch({ dispatchAttemptId: "attempt_opaque", instanceId: "PRIVATE_INSTANCE_REFERENCE", request, revision }))
      .rejects.toMatchObject({
        code: "partner_instance_unavailable",
        partnerRunFailure: { phase: "EXECUTION", reasonCode: "partner_instance_unavailable", sideEffectState: "NONE" },
      });
    expect(engine.ephemeralRuns).toHaveLength(0);
    expect(diagnostics.find((entry) => entry.event === "joi.partner.dispatch.preflight_failed")?.fields).toMatchObject({
      dispatchAttemptId: "attempt_opaque",
      phase: "EXECUTION",
      reasonCode: "partner_instance_unavailable",
      sideEffectState: "NONE",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_INSTANCE_REFERENCE");
  });

  it("binds every instance to one Workbench and rejects cross-Workbench reuse", async () => {
    const { manager } = makeManager();
    const instance = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    expect(instance).toMatchObject({ workbenchId: "workbench_1" });
    await expect(manager.dispatch({
      instanceId: instance.instanceId,
      request: { ...request, workbenchId: "workbench_2" },
      revision,
    })).rejects.toMatchObject({ code: "partner_instance_workbench_mismatch" });
    await expect(manager.dispose({ workbenchId: "workbench_2", instanceId: instance.instanceId, reason: "wrong scope" }))
      .rejects.toMatchObject({ code: "partner_instance_workbench_mismatch" });
  });

  it("lists instances only inside the requested Workbench", async () => {
    const { manager } = makeManager();
    await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    await manager.ensure({ workbenchId: "workbench_2", partnerId: "partner_1" });
    await expect(manager.list({ workbenchId: "workbench_1", partnerId: "partner_1" }))
      .resolves.toEqual([expect.objectContaining({ workbenchId: "workbench_1" })]);
  });

  it("enforces resident caps per partner and globally", async () => {
    const perPartner = makeManager({ maxResidentPerPartner: 1 });
    await perPartner.manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    await expect(perPartner.manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" })).rejects.toMatchObject({ code: "partner_instance_cap_exceeded" });

    const global = makeManager({ maxResidentGlobal: 1, maxResidentPerPartner: 4 });
    await global.manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    await expect(global.manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_2" })).rejects.toMatchObject({ code: "partner_instance_cap_exceeded" });
  });

  it("runs ephemeral dispatches once, then disposes them and clears their messages", async () => {
    const { diagnostics, engine, manager, messages, repository } = makeManager();
    const result = await manager.dispatch({ dispatchAttemptId: "attempt_1", request, revision });
    expect(result).toMatchObject({ actionId: "action_1", externalRunId: "local_pi:action_1", status: "COMPLETED" });
    expect(result.conversation).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "TOOL_CALL", toolName: "read" })]));
    expect(engine.ephemeralRuns[0]).toMatchObject({ knowledgeSection: "KB_SECTION" });
    const record = repository.records[0];
    expect(record).toMatchObject({ disposalReason: "ephemeral_completed", sessionPolicy: "EPHEMERAL", status: "DISPOSED" });
    expect(messages.cleared).toContain(record?.instanceId);
    expect(repository.linked).toEqual([["attempt_1", record?.instanceId]]);
    expect(diagnostics.find((entry) => entry.event === "joi.partner.instance.started")?.fields).toMatchObject({
      actionId: "action_1",
      workbenchId: "workbench_1",
      dispatchAttemptId: "attempt_1",
      instanceId: record?.instanceId,
      sessionPolicy: "EPHEMERAL",
      workId: "work_1",
    });
    expect(diagnostics.find((entry) => entry.event === "joi.partner.instance.completed")?.fields)
      .toMatchObject({ instanceId: record?.instanceId, status: "COMPLETED" });
  });

  it("replaces a disposed ephemeral instance reference with a fresh one-shot instance", async () => {
    const { manager, repository } = makeManager();
    const stale = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1", sessionPolicy: "EPHEMERAL" });
    await manager.dispose({ workbenchId: "workbench_1", instanceId: stale.instanceId, reason: "idle" });

    const result = await manager.dispatch({
      dispatchAttemptId: "attempt_rebound",
      instanceId: stale.instanceId,
      request: { ...request, actionId: "action_rebound" },
      revision,
    });

    expect(result).toMatchObject({ actionId: "action_rebound", status: "COMPLETED" });
    expect(repository.records).toHaveLength(2);
    expect(repository.records[0]).toMatchObject({ instanceId: stale.instanceId, status: "DISPOSED" });
    expect(repository.records[1]).toMatchObject({ sessionPolicy: "EPHEMERAL", status: "DISPOSED" });
    expect(repository.records[1]?.instanceId).not.toBe(stale.instanceId);
    expect(repository.linked).toEqual([["attempt_rebound", repository.records[1]?.instanceId]]);
  });

  it("does not replace a disposed resident instance because its conversation is not resumable", async () => {
    const { manager, repository } = makeManager();
    const stale = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1", sessionPolicy: "RESIDENT" });
    await manager.dispose({ workbenchId: "workbench_1", instanceId: stale.instanceId, reason: "explicit" });

    await expect(manager.dispatch({ instanceId: stale.instanceId, request, revision }))
      .rejects.toMatchObject({ code: "partner_instance_unavailable" });
    expect(repository.records).toHaveLength(1);
  });

  it("propagates credential questions and optional conversations for both session policies", async () => {
    const { engine, manager } = makeManager();
    engine.pendingQuestion = "configure TAVILY_API_KEY and restart";
    engine.includeEphemeralConversation = false;
    const ephemeral = await manager.dispatch({ request, revision });
    expect(ephemeral).toMatchObject({ pendingQuestion: engine.pendingQuestion, status: "WAITING_INPUT" });
    expect(ephemeral.conversation).toBeUndefined();

    engine.includeResidentConversation = true;
    const resident = await manager.dispatch({
      dispatchAttemptId: "attempt_resident_waiting",
      request: { ...request, actionId: "action_resident" },
      revision,
      sessionPolicy: "RESIDENT",
    });
    expect(resident).toMatchObject({ pendingQuestion: engine.pendingQuestion, status: "WAITING_INPUT" });
    expect(resident.conversation).toEqual([expect.objectContaining({ role: "AGENT" })]);
  });

  it("disposes a failed ephemeral run and preserves bounded diagnostic detail", async () => {
    const { diagnostics, engine, manager, repository } = makeManager();
    engine.failEphemeral = Object.assign(new Error("partner failed"), { detail: "safe diagnostic detail" });
    await expect(manager.dispatch({ dispatchAttemptId: "attempt_failed", request, revision })).rejects.toThrow("partner failed");
    expect(repository.records[0]).toMatchObject({ disposalReason: "ephemeral_failed", status: "DISPOSED" });
    expect(diagnostics.find((entry) => entry.event === "joi.partner.instance.failed")?.fields).toMatchObject({
      dispatchAttemptId: "attempt_failed",
      errorDetail: "safe diagnostic detail",
    });
  });

  it("dispatches Pi SDK Skill metadata without eagerly injecting instructions", async () => {
    const { diagnostics, engine, manager } = makeManager(undefined, {
      readInstructions: () => { throw new Error("Pi must not eagerly read the Skill body"); },
      resolveForPi: () => ({ environmentKeys: ["TAVILY_API_KEY"], promptSection: "<available_skills><name>demo</name></available_skills>", skillCount: 1 }),
    });
    await manager.dispatch({ request, revision: { ...revision, skills: ["claude-code/demo-skill"] } });
    expect(engine.ephemeralRuns[0]?.skillSection).toContain("<available_skills>");
    expect(engine.ephemeralRuns[0]?.skillEnvironmentKeys).toEqual(["TAVILY_API_KEY"]);
    expect(diagnostics.find((entry) => entry.event === "joi.partner.skills.injected")?.fields).toMatchObject({
      instanceId: "partner_instance_test_0001", skillCount: 1,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Selected skills");

    const instance = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    await manager.dispatch({ instanceId: instance.instanceId, request: { ...request, actionId: "action_resident_skill" }, revision: { ...revision, skills: ["claude-code/demo-skill"] } });
    expect(engine.residentTurns[0]?.skillEnvironmentKeys)
      .toEqual(["TAVILY_API_KEY"]);
  });

  it("classifies an invalid selected Skill before BUSY/model execution and disposes the ephemeral shell", async () => {
    const { diagnostics, engine, manager, repository } = makeManager(undefined, {
      validateRefs: () => { throw new DomainError("partner_skill_not_found", "Selected partner skill is not available."); },
    });
    await expect(manager.dispatch({ dispatchAttemptId: "attempt_invalid_skill", request, revision: { ...revision, skills: ["claude-code/missing"] } }))
      .rejects.toMatchObject({
        code: "partner_skill_not_found",
        partnerRunFailure: { phase: "CONFIGURATION", sideEffectState: "NONE" },
      });
    expect(engine.ephemeralRuns).toHaveLength(0);
    expect(repository.records[0]).toMatchObject({ disposalReason: "skill_configuration_failed", status: "DISPOSED" });
    expect(diagnostics.find((entry) => entry.event === "joi.partner.instance.started")).toBeUndefined();
    expect(diagnostics.find((entry) => entry.event === "joi.partner.instance.failed")?.fields).toMatchObject({ errorCode: "partner_skill_not_found" });
  });

  it("keeps full Skill instruction injection for the local CLI compatibility engines", async () => {
    const { engine, manager } = makeManager(undefined, {
      readInstructions: () => "# Selected skills\nCLI_SKILL_BODY",
      resolveForPi: () => { throw new Error("CLI must not use Pi dispatch metadata"); },
    });
    await manager.dispatch({
      request,
      revision: { ...revision, engine: "claude-code", skills: ["claude-code/demo"] },
    });
    expect(engine.ephemeralRuns[0]?.skillSection).toContain("CLI_SKILL_BODY");
    expect(engine.ephemeralRuns[0]?.skillEnvironmentKeys).toEqual([]);
  });

  it("fails a legacy Pi revision closed when its narrowed tool allowlist omitted read", async () => {
    const { engine, manager } = makeManager(undefined, {
      resolveForPi: () => { throw new Error("must fail before SDK dispatch"); },
    });
    const legacyRevision = { ...revision };
    delete legacyRevision.toolPolicyMode;
    await expect(manager.dispatch({
      request,
      revision: { ...legacyRevision, skills: ["agents/demo"], tools: ["edit"] },
    })).rejects.toMatchObject({
      code: "partner_skill_requires_read",
      partnerRunFailure: { phase: "CONFIGURATION", sideEffectState: "NONE" },
    });
    expect(engine.ephemeralRuns).toHaveLength(0);
  });

  it("keeps a resident instance IDLE when Skill configuration fails before its turn starts", async () => {
    const { manager, repository } = makeManager(undefined, {
      validateRefs: () => { throw new DomainError("partner_skill_ref_invalid", "Partner skill reference is invalid."); },
    });
    const instance = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    await expect(manager.dispatch({
      instanceId: instance.instanceId,
      request,
      revision: { ...revision, skills: ["invalid-ref"] },
    })).rejects.toMatchObject({
      partnerRunFailure: { phase: "CONFIGURATION", sideEffectState: "NONE" },
    });
    expect(repository.records.find((record) => record.instanceId === instance.instanceId)?.status).toBe("IDLE");
  });

  it("keeps resident instances resumable: messages persist, status returns to IDLE and the data source is recorded", async () => {
    const { engine, manager, messages, repository } = makeManager();
    const instance = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    expect(instance).toMatchObject({ sessionPolicy: "RESIDENT", status: "IDLE" });

    await manager.dispatch({ instanceId: instance.instanceId, request, revision });
    expect(messages.saved.get(instance.instanceId)).toHaveLength(1);
    const record = repository.records.find((item) => item.instanceId === instance.instanceId);
    expect(record).toMatchObject({ externalSessionRef: `partner_instance_messages:${instance.instanceId}`, status: "IDLE" });

    await manager.dispatch({ instanceId: instance.instanceId, request: { ...request, actionId: "action_2" }, revision });
    expect(messages.saved.get(instance.instanceId)).toHaveLength(2);
    expect(engine.residentTurns[1]?.restoredMessages).toHaveLength(1);
  });

  it("rejects instance misuse: wrong partner, busy and missing instances", async () => {
    const { manager, repository } = makeManager();
    const instance = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    const otherRevision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-29T10:00:00.000Z", displayName: "Other", kind: "local-pi",
      partnerId: "partner_2", partnerRevisionId: "partner_revision_2", registryRevision: 2, skills: [], tools: [],
    });
    await expect(manager.dispatch({ instanceId: instance.instanceId, request, revision: otherRevision }))
      .rejects.toMatchObject({ code: "partner_instance_partner_mismatch" });

    await repository.setStatusBusy(instance.instanceId, "2026-07-29T10:05:00.000Z");
    await expect(manager.dispatch({ instanceId: instance.instanceId, request, revision }))
      .rejects.toMatchObject({ code: "partner_instance_busy" });
    await repository.markTurnComplete(instance.instanceId, "2026-07-29T10:06:00.000Z");

    await expect(manager.dispatch({ instanceId: "missing_instance", request, revision }))
      .rejects.toMatchObject({ code: "partner_instance_unavailable" });
  });

  it("returns a failed resident turn to IDLE so the conversation stays resumable", async () => {
    const { engine, manager, repository } = makeManager();
    const instance = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    engine.failResident = true;
    await expect(manager.dispatch({ instanceId: instance.instanceId, request, revision })).rejects.toThrow("turn_failed");
    const record = repository.records.find((item) => item.instanceId === instance.instanceId);
    expect(record?.status).toBe("IDLE");
  });

  it("disposes instances on demand, evicting warm state and keeping resident messages", async () => {
    const { engine, manager, messages, repository } = makeManager();
    const instance = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    await manager.dispatch({ instanceId: instance.instanceId, request, revision });
    await manager.dispose({ workbenchId: "workbench_1", instanceId: instance.instanceId, reason: "goal_complete" });
    const record = repository.records.find((item) => item.instanceId === instance.instanceId);
    expect(record).toMatchObject({ disposalReason: "goal_complete", status: "DISPOSED" });
    expect(engine.evicted).toContain(instance.instanceId);
    expect(messages.saved.has(instance.instanceId)).toBe(true);
    await expect(manager.dispose({ workbenchId: "workbench_1", instanceId: instance.instanceId, reason: "again" })).resolves.toBeUndefined();
  });

  it("treats missing disposal as idempotent and rejects disposal while busy", async () => {
    const { manager, repository } = makeManager();
    await expect(manager.dispose({ workbenchId: "workbench_1", instanceId: "missing", reason: "cleanup" })).resolves.toBeUndefined();
    const instance = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    await repository.setStatusBusy(instance.instanceId, "2026-07-29T10:05:00.000Z");
    await expect(manager.dispose({ workbenchId: "workbench_1", instanceId: instance.instanceId, reason: "cleanup" }))
      .rejects.toMatchObject({ code: "partner_instance_busy" });
  });

  it("sweeps idle ephemerals and evicts warm residents without disposing them", async () => {
    const { clock, engine, manager, repository } = makeManager();
    await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1", sessionPolicy: "EPHEMERAL" });
    clock.advance(31 * 60_000);
    const swept = await manager.sweepIdleFor("workbench_1", clock.now());
    expect(swept).toEqual({ disposed: 1, evicted: 1 });
    const statuses = repository.records.map((record) => `${record.sessionPolicy}:${record.status}`);
    expect(statuses).toContain("EPHEMERAL:DISPOSED");
    expect(statuses).toContain("RESIDENT:IDLE");
    // The disposed ephemeral is also evicted from warm state, so two eviction calls in total.
    expect(engine.evicted).toHaveLength(2);
  });

  it("recovers crashed instances at boot: resident returns to IDLE, ephemeral is disposed", async () => {
    const { manager, repository } = makeManager();
    const resident = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1" });
    const ephemeral = await manager.ensure({ workbenchId: "workbench_1", partnerId: "partner_1", sessionPolicy: "EPHEMERAL" });
    await repository.setStatusBusy(resident.instanceId, "2026-07-29T10:00:00.000Z");
    await repository.setStatusBusy(ephemeral.instanceId, "2026-07-29T10:00:00.000Z");
    await expect(manager.recoverOnBoot()).resolves.toEqual({ ephemeralDisposed: 1, residentRecovered: 1 });
    expect(repository.records.find((record) => record.instanceId === resident.instanceId)?.status).toBe("IDLE");
    expect(repository.records.find((record) => record.instanceId === ephemeral.instanceId)?.status).toBe("DISPOSED");
  });
});
