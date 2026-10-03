/* Router doubles resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";

import { BOOTSTRAP_WORKBENCH, resolveWorkbenchAssignment } from "../../src/main/application/joi/workbench-assignment";
import type { WorkbenchSummary } from "../../src/main/application/ports/workbench-context";

const STOCK: WorkbenchSummary = { updatedAt: "2026-10-01T00:00:00.000Z", workbenchId: "w-stock", name: "A股技术面与走势分析环境", scopeSummary: "基于可验证的历史行情与当前市场指标，分析A股沪指的技术走势、周期信号和风险情景。" };
const NEWS: WorkbenchSummary = { updatedAt: "2026-10-01T00:00:00.000Z", workbenchId: "w-news", name: "中文AI技术资讯与开源生态调研环境", scopeSummary: "负责中文AI资讯网站、GitHub及相关技术站点的趋势调研、来源交叉验证与技术价值分析。" };

const STOCK_REQUEST = "根据近期A股市场数据，分析整体趋势和重要板块的趋势，给出明确的投资建议";

/** The name the phone actually minted for this request, kept verbatim as the case to refuse. */
const ECHOED = { action: "create", name: "民宿周边有皖南川藏线，落羽红杉林，青… 工作台", personaSummary: "由 joi 维护长期上下文。", projectLabel: "民宿周边有皖南川藏线，落羽红杉林，青…", scopeSummary: "围绕“民宿周边有皖南川藏线，落羽红杉林，青…”的目标、资料与执行过程。" };
const TRAVEL_REQUEST = "民宿周边有皖南川藏线，落羽红杉林，青龙湾度假区，山门洞，储家滩，西津野渡，双河漂流，分析哪些是最值得去的景点，备注是否需要购票";

function routerReturning(...values: unknown[]) {
  const calls: { input: string; mode: string | undefined; repair: boolean }[] = [];
  let index = 0;
  return {
    calls,
    router: {
      decide: async (input: { input: string; mode?: "abstract" | "route"; repair: boolean }) => {
        calls.push({ input: input.input, mode: input.mode, repair: input.repair });
        const value = values[Math.min(index, values.length - 1)];
        index += 1;
        return value;
      },
    },
  };
}

