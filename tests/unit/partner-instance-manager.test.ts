/* In-memory doubles keep instance lifecycle tests free of SQLite. */
/* eslint-disable @typescript-eslint/require-await */
import { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager.js";
import type { PartnerRunRequest } from "../../src/main/application/ports/partner-execution.js";
import type {
  PartnerEngineRuntime,
  PartnerInstanceRecord,
  PartnerInstanceRepository,
  PartnerInstanceMessageStore,
  ResidentTurnInput,
} from "../../src/main/application/ports/partner-instances.js";
import { createPartnerRevision, type PartnerRevision } from "../../src/main/domain/partners/partner.js";
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
  async setStatusBusy(instanceId: string, at: string) {
    const record = this.records.find((item) => item.instanceId === instanceId);
    if (record === undefined) return;
    record.lastUsedAt = at;
    record.status = "BUSY";
  }
}

class MemoryInstanceMessageStore implements PartnerInstanceMessageStore {
  readonly cleared: string[] = [];
  readonly saved = new Map<string, unknown[]>();
  async clear(instanceId: string) { this.cleared.push(instanceId); this.saved.delete(instanceId); }
  async load(instanceId: string) { return this.saved.get(instanceId) ?? null; }
  async save(instanceId: string, messages: unknown[]) { this.saved.set(instanceId, messages); }
}

class FakeEngine implements PartnerEngineRuntime {
  readonly ephemeralRuns: { knowledgeSection: string; request: PartnerRunRequest }[] = [];
  readonly evicted: string[] = [];
  readonly residentTurns: ResidentTurnInput[] = [];
  failResident = false;
  engineOf() { return "pi-core" as const; }
  evictFromMemory(instanceId: string) { this.evicted.push(instanceId); }
  async health() { return { available: true }; }
  toolOptions() { return [] as readonly string[]; }
  async runEphemeral(runRequest: PartnerRunRequest, _revision: PartnerRevision, context: { knowledgeSection: string; skillSection: string }) {
    this.ephemeralRuns.push({ knowledgeSection: context.knowledgeSection, request: runRequest });
    return {
      conversation: [
        { kind: "MARKDOWN" as const, role: "USER" as const, text: runRequest.taskProjection },
        { kind: "TOOL_CALL" as const, role: "TOOL" as const, text: "read", toolName: "read" },
        { kind: "MARKDOWN" as const, role: "AGENT" as const, text: "done" },
      ],
      externalRunId: `local_pi:${runRequest.actionId}`, output: { artifacts: [], body: "done" }, status: "COMPLETED" as const,
    };
  }
  async runResidentTurn(input: ResidentTurnInput) {
    this.residentTurns.push(input);
    if (this.failResident) throw new Error("turn_failed");
    const messages = [...(input.restoredMessages ?? []), { content: input.request.taskProjection, role: "user" }];
    return {
      externalRunId: `local_pi:${input.request.actionId}`,
      externalSessionRef: `partner_instance_messages:${input.instanceId}`,
      messages,
      output: { artifacts: [], body: "done" },
      status: "COMPLETED" as const,
    };
  }
}

function makeManager(limits?: { maxResidentGlobal?: number; maxResidentPerPartner?: number }) {
  const clock = new TestClock();
  const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
  const engine = new FakeEngine();
  const messages = new MemoryInstanceMessageStore();
  const repository = new MemoryInstanceRepository();
  const manager = new PartnerInstanceManager({
    clock,
    diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
    engines: new Map([["pi-core", engine]]),
    ids: new TestIds(),
    knowledge: { readForInjection: async () => "KB_SECTION" },
    ...(limits === undefined ? {} : { limits }),
    messages,
    registry: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "partner_revision_1", registryRevision: 1 }) },
    repository,
    revisions: { getActive: async () => revision },
    skills: { readInstructions: () => "" },
  });
  return { clock, diagnostics, engine, manager, messages, repository };
}

describe("partner-instance-manager", () => {
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
