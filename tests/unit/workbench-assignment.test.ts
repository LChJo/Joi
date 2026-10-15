/* Router doubles resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";
import { resolveWorkbenchAssignment } from "../../src/main/application/joi/workbench-assignment";
import type { WorkbenchSummary } from "../../src/main/application/ports/workbench-context";

const NEWS: WorkbenchSummary = { updatedAt: "2026-10-01T00:00:00.000Z", workbenchId: "news", name: "中文AI技术资讯与开源生态调研环境", scopeSummary: "中文AI资讯网站、GitHub及技术站点的趋势调研与来源交叉验证。" };
const CODE: WorkbenchSummary = { ...NEWS, workbenchId: "code", name: "joi 工程维护工坊", scopeSummary: "joi 工程源码、README 和构建维护。" };
const REQUEST = "阅读 joi 工程源码，参考 GitHub 开源项目，完善 README";
const DRAFT = { action: "create", name: "工程维护工坊", personaSummary: "围绕证据推进。", projectLabel: "工程维护", scopeSummary: "代码阅读、工程文档与构建验证。" };
const WAIT = { action: "clarify", reasonCode: "workbench_selection_invalid" };

function returning(...values: unknown[]) {
  const calls: { mode?: string; repair: boolean }[] = [];
  let index = 0;
  return { calls, router: { decide: async (input: { mode?: "route" | "abstract"; repair: boolean }) => {
    calls.push(input);
    return values[Math.min(index++, values.length - 1)];
  } } };
}

describe("workbench assignment requires a clear scope match", () => {
  it.each(["SAME_PROJECT", "SAME_SCOPE"])("accepts a unique %s decision", async (matchKind) => {
    const { router, calls } = returning({ action: "select", workbenchId: "code", matchKind });
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: REQUEST, router, workbenches: [NEWS, CODE] }))
      .resolves.toEqual({ action: "select", resolution: "selected", workbenchId: "code" });
    expect(calls).toHaveLength(1);
  });

  it.each([undefined, "TOPIC_ONLY", "UNCERTAIN"])("does not accept a valid ID with match kind %s", async (matchKind) => {
    const { router } = returning({ action: "select", workbenchId: "news", matchKind });
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: REQUEST, router, workbenches: [NEWS] })).resolves.toMatchObject(WAIT);
  });

  it("does not fall back to keywords even when the local match would be strong", async () => {
    const { router } = returning(null);
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: CODE.scopeSummary, router, workbenches: [CODE] })).resolves.toEqual(WAIT);
  });

  it("keeps only a public editable proposal instead of creating a workbench", async () => {
    const { router } = returning(DRAFT);
    const assignment = await resolveWorkbenchAssignment({ canCreate: true, requestText: REQUEST, router, workbenches: [] });
    expect(assignment).toEqual({ ...WAIT, proposal: { name: DRAFT.name, projectLabel: DRAFT.projectLabel, scopeSummary: DRAFT.scopeSummary } });
    expect(JSON.stringify(assignment)).not.toContain(DRAFT.personaSummary);
  });

  it("can request selection without an invalid-output repair", async () => {
    const { router, calls } = returning({ action: "clarify" }, DRAFT);
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: REQUEST, router, workbenches: [NEWS] })).resolves.toMatchObject({ ...WAIT, proposal: { name: DRAFT.name } });
    expect(calls.map((call) => call.mode)).toEqual(["route", "abstract"]);
  });

  it("repairs a rejected generated name once and keeps a useful project name", async () => {
    const echoed = { ...DRAFT, name: "这是需要维护的工程请完整分析并交付所有代码修改以及构建验证结果的工作台名称", scopeSummary: REQUEST };
    const { router, calls } = returning(null, null, echoed, { ...DRAFT, name: "digital-life 源码维护工坊", projectLabel: "digital-life" });
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: "digital-life 的代码需要维护", router, workbenches: [] }))
      .resolves.toMatchObject({ ...WAIT, proposal: { projectLabel: "digital-life" } });
    expect(calls.filter((call) => call.mode === "abstract")).toHaveLength(2);
  });

  it.each([null, "text", 42, [], { action: "create" }, { action: "select", workbenchId: "ghost", matchKind: "SAME_SCOPE" }])("waits without bootstrap creation for unusable output %#", async (value) => {
    const { router } = returning(value);
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: REQUEST, router, workbenches: [] })).resolves.toEqual(WAIT);
  });

  it("does not auto-select an existing generic bucket", async () => {
    const { router } = returning(null);
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: REQUEST, router, workbenches: [{ ...NEWS, name: "joi 工作台" }] })).resolves.toEqual(WAIT);
  });

  it("does not name a proposal when creation is unavailable", async () => {
    const { router, calls } = returning(null);
    await expect(resolveWorkbenchAssignment({ canCreate: false, requestText: REQUEST, router, workbenches: [] })).resolves.toEqual(WAIT);
    expect(calls).toHaveLength(2);
  });
});