describe("resolveWorkbenchAssignment", () => {
  it("takes the workbench the router placed the input in", async () => {
    const { router, calls } = routerReturning({ action: "select", workbenchId: "w-stock" });
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: STOCK_REQUEST, router, workbenches: [STOCK, NEWS] }))
      .resolves.toEqual({ action: "select", resolution: "selected", workbenchId: "w-stock" });
    expect(calls).toEqual([{ input: STOCK_REQUEST, mode: "route", repair: false }]);
  });

  it("creates the cluster the router named when it is a cluster", async () => {
    const draft = { action: "create", name: "行程规划工坊", personaSummary: "先确认约束再比较方案。", projectLabel: "行程规划", scopeSummary: "目的地资料整理、路线与时间安排。" };
    const { router } = routerReturning(draft);
    const assignment = await resolveWorkbenchAssignment({ canCreate: true, requestText: TRAVEL_REQUEST, router, workbenches: [] });
    expect(assignment).toMatchObject({ action: "create", resolution: "created" });
    expect(assignment.action === "create" ? assignment.draft : null).toMatchObject({ name: "行程规划工坊" });
  });

  it("refuses a name that restates the request and never creates it", async () => {
    const { router } = routerReturning(ECHOED, ECHOED, ECHOED, ECHOED);
    const assignment = await resolveWorkbenchAssignment({ canCreate: true, requestText: TRAVEL_REQUEST, router, workbenches: [] });
    expect(assignment).toMatchObject({ action: "create", resolution: "bootstrap" });
    expect(assignment.action === "create" ? assignment.draft.name : null).toBe(BOOTSTRAP_WORKBENCH.name);
  });

  it("retries the abstract pass once when the model restated the request", async () => {
    const { router, calls } = routerReturning(
      null, null,
      ECHOED,
      { action: "create", name: "皖南川藏线片区景点调研工坊", personaSummary: "先建立事实再比较。", projectLabel: "皖南川藏线片区景点调研", scopeSummary: "目的地资料整理与出行信息比较。" },
    );
    const assignment = await resolveWorkbenchAssignment({ canCreate: true, requestText: TRAVEL_REQUEST, router, workbenches: [] });
    expect(assignment).toMatchObject({ action: "create", resolution: "created" });
    expect(assignment.action === "create" ? assignment.draft.name : null).toBe("皖南川藏线片区景点调研工坊");
    expect(calls.filter((call) => call.mode === "abstract")).toEqual([
      { input: TRAVEL_REQUEST, mode: "abstract", repair: false },
      { input: TRAVEL_REQUEST, mode: "abstract", repair: true },
    ]);
  });

  it("matches locally instead of interrupting the user when the router cannot decide", async () => {
    const { router, calls } = routerReturning({ action: "select", workbenchId: "ghost" });
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: STOCK_REQUEST, router, workbenches: [STOCK, NEWS] }))
      .resolves.toEqual({ action: "select", resolution: "selected", workbenchId: "w-stock" });
    expect(calls.every((call) => call.mode === "route")).toBe(true);
  });

  it("asks only when two workbenches are equally plausible", async () => {
    const first: WorkbenchSummary = { updatedAt: "2026-10-01T00:00:00.000Z", workbenchId: "t1", name: "旅行行程规划环境", scopeSummary: "行程规划与出行安排。" };
    const second: WorkbenchSummary = { updatedAt: "2026-10-01T00:00:00.000Z", workbenchId: "t2", name: "旅行行程规划助手", scopeSummary: "行程规划与出行安排。" };
    const { router } = routerReturning(null);
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: "帮我做一份行程规划", router, workbenches: [first, second] }))
      .resolves.toEqual({ action: "clarify", reasonCode: "workbench_selection_invalid" });
  });

  it("names a cluster when nothing existing fits", async () => {
    const { router, calls } = routerReturning(null, null, { action: "create", name: "海外供应商调研工坊", personaSummary: "先核实来源。", projectLabel: "海外供应商调研", scopeSummary: "供应商资料的收集与交叉验证。" });
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: "帮我查一下几家海外供应商", router, workbenches: [STOCK, NEWS] }))
      .resolves.toMatchObject({ action: "create", resolution: "created" });
    expect(calls.map((call) => call.mode)).toEqual(["route", "route", "abstract"]);
  });

  it("ignores a select that comes back from the abstract pass", async () => {
    const { router } = routerReturning(null, null, { action: "select", workbenchId: "w-stock" });
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: "帮我查一下几家海外供应商", router, workbenches: [STOCK, NEWS] }))
      .resolves.toEqual({ action: "create", draft: BOOTSTRAP_WORKBENCH, resolution: "bootstrap" });
  });

  it("reuses the shared bucket instead of minting a second one", async () => {
    const existing: WorkbenchSummary = { updatedAt: "2026-10-01T00:00:00.000Z", workbenchId: "w-boot", name: BOOTSTRAP_WORKBENCH.name, scopeSummary: BOOTSTRAP_WORKBENCH.scopeSummary };
    const { router } = routerReturning(null);
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: "帮我查一下几家海外供应商", router, workbenches: [existing] }))
      .resolves.toEqual({ action: "select", resolution: "bootstrap", workbenchId: "w-boot" });
  });

  it("asks rather than inventing a workbench it cannot create", async () => {
    const { router, calls } = routerReturning(null);
    await expect(resolveWorkbenchAssignment({ canCreate: false, requestText: "帮我查一下几家海外供应商", router, workbenches: [STOCK, NEWS] }))
      .resolves.toEqual({ action: "clarify", reasonCode: "workbench_selection_invalid" });
    expect(calls).toHaveLength(2);
  });

  it("survives a router that returns nothing usable at all", async () => {
    for (const value of [null, "text", 42, [], { action: "create" }, { action: "create", name: 1 }]) {
      const { router } = routerReturning(value);
      await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: "帮我查一下几家海外供应商", router, workbenches: [] }))
        .resolves.toEqual({ action: "create", draft: BOOTSTRAP_WORKBENCH, resolution: "bootstrap" });
    }
  });

  it("refuses an empty or run-on name", async () => {
    for (const name of ["", "   ", "工坊", "这是一段被模型当成工作台名字倒出来的很长很长的句子，读起来完全不像一个工作簇"]) {
      const { router } = routerReturning({ action: "create", name, personaSummary: "p", projectLabel: "项目", scopeSummary: "范围" }, { action: "create", name, personaSummary: "p", projectLabel: "项目", scopeSummary: "范围" });
      await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: "帮我查一下几家海外供应商", router, workbenches: [] }))
        .resolves.toEqual({ action: "create", draft: BOOTSTRAP_WORKBENCH, resolution: "bootstrap" });
    }
  });

  it("refuses a draft whose scope summary quotes the request", async () => {
    const { router } = routerReturning({ action: "create", name: "调研工坊", personaSummary: "p", projectLabel: "调研", scopeSummary: `围绕“${TRAVEL_REQUEST.slice(0, 40)}”展开。` });
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: TRAVEL_REQUEST, router, workbenches: [] }))
      .resolves.toEqual({ action: "create", draft: BOOTSTRAP_WORKBENCH, resolution: "bootstrap" });
  });

  it("passes the repair flag on the second routing attempt", async () => {
    const { router, calls } = routerReturning({ action: "select", workbenchId: "ghost" }, { action: "select", workbenchId: "w-news" });
    await expect(resolveWorkbenchAssignment({ canCreate: true, requestText: "本周 AI 资讯", router, workbenches: [STOCK, NEWS] }))
      .resolves.toEqual({ action: "select", resolution: "selected", workbenchId: "w-news" });
    expect(calls).toEqual([
      { input: "本周 AI 资讯", mode: "route", repair: false },
      { input: "本周 AI 资讯", mode: "route", repair: true },
    ]);
  });
});
