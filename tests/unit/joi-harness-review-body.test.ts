import { composeReviewBody } from "../../src/main/application/joi/joi-harness-review-body";
import type { HarnessReviewDigest } from "../../src/main/application/ports/joi-harness";

function digest(overrides?: Partial<HarnessReviewDigest>): HarnessReviewDigest {
  return {
    workbenchId: "workbench-1",
    completionSummary: "第一层完成",
    decisionCount: 1,
    decisions: [{ kind: "APPROACH", summary: "先查资料" }],
    destination: "分析股票 688141",
    fogNotes: ["数据源未定"],
    goalInputId: "goal-1",
    openPaths: [{ layer: 1, pathId: "path-1", title: "收集资料" }],
    resultRevision: 2,
    ...overrides,
  };
}

describe("composeReviewBody", () => {
  it("carries the goal identity, map digest and the one-decision discipline", () => {
    const body = composeReviewBody(digest());
    expect(body).toContain("goalInputId=goal-1");
    expect(body).toContain("resultRevision=2");
    expect(body).toContain("destination=分析股票 688141");
    expect(body).toContain("- [APPROACH] 先查资料");
    expect(body).toContain("- 数据源未定");
    expect(body).toContain("- L1 收集资料");
    expect(body).toContain("Latest completion: 第一层完成");
    expect(body).toContain("resolve at most ONE decision");
    expect(body).toContain("MAP_CLEARED");
  });

  it("points an unnamed destination at harness_name_destination", () => {
    const body = composeReviewBody(digest({ destination: null }));
    expect(body).toContain("harness_name_destination");
  });

  it("bounds the digest sections", () => {
    const body = composeReviewBody(digest({
      completionSummary: "总".repeat(500),
      decisionCount: 12,
      decisions: Array.from({ length: 12 }, (_, index) => ({ kind: "APPROACH" as const, summary: `决策${String(index)}` })),
      fogNotes: Array.from({ length: 9 }, (_, index) => `雾区${String(index)}`),
      openPaths: Array.from({ length: 9 }, (_, index) => ({ layer: 1, pathId: `p${String(index)}`, title: `路径${String(index)}` })),
    }));
    const decisionLines = body.split("\n").filter((line) => line.startsWith("- [APPROACH]"));
    expect(decisionLines).toHaveLength(8);
    expect(body).toContain("（另有 4 条更早的决策）");
    const fogSection = body.split("Not yet specified (fog):")[1]?.split("Open paths:")[0] ?? "";
    expect(fogSection.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(6);
    const pathSection = body.split("Open paths:")[1]?.split("Latest completion:")[0] ?? "";
    expect(pathSection.split("\n").filter((line) => line.startsWith("- L"))).toHaveLength(6);
    expect(body).toContain(`Latest completion: ${"总".repeat(320)}`);
    expect(body).not.toContain("总".repeat(321));
  });
});
