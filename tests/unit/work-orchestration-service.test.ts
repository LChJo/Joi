/* In-memory orchestration ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import type { PartnerInstanceRecord } from "../../src/main/application/ports/partner-instances.js";
import type { CommittedWorkPlan, ReassignedWorkPlan, WorkPlanRepository, WorkReassignmentContext } from "../../src/main/application/ports/work-orchestration.js";
import type { WorkItem } from "../../src/main/domain/work/work.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("work orchestration outbox", () => {
  it.each(["preparation", "commit", "event"] as const)("signals durable submission before a %s failure can occur", async phase => {
    const order: string[] = [];
    const service = new WorkOrchestrationService({ clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async partnerId => {
        if (phase === "preparation") throw new Error("Synthetic preparation failure");
        return { partnerId, partnerRevisionId: "revision", registryRevision: 1 };
      } }, policy: { evaluate: async () => ({ allowed: true }) },
      repository: { commit: async () => { order.push("commit"); if (phase === "commit") throw new Error("Synthetic commit failure"); } },
      events: { emit: async () => { order.push("event"); throw new Error("Synthetic postcommit failure"); } },
    });
    const request = { workbenchId: "wb", inputId: "goal", turnId: "turn", dependencies: [], onCommitStart: () => { order.push("submission"); },
      work: [{ key: "a", title: "Synthetic", partnerId: "p", accessMode: "READ" as const, instructions: "Synthetic task", acceptanceChecks: [{ kind: "BODY_PRESENT" as const }] }] };
    await expect(service.plan(request)).rejects.toThrow();
    expect(order).toEqual(phase === "preparation" ? [] : phase === "commit" ? ["submission", "commit"] : ["submission", "commit", "event"]);
  });

  it("AC-43 validates explicit goal evidence before dispatch and preserves reference order", async () => {
    const assertReferences = vi.fn(async (): Promise<void> => { throw new Error("invalid reference"); });
    const commit = vi.fn(async (_plan: CommittedWorkPlan) => undefined);
    const service = new WorkOrchestrationService({ clock: new TestClock(), ids: new TestIds(),
      evidence: { assertReferences }, repository: { commit },
      partners: { pinForDispatch: async partnerId => ({ partnerId,partnerRevisionId: "r",registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) } });
    const request = { workbenchId: "wb", inputId: "goal", turnId: "turn", dependencies: [], work: [{ evidenceResultIds: ["middle"], key: "read", title: "Read", partnerId: "p", accessMode: "NONE" as const, instructions: "Read the cited evidence.", acceptanceChecks: [{ kind: "BODY_PRESENT" as const }] }] };
    await expect(service.plan(request)).rejects.toThrow("invalid reference");
    expect(commit).not.toHaveBeenCalled();
    expect(assertReferences).toHaveBeenCalledWith({ goalInputId: "goal",workbenchId: "wb",resultIds: ["middle"] });
    assertReferences.mockResolvedValue(undefined);
    await service.plan(request);
    expect(commit.mock.calls[0]?.[0].briefs[0]).toMatchObject({ evidenceResultIds: ["middle"] });
  });
  it("AC-WR-07 rejects conflicting READ resumes and reassignments without changing the Work", async () => {
    const reassign = vi.fn(async () => undefined);
    const item: WorkItem = { accessMode: "READ",workbenchId: "wb",workId: "w",status: "WAITING",title: "Verify",createdAt: "2026-10-13T00:00:00Z",updatedAt: "2026-10-13T00:00:00Z" };
    const service = new WorkOrchestrationService({ clock: new TestClock(),ids: new TestIds(),
      partners: { pinForDispatch: async partnerId => ({ partnerId,partnerRevisionId: "new",registryRevision: 2,minimumAccessMode: "WRITE" as const }) },
      policy: { evaluate: async () => ({ allowed: true }) },repository: { commit: async () => undefined },
      reassignment: { cancel: async () => ({ canceled: false,cascadedWorkIds: [] }),reassign,
        loadForReassignment: async () => ({ item,executionNeeds: ["SHELL" as const],lastPartnerId: "p",lastPartnerRevisionId: "old" }) } });
    await expect(service.resume({ workbenchId: "wb",workId: "w",turnId: "t",instructions: "Save a report.",executionNeeds: ["FILE_WRITE"] })).rejects.toMatchObject({ code: "work_execution_access_conflict" });
    await expect(service.reassign({ workbenchId: "wb",workId: "w",turnId: "t",partnerId: "p",instructions: "Run the verifier." })).rejects.toMatchObject({ code: "work_execution_access_conflict" });
    expect(item.accessMode).toBe("READ");
    expect(reassign).not.toHaveBeenCalled();
  });
  it.each(["SHELL", "FILE_WRITE"] as const)("AC-WR-07 rejects READ needing %s without committing any Work", async need => {
    const commit = vi.fn(async (_plan: CommittedWorkPlan) => undefined);
    const service = new WorkOrchestrationService({ clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async partnerId => ({ partnerId, partnerRevisionId: "r", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit } });
    await expect(service.plan({ workbenchId: "wb", inputId: "input", turnId: "turn", dependencies: [], work: [
      { key: "valid", title: "Read", partnerId: "p", accessMode: "READ", executionNeeds: [], instructions: "Read an existing file.", acceptanceChecks: [{ kind: "BODY_PRESENT" }] },
      { key: "conflict", title: "Verify", partnerId: "p", accessMode: "READ", executionNeeds: [need], instructions: "Run the CLI and save a report.", acceptanceChecks: [{ kind: "FILE_EXISTS", relativePath: "report.md" }] },
    ] })).rejects.toMatchObject({ code: "work_execution_access_conflict" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("AC-WR-07 persists declared needs without requiring writes for existing-file checks", async () => {
    const commit = vi.fn(async (_plan: CommittedWorkPlan) => undefined);
    const service = new WorkOrchestrationService({ clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async partnerId => ({ partnerId, partnerRevisionId: "r", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit } });
    await service.plan({ workbenchId: "wb", inputId: "input", turnId: "turn", dependencies: [], work: [
      { key: "read", title: "Read", partnerId: "p", accessMode: "READ", executionNeeds: [], instructions: "Check the existing file.", acceptanceChecks: [{ kind: "FILE_EXISTS", relativePath: "report.md" }] },
    ] });
    expect(commit.mock.calls[0]?.[0].briefs[0]).toMatchObject({ executionNeeds: [] });
  });

  it("AC-WR-07 requires declared file writes for a local artifact deliverable", async () => {
    const commit = vi.fn(async (_plan: CommittedWorkPlan) => undefined);
    const service = new WorkOrchestrationService({ clock: new TestClock(),ids: new TestIds(),
      partners: { pinForDispatch: async partnerId => ({ partnerId,partnerRevisionId: "r",registryRevision: 1,localExecution: { engine: "pi-core" as const,shell: true,fileWrites: true } }) },
      policy: { evaluate: async () => ({ allowed: true }) },repository: { commit } });
    await expect(service.plan({ workbenchId: "wb",inputId: "input",turnId: "turn",dependencies: [],work: [{
      key: "artifact",title: "Report",partnerId: "p",accessMode: "READ",executionNeeds: [],instructions: "Create a report.",acceptanceChecks: [{ kind: "ARTIFACT_PRESENT",name: "report.md" }],
    }] })).rejects.toMatchObject({ code: "work_execution_access_conflict" });
    expect(commit).not.toHaveBeenCalled();
  });
  it.each([undefined, "", " \n\t", "x".repeat(12_001)])("rejects invalid independent instructions before any plan side effect", async (instructions) => {
    const commit = vi.fn(async () => undefined);
    const pinForDispatch = vi.fn(async (partnerId: string) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }));
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(), partners: { pinForDispatch },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit },
    });
    await expect(service.plan({
      workbenchId: "workbench-1", inputId: "input-1", turnId: "turn-1", dependencies: [],
      work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "NONE", key: "read", partnerId: "partner", title: "读取", ...(instructions === undefined ? {} : { instructions }) }],
    })).rejects.toMatchObject({ code: "work_instructions_invalid" });
    expect(commit).not.toHaveBeenCalled();
    expect(pinForDispatch).not.toHaveBeenCalled();
  });

  it("normalizes Skill work before building waves and checking workspace policy", async () => {
    const committed: CommittedWorkPlan[] = [];
    const evaluate = vi.fn(async (_item: WorkItem) => ({ allowed: true }));
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1, minimumAccessMode: "WRITE" as const }) },
      policy: { evaluate }, repository: { commit: async (plan) => { committed.push(plan); } },
    });
    await service.plan({ workbenchId: "workbench-1", inputId: "input-1", turnId: "turn-1", dependencies: [], work: [
      { key: "skill-a", title: "Analyze tasks", partnerId: "partner", accessMode: "NONE", acceptanceChecks: [{ kind: "BODY_PRESENT" }], instructions: "Use the selected skill", sessionPolicy: "EPHEMERAL" },
      { instructions: "Complete this scoped deliverable.", key: "skill-b", title: "Analyze more", partnerId: "partner", accessMode: "READ", acceptanceChecks: [{ kind: "BODY_PRESENT" }] },
    ] });
    expect(committed[0]?.items.map((item) => item.accessMode)).toEqual(["WRITE", "READ"]);
    expect(committed[0]?.waves).toHaveLength(1);
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ accessMode: "WRITE" });
    expect(committed[0]?.attempts[0]?.outbox.payload).toMatchObject({ sessionPolicy: "EPHEMERAL" });
    expect(committed[0]?.briefs[0]).toMatchObject({ instructions: "Use the selected skill" });
  });

  const idleInstance: PartnerInstanceRecord = {
    workbenchId: "workbench-1", createdAt: "2026-07-29T10:00:00.000Z", engine: "pi-core", instanceId: "instance-1",
    lastUsedAt: "2026-07-29T10:00:00.000Z", partnerId: "partner-a", partnerRevisionId: "revision",
    sessionPolicy: "RESIDENT", status: "IDLE",
  };

  it.each([
    { code: "partner_instance_unavailable", instance: null, label: "missing" },
    { code: "partner_instance_workbench_mismatch", instance: { ...idleInstance, workbenchId: "workbench-2" }, label: "another Workbench" },
    { code: "partner_instance_partner_mismatch", instance: { ...idleInstance, partnerId: "partner-b" }, label: "another partner" },
    { code: "partner_instance_busy", instance: { ...idleInstance, status: "BUSY" as const }, label: "busy" },
    { code: "partner_instance_unavailable", instance: { ...idleInstance, status: "DISPOSED" as const }, label: "disposed" },
  ])("rejects a $label instance before committing the plan", async ({ code, instance }) => {
    const committed: CommittedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(), instances: { get: async () => instance },
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) },
      repository: { commit: async (plan) => { committed.push(plan); } },
    });

    await expect(service.plan({
      workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn-1",
      work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instanceId: "instance-1", instructions: "Complete this scoped deliverable.", key: "read", partnerId: "partner-a", title: "读取" }],
    })).rejects.toMatchObject({ code });
    expect(committed).toEqual([]);
  });

  it("rejects ambiguous instance and session selection before repository access", async () => {
    const get = vi.fn(async () => idleInstance);
    const commit = vi.fn(async () => undefined);
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(), instances: { get },
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit },
    });
    await expect(service.plan({
      workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn-1",
      work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instanceId: "instance-1", instructions: "Complete this scoped deliverable.", key: "read", partnerId: "partner-a", sessionPolicy: "RESIDENT", title: "读取" }],
    })).rejects.toMatchObject({ code: "partner_instance_selection_ambiguous" });
    expect(get).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits an exact IDLE instance reference", async () => {
    const committed: CommittedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(), instances: { get: async () => idleInstance },
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) },
      repository: { commit: async (plan) => { committed.push(plan); } },
    });
    await service.plan({
      workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn-1",
      work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instanceId: "instance-1", instructions: "Complete this scoped deliverable.", key: "read", partnerId: "partner-a", title: "读取" }],
    });
    expect(committed[0]?.attempts[0]?.outbox.payload).toMatchObject({ instanceId: "instance-1" });
  });

  it("rejects caller-supplied workspace refs because Workbench owns cwd", async () => {
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit: async () => undefined },
    });
    await expect(service.plan({
      workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn", work: [
        { accessMode: "WRITE", instructions: "Complete this scoped deliverable.", key: "write", partnerId: "partner", title: "写入", workspaceRef: "caller-path" },
      ],
    })).rejects.toMatchObject({ code: "work_workspace_forbidden" });
  });

  it("rejects absolute acceptance paths before creating a dispatch", async () => {
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit: async () => undefined },
    });
    await expect(service.plan({
      workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn", work: [
        { acceptanceChecks: [{ kind: "FILE_EXISTS", relativePath: "C:\\Users\\owner\\report.md" }], accessMode: "READ", instructions: "Complete this scoped deliverable.", key: "read", partnerId: "partner", title: "读取" },
      ],
    })).rejects.toMatchObject({ code: "work_acceptance_path_invalid" });
  });

  it("rejects Work without any acceptance check so nothing dispatches unverifiable", async () => {
    const committed: CommittedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit: async (plan) => { committed.push(plan); } },
    });
    await expect(service.plan({
      workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn", work: [
        { accessMode: "READ", instructions: "Complete this scoped deliverable.", key: "read", partnerId: "partner", title: "读取" },
      ],
    })).rejects.toMatchObject({ code: "work_acceptance_checks_required" });
    await expect(service.plan({
      workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn", work: [
        { acceptanceChecks: [], accessMode: "READ", instructions: "Complete this scoped deliverable.", key: "read", partnerId: "partner", title: "读取" },
      ],
    })).rejects.toMatchObject({ code: "work_acceptance_checks_required" });
    expect(committed).toEqual([]);
  });

  it("persists the DAG, immutable partner pins and dispatch outbox records as one plan", async () => {
    const committed: CommittedWorkPlan[] = [];
    const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
    const repository: WorkPlanRepository = { commit: async (plan) => { committed.push(structuredClone(plan)); } };
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: `${partnerId}-revision`, registryRevision: 7 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository,
    });
    const result = await service.plan({
      workbenchId: "workbench-1",
      dependencies: [{ dependsOnKey: "research", workKey: "write" }],
      inputId: "input-1",
      turnId: "turn-1",
      work: [
        { acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instructions: "Complete this scoped deliverable.", key: "research", partnerId: "partner-a", title: "研究" },
        {
          acceptanceChecks: [{ kind: "FILE_CONTAINS_EXACT", relativePath: "hello.txt", expectedText: "hellow" }],
          accessMode: "WRITE", instructions: "保留原始拼写", key: "write", partnerId: "partner-b", title: "写入",
        },
      ],
    });
    expect(result.waves).toHaveLength(2);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.inputId).toBe("input-1");
    expect(committed[0]?.attempts).toHaveLength(2);
    expect(committed[0]?.briefs).toEqual([
      { acceptanceChecks: [{ kind: "BODY_PRESENT" }], briefVersion: 2, instructions: "Complete this scoped deliverable.", workId: committed[0]?.items[0]?.workId },
      {
        acceptanceChecks: [{ expectedText: "hellow", kind: "FILE_CONTAINS_EXACT", relativePath: "hello.txt" }],
        briefVersion: 2,
        instructions: "保留原始拼写",
        workId: committed[0]?.items[1]?.workId,
      },
    ]);
    expect(committed[0]?.attempts[0]).toMatchObject({ partnerRevisionId: "partner-a-revision", registryRevision: 7 });
    expect(committed[0]?.attempts.map((attempt) => attempt.actionId)).toEqual(committed[0]?.attempts.map((attempt) => attempt.outbox.payload.actionId));
    expect(new Set(committed[0]?.attempts.map((attempt) => attempt.actionId)).size).toBe(2);
    expect(diagnostics.find((entry) => entry.event === "joi.work.plan.committed")?.fields).toMatchObject({
      attemptCount: 2,
      workbenchId: "workbench-1",
      dependencyCount: 1,
      dispatchPlanId: committed[0]?.dispatchPlanId,
      inputId: "input-1",
      turnId: "turn-1",
      workCount: 2,
    });
    expect(diagnostics.filter((entry) => entry.event === "joi.work.dispatch_planned")).toHaveLength(2);
    expect(JSON.stringify(diagnostics)).not.toContain("研究");
    expect(JSON.stringify(diagnostics)).not.toContain("写入");
  });

  it("still commits an attempt for a queued candidate so delivery can recheck it, and reports resource waiting", async () => {
    const committed: CommittedWorkPlan[] = [];
    const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: false, reason: "workspace_lease_conflict" }) },
      repository: { commit: async (plan) => { committed.push(plan); } },
    });
    const result = await service.plan({ workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn-1", work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "WRITE", instructions: "Complete this scoped deliverable.", key: "write", partnerId: "partner-a", title: "写入" }] });
    // The queued Work still gets a claimable attempt so the delivery-side recheck decides
    // its fate (retry a transient lease conflict, land a terminal FAILED otherwise) instead
    // of silently jamming the goal. The denial is surfaced to the caller and diagnostics.
    expect(result.denied).toEqual([]);
    expect(result.queued).toEqual([{
      reasonCode: "workspace_lease_conflict",
      workId: committed[0]?.items[0]?.workId,
      workKey: "write",
    }]);
    expect(committed[0]?.items).toHaveLength(1);
    expect(committed[0]?.attempts).toHaveLength(1);
    expect(committed[0]?.policyResults).toEqual([expect.objectContaining({ allowed: false, reason: "workspace_lease_conflict" })]);
    expect(diagnostics.find((entry) => entry.event === "joi.work.plan_policy_denied")).toBeUndefined();
    expect(diagnostics.find((entry) => entry.event === "joi.work.plan.committed")?.fields).toMatchObject({ deniedCount: 0 });
  });

  it("keeps permanent policy refusal separate from resource queueing", async () => {
    const committed: CommittedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: false }) },
      repository: { commit: async (plan) => { committed.push(plan); } },
    });
    const result = await service.plan({
      dependencies: [], inputId: "input-1", turnId: "turn-1", workbenchId: "workbench-1",
      work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instructions: "Complete this scoped deliverable.", key: "denied", partnerId: "partner-a", title: "拒绝" }],
    });
    expect(result.queued).toEqual([]);
    expect(result.denied).toEqual([{ reasonCode: "dispatch_policy_denied", workKey: "denied" }]);
    expect(committed[0]?.attempts).toHaveLength(1);
  });

  it("does not commit a partial plan when the Workbench workspace must be selected first", async () => {
    const committed: CommittedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: false, reason: "workbench_workspace_not_ready" }) },
      repository: { commit: async (plan) => { committed.push(plan); } },
    });

    await expect(service.plan({
      workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn-1",
      work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "WRITE", instructions: "Complete this scoped deliverable.", key: "write", partnerId: "partner-a", title: "写入" }],
    })).rejects.toMatchObject({ code: "workbench_workspace_not_ready" });
    expect(committed).toEqual([]);
  });

  it("rejects duplicate keys and unknown dependency keys before persistence", async () => {
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit: async () => undefined },
    });
    await expect(service.plan({ workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn", work: [
      { acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instructions: "Complete this scoped deliverable.", key: "same", partnerId: "partner", title: "A" },
      { acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instructions: "Complete this scoped deliverable.", key: "same", partnerId: "partner", title: "B" },
    ] })).rejects.toMatchObject({ code: "work_key_duplicate" });
    await expect(service.plan({ workbenchId: "workbench-1", dependencies: [{ dependsOnKey: "missing", workKey: "a" }], inputId: "input-1", turnId: "turn", work: [
      { acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instructions: "Complete this scoped deliverable.", key: "a", partnerId: "partner", title: "A" },
    ] })).rejects.toMatchObject({ code: "work_dependency_unknown" });
  });

  it("commits a supplemental Work with evidence and a durable two-round recovery identity", async () => {
    const committed: CommittedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) },
      recovery: { countRecoveryAttempts: async () => 1, loadForSupplement: async () => ({
        attemptCount: 1, evidenceResultIds: ["result-good"], inputId: "goal-1",
        sourceAcceptanceChecks: [
          { kind: "ARTIFACT_PRESENT" as const, name: "report.html" },
          { kind: "FILE_EXISTS" as const, relativePath: "report.html" },
        ],
        item: { accessMode: "WRITE", workbenchId: "workbench-1", createdAt: "2026-07-16T00:00:00.000Z", status: "FAILED", title: "failed", updatedAt: "2026-07-16T00:00:00.000Z", workId: "work-failed" },
      }) },
      repository: { commit: async (plan) => { committed.push(plan); } },
    });

    await expect(service.supplement({
      acceptanceChecks: [{ kind: "FILE_EXISTS", relativePath: "report.html" }, { kind: "BODY_PRESENT" }], accessMode: "NONE", partnerId: "partner-a",
      instructions: "Only fill the missing section.", sourceWorkId: "work-failed", title: "补齐报告",
      turnId: "turn-2", workbenchId: "workbench-1",
    })).resolves.toMatchObject({ attemptNo: 2, evidenceResultIds: ["result-good"] });
    expect(committed[0]).toMatchObject({
      dependencies: [], inputId: "goal-1",
      recovery: { attemptNo: 2, sourceWorkId: "work-failed", strategy: "SUPPLEMENT" },
    });
    expect(committed[0]?.briefs[0]).toMatchObject({ evidenceResultIds: ["result-good"] });
    expect(committed[0]?.briefs[0]).toMatchObject({ instructions: "Only fill the missing section." });
    expect(committed[0]?.briefs[0]?.acceptanceChecks).toEqual([
      { kind: "ARTIFACT_PRESENT", name: "report.html" },
      { kind: "FILE_EXISTS", relativePath: "report.html" },
      { kind: "BODY_PRESENT" },
    ]);
    expect(committed[0]?.items[0]?.accessMode).toBe("WRITE");
  });

  it("stops supplemental recovery after two rounds", async () => {
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) },
      recovery: { countRecoveryAttempts: async () => 2, loadForSupplement: async () => ({
        attemptCount: 2, evidenceResultIds: [], inputId: "goal-1",
        sourceAcceptanceChecks: [],
        item: { accessMode: "READ", workbenchId: "workbench-1", createdAt: "2026-07-16T00:00:00.000Z", status: "FAILED", title: "failed", updatedAt: "2026-07-16T00:00:00.000Z", workId: "work-failed" },
      }) },
      repository: { commit: async () => undefined },
    });
    await expect(service.supplement({ accessMode: "READ", partnerId: "partner-a", sourceWorkId: "work-failed", title: "补齐报告", turnId: "turn-3", workbenchId: "workbench-1" }))
      .rejects.toMatchObject({ code: "work_recovery_exhausted" });
  });

  it("reassigns failed work through a new pinned revision and outbox action", async () => {
    const reassigned: ReassignedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async () => ({ partnerId: "partner-b", partnerRevisionId: "revision-b", registryRevision: 8, minimumAccessMode: "WRITE" }) },
      policy: { evaluate: async () => ({ allowed: true }) },
      reassignment: {
        cancel: async () => ({ canceled: true, cascadedWorkIds: [] }),
        loadForReassignment: async () => ({
          item: { accessMode: "NONE", workbenchId: "workbench-1", createdAt: "2026-07-16T00:00:00.000Z", status: "FAILED", title: "修复", updatedAt: "2026-07-16T00:00:00.000Z", workId: "work-1" },
          lastPartnerId: "partner-a",
          lastPartnerRevisionId: "revision-a",
        }),
        reassign: async (plan) => { reassigned.push(plan); },
      },
      recovery: {
        countRecoveryAttempts: async () => 1,
        loadForSupplement: async () => { throw new Error("not used"); },
      },
      repository: { commit: async () => undefined },
    });

    await expect(service.reassign({ workbenchId: "workbench-1", partnerId: "partner-b", turnId: "turn-2", workId: "work-1" }))
      .resolves.toMatchObject({ partnerRevisionId: "revision-b", registryRevision: 8, workId: "work-1" });
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]?.attempt.actionId).toMatch(/^action_/u);
    expect(reassigned[0]).toMatchObject({
      accessMode: "WRITE",
      attempt: { partnerRevisionId: "revision-b", outbox: { kind: "partner.dispatch", payload: { workId: "work-1" } } },
      recovery: { attemptNo: 2 },
      turnId: "turn-2",
    });
  });

  it("rejects unsafe reassignment states before creating a second side effect", async () => {
    const baseItem: WorkItem = { accessMode: "WRITE", workbenchId: "workbench-1", createdAt: "2026-07-16T00:00:00.000Z", status: "FAILED", title: "修复", updatedAt: "2026-07-16T00:00:00.000Z", workId: "work-1" };
    const create = (options: {
      context?: WorkReassignmentContext | null;
      policy?: { allowed: boolean; reason?: string };
      reassignment?: boolean;
      revision?: string;
    }) => new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async () => ({ partnerId: "partner", partnerRevisionId: options.revision ?? "revision-new", registryRevision: 2 }) },
      policy: { evaluate: async () => options.policy ?? { allowed: true } },
      ...(options.reassignment === false ? {} : { reassignment: {
        cancel: async () => ({ canceled: true, cascadedWorkIds: [] }),
        loadForReassignment: async () => options.context === undefined ? { item: baseItem, lastPartnerId: "partner-old", lastPartnerRevisionId: "revision-old" } : options.context,
        reassign: async () => undefined,
      } }),
      repository: { commit: async () => undefined },
    });

    await expect(create({ reassignment: false }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassignment_unavailable" });
    await expect(create({ context: null }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_not_found" });
    await expect(create({ context: { item: { ...baseItem, workbenchId: "workbench-2" }, lastPartnerId: "partner-old", lastPartnerRevisionId: "revision-old" } }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_workbench_mismatch" });
    await expect(create({ context: { item: { ...baseItem, status: "COMPLETED" }, lastPartnerId: "partner-old", lastPartnerRevisionId: "revision-old" } }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassign_status_invalid" });
    await expect(create({ revision: "revision-old" }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassign_same_revision" });
    await expect(create({ policy: { allowed: false, reason: "capacity" } }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassign_policy_denied", message: "capacity" });
    await expect(create({ policy: { allowed: false } }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassign_policy_denied" });
  });

  it("resumes waiting work on the same revision and only reuses a live instance", async () => {
    const waitingItem: WorkItem = { accessMode: "NONE", workbenchId: "workbench-1", createdAt: "2026-07-16T00:00:00.000Z", status: "WAITING", title: "待答", updatedAt: "2026-07-16T00:00:00.000Z", workId: "work-1" };
    const reassigned: ReassignedWorkPlan[] = [];
    const create = (options: { instance?: { instanceId: string; status: string } | null; item?: WorkItem }) => new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      instances: { get: async () => options.instance === undefined ? null : options.instance as never },
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision-same", registryRevision: 3, minimumAccessMode: "WRITE" }) },
      policy: { evaluate: async () => ({ allowed: true }) },
      reassignment: {
        cancel: async () => ({ canceled: true, cascadedWorkIds: [] }),
        loadForReassignment: async (): Promise<WorkReassignmentContext> => ({
          item: options.item ?? waitingItem,
          lastInstanceId: "instance-1",
          lastPartnerId: "partner-a",
          lastPartnerRevisionId: "revision-same",
        }),
        reassign: async (plan) => { reassigned.push(plan); },
      },
      repository: { commit: async () => undefined },
    });

    // A live IDLE instance is referenced directly so the resident conversation continues.
    await expect(create({ instance: { instanceId: "instance-1", status: "IDLE" } }).resume({ instructions: "Continue the read-only task using the confirmed user answer.", workbenchId: "workbench-1", turnId: "turn", workId: "work-1" }))
      .resolves.toMatchObject({ outbox: { payload: { instanceId: "instance-1", workId: "work-1" } }, partnerRevisionId: "revision-same" });
    // A disposed instance must never be referenced; the attempt falls back to a resident continuation.
    await expect(create({ instance: { instanceId: "instance-1", status: "DISPOSED" } }).resume({ instructions: "Continue the read-only task using the confirmed user answer.", workbenchId: "workbench-1", turnId: "turn", workId: "work-1" }))
      .resolves.toMatchObject({ outbox: { payload: { sessionPolicy: "RESIDENT", workId: "work-1" } } });
    expect(reassigned).toHaveLength(2);
    expect(reassigned.map((plan) => plan.accessMode)).toEqual(["WRITE", "WRITE"]);
    expect(reassigned.map((plan) => plan.instructions)).toEqual(Array(2).fill("Continue the read-only task using the confirmed user answer."));
    await expect(create({}).resume({ workbenchId: "workbench-1", turnId: "turn-missing", workId: "work-1" })).rejects.toMatchObject({ code: "work_instructions_invalid" });
    expect(reassigned).toHaveLength(2);

    await expect(create({ item: { ...waitingItem, status: "COMPLETED" } }).resume({ instructions: "Continue the read-only task using the confirmed user answer.", workbenchId: "workbench-1", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_resume_status_invalid" });
    await expect(create({ item: { ...waitingItem, workbenchId: "workbench-2" } }).resume({ instructions: "Continue the read-only task using the confirmed user answer.", workbenchId: "workbench-1", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_workbench_mismatch" });
  });

  it("reuses the dispatch committed for the same persisted user action after a crash", async () => {
    const existing = {
      actionId: "attention-1",
      dispatchAttemptId: "attempt-existing",
      outbox: {
        availableAt: "2026-07-16T00:00:00.000Z",
        kind: "partner.dispatch" as const,
        outboxId: "outbox-existing",
        payload: { actionId: "attention-1", dispatchAttemptId: "attempt-existing", workId: "work-1" },
      },
      partnerId: "partner-a",
      partnerRevisionId: "revision-same",
      registryRevision: 3,
      workId: "work-1",
    };
    const loadForReassignment = vi.fn(async () => { throw new Error("must not rebuild an applied resume"); });
    const reassign = vi.fn(async () => undefined);
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async () => { throw new Error("must not repin"); } },
      policy: { evaluate: async () => ({ allowed: true }) },
      reassignment: {
        cancel: async () => ({ canceled: true, cascadedWorkIds: [] }),
        loadAttemptForAction: async (workId, actionId) => workId === "work-1" && actionId === "attention-1" ? existing : null,
        loadForReassignment,
        reassign,
      },
      repository: { commit: async () => undefined },
    });

    await expect(service.resume({ actionId: "attention-1", workbenchId: "workbench-1", turnId: "turn-retry", workId: "work-1" }))
      .resolves.toEqual(existing);
    expect(loadForReassignment).not.toHaveBeenCalled();
    expect(reassign).not.toHaveBeenCalled();
  });

  it("cancels work only through the repository guard", async () => {
    const canceled: string[] = [];
    const waitingItem: WorkItem = { accessMode: "WRITE", workbenchId: "workbench-1", createdAt: "2026-07-16T00:00:00.000Z", status: "WAITING", title: "待答", updatedAt: "2026-07-16T00:00:00.000Z", workId: "work-1" };
    const create = (cancelResult: boolean) => new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) },
      reassignment: {
        cancel: async (workId) => { canceled.push(workId); return { canceled: cancelResult, cascadedWorkIds: [] }; },
        loadForReassignment: async (): Promise<WorkReassignmentContext> => ({ item: waitingItem, lastPartnerId: "partner-a", lastPartnerRevisionId: "revision" }),
        reassign: async () => undefined,
      },
      repository: { commit: async () => undefined },
    });

    await expect(create(true).cancel({ workbenchId: "workbench-1", workId: "work-1" })).resolves.toMatchObject({ workId: "work-1" });
    expect(canceled).toEqual(["work-1"]);
    await expect(create(false).cancel({ workbenchId: "workbench-1", workId: "work-1" })).rejects.toMatchObject({ code: "work_cancel_status_invalid" });
  });
});
