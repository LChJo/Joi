import { AI_BERKSHIRE_SCENARIO_PACK } from "../../src/main/application/partners/ai-berkshire-scenario-pack.js";

describe("AI Berkshire scenario pack catalog", () => {
  it("ships the approved six teams and fifteen stable partner roles", () => {
    expect(AI_BERKSHIRE_SCENARIO_PACK.id).toBe("ai-berkshire-value-research");
    expect(AI_BERKSHIRE_SCENARIO_PACK.teams).toHaveLength(6);
    expect(AI_BERKSHIRE_SCENARIO_PACK.roles).toHaveLength(15);
    expect(new Set(AI_BERKSHIRE_SCENARIO_PACK.roles.map((role) => role.id)).size).toBe(15);
    expect(AI_BERKSHIRE_SCENARIO_PACK.teams.map((team) => team.id)).toEqual([
      "opportunity-screening",
      "listed-company",
      "earnings-events",
      "industry-private",
      "portfolio-thesis",
      "research-publishing",
    ]);
    expect(AI_BERKSHIRE_SCENARIO_PACK.teams.every((team) => team.roleIds.every(
      (roleId) => AI_BERKSHIRE_SCENARIO_PACK.roles.some((role) => role.id === roleId),
    ))).toBe(true);
  });

  it("retains provenance for all canonical skills without depending on the source checkout", () => {
    expect(AI_BERKSHIRE_SCENARIO_PACK.source).toMatchObject({
      license: "MIT",
      repository: "xbtlin/ai-berkshire",
      revision: "2760dc48cfd3c4738229aa15c24571942af8f8ed",
    });
    expect(new Set(AI_BERKSHIRE_SCENARIO_PACK.sourceSkills)).toEqual(new Set([
      "bottleneck-hunter", "deep-company-series", "dyp-ask", "earnings-review", "earnings-team",
      "financial-data", "income-investment", "industry-funnel", "industry-research", "investment-checklist",
      "investment-research", "investment-team", "management-deep-dive", "news-pulse", "portfolio-review",
      "private-company-research", "quality-screen", "thesis-drift", "thesis-tracker", "wechat-article",
    ]));
    expect(AI_BERKSHIRE_SCENARIO_PACK.sourceOverlays).toEqual(["investment-memo-craft"]);
    expect(AI_BERKSHIRE_SCENARIO_PACK.roles.every((role) => role.skills.length === 0)).toBe(true);
    expect(JSON.stringify(AI_BERKSHIRE_SCENARIO_PACK)).not.toMatch(/[A-Z]:\\|git push|Task\(|Agent\(/u);
  });

  it("assigns deterministic finance and audit tools only through the portable tool catalog", () => {
    const financial = AI_BERKSHIRE_SCENARIO_PACK.roles.find((role) => role.id === "financial-valuation");
    const auditor = AI_BERKSHIRE_SCENARIO_PACK.roles.find((role) => role.id === "data-auditor");
    expect(financial?.tools).toEqual(expect.arrayContaining(["financial_calculate", "web_search", "fetch_content"]));
    expect(auditor?.tools).toEqual(expect.arrayContaining(["financial_calculate", "research_audit"]));
  });
});
