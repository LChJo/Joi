/* In-memory orchestration ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import type { CommittedWorkPlan, ReassignedWorkPlan, WorkPlanRepository } from "../../src/main/application/ports/work-orchestration.js";
import type { WorkItem } from "../../src/main/domain/work/work.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("work orchestration outbox", () => {
  it("rejects caller-supplied workspace refs because Workbench owns cwd", async () => {
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit: async () => undefined },
    });
    await expect(service.plan({
      workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn", work: [
        { accessMode: "WRITE", key: "write", partnerId: "partner", title: "写入", workspaceRef: "caller-path" },
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
        { acceptanceChecks: [{ kind: "FILE_EXISTS", relativePath: "C:\\Users\\owner\\report.md" }], accessMode: "READ", key: "read", partnerId: "partner", title: "读取" },
      ],
    })).rejects.toMatchObject({ code: "work_acceptance_path_invalid" });
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
        { accessMode: "READ", key: "research", partnerId: "partner-a", title: "研究" },
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
      { acceptanceChecks: [], workId: committed[0]?.items[0]?.workId },
      {
        acceptanceChecks: [{ expectedText: "hellow", kind: "FILE_CONTAINS_EXACT", relativePath: "hello.txt" }],
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

  it("keeps denied candidates persisted without creating a side effect", async () => {
    const committed: CommittedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: false, reason: "workspace_untrusted" }) },
      repository: { commit: async (plan) => { committed.push(plan); } },
    });
    await service.plan({ workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn-1", work: [{ accessMode: "WRITE", key: "write", partnerId: "partner-a", title: "写入" }] });
    expect(committed[0]?.items).toHaveLength(1);
    expect(committed[0]?.attempts).toEqual([]);
    expect(committed[0]?.policyResults).toEqual([expect.objectContaining({ allowed: false, reason: "workspace_untrusted" })]);
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
      work: [{ accessMode: "WRITE", key: "write", partnerId: "partner-a", title: "写入" }],
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
      { accessMode: "READ", key: "same", partnerId: "partner", title: "A" },
      { accessMode: "READ", key: "same", partnerId: "partner", title: "B" },
    ] })).rejects.toMatchObject({ code: "work_key_duplicate" });
    await expect(service.plan({ workbenchId: "workbench-1", dependencies: [{ dependsOnKey: "missing", workKey: "a" }], inputId: "input-1", turnId: "turn", work: [
      { accessMode: "READ", key: "a", partnerId: "partner", title: "A" },
    ] })).rejects.toMatchObject({ code: "work_dependency_unknown" });
  });

  it("reassigns failed work through a new pinned revision and outbox action", async () => {
    const reassigned: ReassignedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async () => ({ partnerId: "partner-b", partnerRevisionId: "revision-b", registryRevision: 8 }) },
      policy: { evaluate: async () => ({ allowed: true }) },
      reassignment: {
        loadForReassignment: async () => ({
          item: { accessMode: "WRITE", workbenchId: "workbench-1", createdAt: "2026-07-16T00:00:00.000Z", status: "FAILED", title: "修复", updatedAt: "2026-07-16T00:00:00.000Z", workId: "work-1" },
          lastPartnerRevisionId: "revision-a",
        }),
        reassign: async (plan) => { reassigned.push(plan); },
      },
      repository: { commit: async () => undefined },
    });

    await expect(service.reassign({ workbenchId: "workbench-1", partnerId: "partner-b", turnId: "turn-2", workId: "work-1" }))
      .resolves.toMatchObject({ partnerRevisionId: "revision-b", registryRevision: 8, workId: "work-1" });
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]?.attempt.actionId).toMatch(/^action_/u);
    expect(reassigned[0]).toMatchObject({
      attempt: { partnerRevisionId: "revision-b", outbox: { kind: "partner.dispatch", payload: { workId: "work-1" } } },
      turnId: "turn-2",
    });
  });

  it("rejects unsafe reassignment states before creating a second side effect", async () => {
    const baseItem: WorkItem = { accessMode: "WRITE", workbenchId: "workbench-1", createdAt: "2026-07-16T00:00:00.000Z", status: "FAILED", title: "修复", updatedAt: "2026-07-16T00:00:00.000Z", workId: "work-1" };
    const create = (options: {
      context?: { item: WorkItem; lastPartnerRevisionId: string } | null;
      policy?: { allowed: boolean; reason?: string };
      reassignment?: boolean;
      revision?: string;
    }) => new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async () => ({ partnerId: "partner", partnerRevisionId: options.revision ?? "revision-new", registryRevision: 2 }) },
      policy: { evaluate: async () => options.policy ?? { allowed: true } },
      ...(options.reassignment === false ? {} : { reassignment: {
        loadForReassignment: async () => options.context === undefined ? { item: baseItem, lastPartnerRevisionId: "revision-old" } : options.context,
        reassign: async () => undefined,
      } }),
      repository: { commit: async () => undefined },
    });

    await expect(create({ reassignment: false }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassignment_unavailable" });
    await expect(create({ context: null }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_not_found" });
    await expect(create({ context: { item: { ...baseItem, workbenchId: "workbench-2" }, lastPartnerRevisionId: "revision-old" } }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_workbench_mismatch" });
    await expect(create({ context: { item: { ...baseItem, status: "COMPLETED" }, lastPartnerRevisionId: "revision-old" } }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassign_status_invalid" });
    await expect(create({ revision: "revision-old" }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassign_same_revision" });
    await expect(create({ policy: { allowed: false, reason: "capacity" } }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassign_policy_denied", message: "capacity" });
    await expect(create({ policy: { allowed: false } }).reassign({ workbenchId: "workbench-1", partnerId: "partner", turnId: "turn", workId: "work-1" })).rejects.toMatchObject({ code: "work_reassign_policy_denied" });
  });
});
