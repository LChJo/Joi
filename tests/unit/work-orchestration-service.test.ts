/* In-memory orchestration ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import type { CommittedWorkPlan, WorkPlanRepository } from "../../src/main/application/ports/work-orchestration.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("work orchestration outbox", () => {
  it("persists the DAG, immutable partner pins and dispatch outbox records as one plan", async () => {
    const committed: CommittedWorkPlan[] = [];
    const repository: WorkPlanRepository = { commit: async (plan) => { committed.push(structuredClone(plan)); } };
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: `${partnerId}-revision`, registryRevision: 7 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository,
    });
    const result = await service.plan({
      avatarId: "avatar-1",
      dependencies: [{ dependsOnKey: "research", workKey: "write" }],
      turnId: "turn-1",
      work: [
        { accessMode: "READ", key: "research", partnerId: "partner-a", title: "研究", workspaceRef: "workspace-1" },
        { accessMode: "WRITE", key: "write", partnerId: "partner-b", title: "写入", workspaceRef: "workspace-1" },
      ],
    });
    expect(result.waves).toHaveLength(2);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.attempts).toHaveLength(2);
    expect(committed[0]?.attempts[0]).toMatchObject({ partnerRevisionId: "partner-a-revision", registryRevision: 7 });
    expect(committed[0]?.attempts.map((attempt) => attempt.actionId)).toEqual(committed[0]?.attempts.map((attempt) => attempt.outbox.payload.actionId));
    expect(new Set(committed[0]?.attempts.map((attempt) => attempt.actionId)).size).toBe(2);
  });

  it("keeps denied candidates persisted without creating a side effect", async () => {
    const committed: CommittedWorkPlan[] = [];
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: false, reason: "workspace_untrusted" }) },
      repository: { commit: async (plan) => { committed.push(plan); } },
    });
    await service.plan({ avatarId: "avatar-1", dependencies: [], turnId: "turn-1", work: [{ accessMode: "WRITE", key: "write", partnerId: "partner-a", title: "写入" }] });
    expect(committed[0]?.items).toHaveLength(1);
    expect(committed[0]?.attempts).toEqual([]);
    expect(committed[0]?.policyResults).toEqual([expect.objectContaining({ allowed: false, reason: "workspace_untrusted" })]);
  });

  it("rejects duplicate keys and unknown dependency keys before persistence", async () => {
    const service = new WorkOrchestrationService({
      clock: new TestClock(), ids: new TestIds(),
      partners: { pinForDispatch: async (partnerId) => ({ partnerId, partnerRevisionId: "revision", registryRevision: 1 }) },
      policy: { evaluate: async () => ({ allowed: true }) }, repository: { commit: async () => undefined },
    });
    await expect(service.plan({ avatarId: "avatar-1", dependencies: [], turnId: "turn", work: [
      { accessMode: "READ", key: "same", partnerId: "partner", title: "A" },
      { accessMode: "READ", key: "same", partnerId: "partner", title: "B" },
    ] })).rejects.toMatchObject({ code: "work_key_duplicate" });
    await expect(service.plan({ avatarId: "avatar-1", dependencies: [{ dependsOnKey: "missing", workKey: "a" }], turnId: "turn", work: [
      { accessMode: "READ", key: "a", partnerId: "partner", title: "A" },
    ] })).rejects.toMatchObject({ code: "work_dependency_unknown" });
  });
});
