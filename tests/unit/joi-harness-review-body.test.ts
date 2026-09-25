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
    results: [],
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

  it("requires a requested continuation review to arrange another layer instead of clearing", () => {
    const body = composeReviewBody(digest({ continuationRequested: true }));
    expect(body).toContain("result synthesis explicitly found the evidence incomplete");
    expect(body).toContain("Do not call MAP_CLEARED");
    expect(body).not.toContain("Close-first rule");
  });

  it("lists the revision's result ids so the review can read persisted evidence", () => {
    const body = composeReviewBody(digest({
      results: [
        { resultId: "result-1", workId: "work-1", title: "拉取工单清单", status: "COMPLETED", verification: "PASSED", summary: "16 条待处理。" },
        { resultId: "result-2", workId: "work-2", title: "仓库基线", status: "COMPLETED", verification: "NOT_REQUIRED", summary: "基线已建。" },
      ],
    }));
    expect(body).toContain("Results in this revision:");
    expect(body).toContain("resultId=result-1 workId=work-1 title=拉取工单清单 status=COMPLETED verification=PASSED summary=16 条待处理。");
    expect(body).toContain("resultId=result-2 workId=work-2 title=仓库基线 status=COMPLETED verification=NOT_REQUIRED summary=基线已建。");
    expect(body).toContain("Use work_read_result with a resultId above when a bounded summary is insufficient.");
  });

  it("bounds the digest sections", () => {
    const body = composeReviewBody(digest({
      completionSummary: `首句。${"总".repeat(500)}`,
      decisionCount: 12,
      decisions: Array.from({ length: 12 }, (_, index) => ({ kind: "APPROACH" as const, summary: `决策${String(index)}` })),
      fogNotes: Array.from({ length: 9 }, (_, index) => `雾区${String(index)}`),
      openPaths: Array.from({ length: 9 }, (_, index) => ({ layer: 1, pathId: `p${String(index)}`, title: `路径${String(index)}` })),
      results: Array.from({ length: 9 }, (_, index) => ({
        resultId: `r${String(index)}`, workId: `w${String(index)}`, title: "标题", status: "COMPLETED", verification: "PASSED", summary: "摘要。",
      })),
    }));
    const decisionLines = body.split("\n").filter((line) => line.startsWith("- [APPROACH]"));
    expect(decisionLines).toHaveLength(8);
    expect(body).toContain("（另有 4 条更早的决策）");
    const fogSection = body.split("Not yet specified (fog):")[1]?.split("Open paths:")[0] ?? "";
    expect(fogSection.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(6);
    const pathSection = body.split("Open paths:")[1]?.split("Results in this revision:")[0] ?? "";
    expect(pathSection.split("\n").filter((line) => line.startsWith("- L"))).toHaveLength(6);
    const resultLines = body.split("\n").filter((line) => line.startsWith("resultId="));
    expect(resultLines).toHaveLength(8);
    expect(body).toContain("（另有 1 条更早的结果）");
    // The completion preview ends at a sentence boundary instead of mid-sentence.
    expect(body).toContain("Latest completion: 首句。");
    expect(body).not.toContain("总");
  });

  it("falls back to the character cut when no boundary fits inside the summary limit", () => {
    const body = composeReviewBody(digest({ completionSummary: "总".repeat(2000) }));
    expect(body).toContain(`Latest completion: ${"总".repeat(320)}`);
    expect(body).not.toContain("总".repeat(321));
  });
});
