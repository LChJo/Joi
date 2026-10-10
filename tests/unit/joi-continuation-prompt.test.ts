import { composeJoiContinuationBackground, JOI_CONTINUATION_CONTEXT_MAX_CHARS } from "../../src/main/application/joi/joi-continuation-prompt.js";
import type { JoiGoalContext, JoiPendingInput } from "../../src/main/application/ports/joi-coordinator.js";

const input: JoiPendingInput = { body: "原始任务", inputId: "goal", status: "PENDING" };
const context: JoiGoalContext = { originalRequest: "原始任务", decisions: [], fogNotes: [], results: [] };

describe("Joi continuation background budget", () => {
  it("retains more evidence with 40K and 60K budgets while keeping 24K as the default", () => {
    const subject = { ...input, goalContext: {
      ...context, results: Array.from({ length: 8 }, (_, index) => ({
        artifactCount: 0, artifacts: [], resultId: `result-${String(index)}`, workId: `work-${String(index)}`, title: "报告",
        body: `START_${String(index)} ${"材料".repeat(6000)} END_${String(index)}`,
      })),
    } };
    const soft = composeJoiContinuationBackground(subject) ?? "";
    const medium = composeJoiContinuationBackground(subject, 40_000) ?? "";
    const large = composeJoiContinuationBackground(subject, 60_000) ?? "";
    expect(soft.length).toBeLessThanOrEqual(24_000);
    expect(medium.length).toBeGreaterThan(soft.length);
    expect(medium.length).toBeLessThanOrEqual(40_000);
    expect(large.length).toBeGreaterThan(medium.length);
    expect(large.length).toBeLessThanOrEqual(60_000);
    expect(large).toContain("END_7");
  });

  it("puts established conclusions before old request text for a tighter provider budget", () => {
    const background = composeJoiContinuationBackground({ ...input, goalContext: {
      ...context, originalRequest: "OLD_REQUEST", completion: { disposition: "CONTINUE", summary: "ESTABLISHED_CONCLUSION" },
      results: [{ artifactCount: 0, artifacts: [], resultId: "result", workId: "work", title: "根因", body: "ROOT_CAUSE_BODY" }],
    } }) ?? "";
    expect(background.indexOf("ESTABLISHED_CONCLUSION")).toBeLessThan(background.indexOf("OLD_REQUEST"));
    expect(background.indexOf("ROOT_CAUSE_BODY")).toBeLessThan(background.indexOf("OLD_REQUEST"));
  });

  it("adds no background to a fresh input and keeps a retry without evidence bounded", () => {
    expect(composeJoiContinuationBackground(input)).toBeUndefined();
    const background = composeJoiContinuationBackground({ ...input, body: "历史补充".repeat(30_000), continuationPrompt: "继续" });
    expect(background).toContain("truncated");
    expect(background?.length).toBeLessThan(JOI_CONTINUATION_CONTEXT_MAX_CHARS);
  });

  it.each(["材料", "\u0000\n\"\\"])("bounds repeated history, decisions, evidence and manifests (%s)", (text) => {
    const background = composeJoiContinuationBackground({
      ...input,
      goalContext: {
        ...context, originalRequest: `${text.repeat(20_000)} 最新补充`, destination: "目标",
        completion: { disposition: "COMPLETED", summary: `${text.repeat(5000)} 已得结论` },
        decisions: Array.from({ length: 30 }, () => ({ kind: "APPROACH", summary: text.repeat(500), detail: text.repeat(5000) })),
        fogNotes: Array.from({ length: 30 }, () => text.repeat(5000)),
        results: Array.from({ length: 40 }, (_, index) => ({
          artifactCount: 100, artifacts: Array.from({ length: 100 }, () => ({ name: text.repeat(1000) })),
          body: `${text.repeat(10_000)} ROOT_CAUSE_END`, resultId: `result-${String(index)}`, title: "根因", workId: `work-${String(index)}`,
        })),
      },
    });
    expect(background?.length).toBeLessThanOrEqual(JOI_CONTINUATION_CONTEXT_MAX_CHARS);
    expect(background).toContain("已得结论");
    expect(background).toContain("truncated");
    expect(background).toContain("omittedResults");
  });

  it("retains conclusion endings and read references when a single report is oversized", () => {
    const background = composeJoiContinuationBackground({ ...input, goalContext: {
      ...context, results: [{ artifactCount: 0, artifacts: [], resultId: "result-root", workId: "root", title: "根因", body: `${"材料".repeat(20_000)} ROOT_CAUSE_END` }],
    } });
    expect(background).toContain("ROOT_CAUSE_END");
    expect(background).toContain("result-root");
    expect(background).toContain("work_read_result");
    expect(background).not.toContain("Current continuation request:");
  });
});
