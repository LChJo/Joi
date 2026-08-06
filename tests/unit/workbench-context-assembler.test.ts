/* In-memory async ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { WorkbenchContextAssembler } from "../../src/main/application/joi/workbench-context-assembler.js";
import type { WorkbenchContextSnapshot } from "../../src/main/application/ports/workbench-context.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const workbench = createWorkbench({
  workbenchId: "workbench-a",
  createdAt: "2026-08-02T00:00:00.000Z",
  memoryNamespaceId: "memory-private-a",
  name: "文档 Workbench",
  personaRevisionId: "persona-a-2",
  personaSummary: "绝不能进入快照的人格正文 SECRET_PERSONA",
  project: { label: "工程 C:\\Users\\owner\\private" },
  scopeSummary: "维护 /home/owner/private 下的文档",
  taskContext: { activeWorkIds: [], summary: "" },
});

describe("WorkbenchContextAssembler", () => {
  it("persists a bounded, path-clean snapshot without persona or memory bodies", async () => {
    const saved: WorkbenchContextSnapshot[] = [];
    const assembler = new WorkbenchContextAssembler({
      workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
      clock: new TestClock("2026-08-02T00:00:00.000Z"),
      ids: new TestIds(),
      projections: { loadSnapshotFacts: async () => ({
        activeWork: [{ status: "RUNNING", title: "读取 C:\\Users\\owner\\private\\a.md", workId: "work-old" }],
        memorySummaryRefs: ["memory-summary:approved"],
        recentResults: [{ resultId: "result-old", status: "COMPLETED", summary: "完成 /tmp/private/out", workId: "work-old" }],
        work: { accessMode: "READ", title: "更新 C:\\Users\\owner\\private\\b.md", workId: "work-a" },
        workspace: { displayName: "文档", kind: "BOUND", status: "READY", workspaceRef: "workbench_workspace:workbench-a" },
      }) },
      snapshots: { load: async () => null, save: async (snapshot) => { saved.push(structuredClone(snapshot)); } },
    });

    const snapshot = await assembler.assemble({ workbenchId: "workbench-a", workId: "work-a" });
    expect(saved).toEqual([snapshot]);
    expect(snapshot).toMatchObject({
      workbenchId: "workbench-a",
      memorySummaryRefs: ["workbench_memory:memory-private-a", "memory-summary:approved"],
      personaRevisionId: "persona-a-2",
      workspaceRef: "workbench_workspace:workbench-a",
    });
    const serialized = JSON.stringify(snapshot.safeContext);
    expect(serialized).not.toContain("SECRET_PERSONA");
    expect(serialized).not.toMatch(/(?:C:\\Users|\/home|\/tmp)/u);
    expect(serialized).toContain("[redacted-path]");
  });

  it("does not bind a workspace for NONE work and blocks file work until READY", async () => {
    let mode: "NONE" | "WRITE" = "NONE";
    const assembler = new WorkbenchContextAssembler({
      workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      projections: { loadSnapshotFacts: async () => ({
        activeWork: [], memorySummaryRefs: [], recentResults: [],
        work: { accessMode: mode, title: "task", workId: "work-a" },
        workspace: { displayName: "文档", kind: "MANAGED", status: "PROVISIONING", workspaceRef: "workbench_workspace:workbench-a" },
      }) },
      snapshots: { load: async () => null, save: async () => undefined },
    });
    await expect(assembler.assemble({ workbenchId: "workbench-a", workId: "work-a" })).resolves.not.toHaveProperty("workspaceRef");
    mode = "WRITE";
    await expect(assembler.assemble({ workbenchId: "workbench-a", workId: "work-a" }))
      .rejects.toMatchObject({ code: "workbench_workspace_not_ready" });
  });

  it("rejects missing Workbench or work projection facts", async () => {
    const createAssembler = (workbenchValue: typeof workbench | null, factsValue: null) => new WorkbenchContextAssembler({
      workbenches: { getWorkbench: async () => workbenchValue, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      projections: { loadSnapshotFacts: async () => factsValue },
      snapshots: { load: async () => null, save: async () => undefined },
    });
    await expect(createAssembler(null, null).assemble({ workbenchId: "missing", workId: "work" }))
      .rejects.toMatchObject({ code: "workbench_context_not_found" });
    await expect(createAssembler(workbench, null).assemble({ workbenchId: "workbench-a", workId: "missing" }))
      .rejects.toMatchObject({ code: "workbench_context_not_found" });
  });
});
