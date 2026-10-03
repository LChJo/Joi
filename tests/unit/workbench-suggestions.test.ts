import { describe, expect, it } from "vitest";

import {
  WORKBENCH_MATCH_CONFIDENT_SCORE,
  WORKBENCH_SUGGESTION_LIMIT,
  compactWorkbenchText,
  echoedWorkbenchSpan,
  judgeWorkbenchMatch,
  rankWorkbenchMatches,
  workbenchMatchScore,
  workbenchMatchTerms,
  workbenchSuggestions,
} from "../../src/shared/workbench-suggestions";

/** The real workbenches and inputs that motivated the scoring; kept verbatim so the thresholds stay honest. */
const TRAVEL_INPUT = "民宿周边有皖南川藏线，落羽红杉林，青龙湾度假区，山门洞，储家滩，西津野渡，双河漂流，皖南飞瀑漂流，储家滩全地形越野车，惠云禅寺，青龙湾水上乐园，卡丁船。河沥溪古镇。根据以上信息，只分析最近一周（2026 中秋国庆假期信息）小红书和点评携程等信息，分析哪些是最值得去的景点，备注是否需要购票";

const STOCK = { workbenchId: "w1", name: "A股技术面与走势分析环境", scopeSummary: "基于可验证的历史行情与当前市场指标，分析A股沪指的技术走势、周期信号和风险情景；不构成投资建议。" };
const TRAVEL = { workbenchId: "w2", name: "西双版纳深度游行程规划环境", scopeSummary: "旅行行程规划助手：基于网络搜索与口碑评价，为用户定制节奏从容、以深度体验为主的目的地行程，并围绕固定住宿点安排。" };
const NEWS = { workbenchId: "w3", name: "中文AI技术资讯与开源生态调研环境", scopeSummary: "负责中文AI资讯网站、GitHub及相关技术站点的趋势调研、来源交叉验证与技术价值分析。" };
const LARK = { workbenchId: "w4", name: "飞书项目待办分析环境", scopeSummary: "熟悉飞书项目（Lark Project）数据结构与任务管理流程的分析助理，擅长梳理待办事项、识别变更、评估优先级" };

describe("workbench text comparison", () => {
  it("folds punctuation, width and case so the same phrase compares equal", () => {
    expect(compactWorkbenchText("宁国·皖南川藏线")).toBe(compactWorkbenchText("宁国 皖南川藏线"));
    expect(compactWorkbenchText("Ａ股 SDK")).toBe(compactWorkbenchText("a股 sdk"));
  });

  it("keeps a mixed-script run as one term instead of splitting it at the script boundary", () => {
    expect(workbenchMatchTerms("A股分析")).toContain("a股");
  });

  it("overlaps reordered Chinese without a segmenter", () => {
    const terms = workbenchMatchTerms("行程规划");
    expect(terms).toContain("行程");
    expect(terms).toContain("规划");
  });
});

describe("workbenchMatchScore", () => {
  it("scores a same-project reword far above an unrelated workbench", () => {
    const input = "根据近期A股市场数据，分析整体趋势和重要板块的趋势，给出明确的投资建议";
    expect(workbenchMatchScore(input, STOCK)).toBeGreaterThan(workbenchMatchScore(input, TRAVEL) * 2);
  });

  it("scores zero when the input shares nothing with the workbench", () => {
    expect(workbenchMatchScore("帮我写一首关于秋天的诗", STOCK)).toBe(0);
  });

  it("scores zero for an input with no comparable terms", () => {
    expect(workbenchMatchScore("   ", STOCK)).toBe(0);
  });

  it("ranks best first and breaks ties deterministically", () => {
    const ranked = rankWorkbenchMatches("本周中文 AI 技术资讯和开源项目趋势", [STOCK, TRAVEL, NEWS, LARK]);
    expect(ranked[0]?.workbench.workbenchId).toBe("w3");
    expect(ranked.map((match) => match.score)).toEqual([...ranked.map((match) => match.score)].sort((left, right) => right - left));
  });
});

describe("judgeWorkbenchMatch", () => {
  it("takes a clear winner without asking the user", () => {
    expect(judgeWorkbenchMatch("看看我飞书项目里还有哪些待办，按优先级排一下", [STOCK, TRAVEL, NEWS, LARK])).toMatchObject({ kind: "confident", match: { workbench: { workbenchId: "w4" } } });
  });

  it("still resolves a same-project follow-up that shares no wording with the stored scope", () => {
    expect(judgeWorkbenchMatch("西双版纳适合带小孩去吗，行程怎么安排比较好", [STOCK, TRAVEL])).toMatchObject({ kind: "confident", match: { workbench: { workbenchId: "w2" } } });
  });

  it("reports no match for an input that belongs nowhere yet", () => {
    expect(judgeWorkbenchMatch("帮我写一首关于秋天的诗", [STOCK, TRAVEL, NEWS, LARK])).toEqual({ kind: "none" });
  });

  it("reports no match when there are no workbenches at all", () => {
    expect(judgeWorkbenchMatch("随便说说", [])).toEqual({ kind: "none" });
  });

  it("asks instead of guessing when two scopes are equally plausible", () => {
    const first = { workbenchId: "t1", name: "旅行行程规划环境", scopeSummary: "行程规划与出行安排。" };
    const second = { workbenchId: "t2", name: "旅行行程规划助手", scopeSummary: "行程规划与出行安排。" };
    const verdict = judgeWorkbenchMatch("帮我做一份行程规划", [first, second]);
    expect(verdict).toMatchObject({ kind: "ambiguous" });
    expect(verdict.kind === "ambiguous" ? verdict.matches.map((match) => match.workbench.workbenchId) : []).toEqual(["t1", "t2"]);
  });

  it("does not treat a weak near-miss beside a strong match as a dilemma", () => {
    const strong = { workbenchId: "s1", name: "飞书项目待办分析环境", scopeSummary: "飞书项目待办梳理与优先级评估。" };
    const weak = { workbenchId: "s2", name: "海外供应商待办分析环境", scopeSummary: "供应商事项跟进。" };
    expect(judgeWorkbenchMatch("看看我飞书项目里还有哪些待办", [strong, weak])).toMatchObject({ kind: "confident", match: { workbench: { workbenchId: "s1" } } });
  });

  it("keeps the confidence bar where real matches live", () => {
    expect(WORKBENCH_MATCH_CONFIDENT_SCORE).toBeLessThanOrEqual(workbenchMatchScore("根据近期A股市场数据，分析整体趋势和重要板块的趋势", STOCK));
  });
});

describe("echoedWorkbenchSpan", () => {
  it("catches the truncate-and-append name that was actually created", () => {
    expect(echoedWorkbenchSpan("民宿周边有皖南川藏线，落羽红杉林，青… 工作台", TRAVEL_INPUT)).not.toBeNull();
  });

  it("catches a name built from a shorter verbatim slice of the input", () => {
    expect(echoedWorkbenchSpan("民宿周边有皖南川藏线，落羽红杉林 工坊", TRAVEL_INPUT)).not.toBeNull();
  });

  it("accepts a name that abstracts the same work into a cluster", () => {
    expect(echoedWorkbenchSpan("皖南川藏线民宿周边景点调研工坊", TRAVEL_INPUT)).toBeNull();
    expect(echoedWorkbenchSpan("旅行行程规划工坊", TRAVEL_INPUT)).toBeNull();
    expect(echoedWorkbenchSpan("周边民宿与景点分析工作台", TRAVEL_INPUT)).toBeNull();
  });

  it("does not fire on short or empty candidates", () => {
    expect(echoedWorkbenchSpan("", TRAVEL_INPUT)).toBeNull();
    expect(echoedWorkbenchSpan("工坊", TRAVEL_INPUT)).toBeNull();
    expect(echoedWorkbenchSpan("调研与分析工坊", "")).toBeNull();
  });
});

describe("workbenchSuggestions", () => {
  it("offers abstract clusters when nothing existing fits, never the input text", () => {
    const suggestions = workbenchSuggestions({ seed: TRAVEL_INPUT, workbenches: [] });
    expect(suggestions).toHaveLength(WORKBENCH_SUGGESTION_LIMIT);
    expect(suggestions.every((suggestion) => suggestion.kind === "template")).toBe(true);
    for (const suggestion of suggestions) {
      expect(echoedWorkbenchSpan(suggestion.name, TRAVEL_INPUT)).toBeNull();
      expect(echoedWorkbenchSpan(suggestion.scopeSummary, TRAVEL_INPUT)).toBeNull();
      expect(suggestion.name).not.toContain("…");
    }
  });

  it("puts an existing workbench that already carries this work first", () => {
    const suggestions = workbenchSuggestions({
      seed: "西双版纳适合带小孩去吗，行程怎么安排比较好",
      workbenches: [STOCK, TRAVEL],
    });
    expect(suggestions[0]).toMatchObject({ kind: "existing", workbenchId: "w2", name: TRAVEL.name });
    expect(suggestions).toHaveLength(WORKBENCH_SUGGESTION_LIMIT);
  });

  it("never offers an existing workbench whose name just restates the input", () => {
    const echoed = { workbenchId: "e1", name: "民宿周边有皖南川藏线，落羽红杉林，青… 工作台", scopeSummary: "围绕这条输入的目标、资料与执行过程。" };
    const suggestions = workbenchSuggestions({ seed: TRAVEL_INPUT, workbenches: [echoed] });
    expect(suggestions.some((suggestion) => suggestion.workbenchId === "e1")).toBe(false);
  });

  it("honours a smaller limit", () => {
    expect(workbenchSuggestions({ limit: 1, seed: "随便", workbenches: [] })).toHaveLength(1);
  });
});
