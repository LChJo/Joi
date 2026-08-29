import {
  createBuiltinSkillsScenarioPack,
  PROGRAMMING_SCENARIO_PACK,
  RESEARCH_ANALYSIS_SCENARIO_PACK,
} from "../../src/main/application/partners/builtin-scenario-packs.js";

describe("built-in scenario pack catalog", () => {
  it("maps the programming lifecycle into four teams and eight stable roles", () => {
    expect(PROGRAMMING_SCENARIO_PACK).toMatchObject({
      id: "programming",
      title: "编程套件",
    });
    expect(PROGRAMMING_SCENARIO_PACK.teams.map((team) => team.id)).toEqual([
      "implement-feature",
      "review-code",
      "diagnose-bug",
      "improve-architecture",
    ]);
    expect(PROGRAMMING_SCENARIO_PACK.roles).toHaveLength(8);
    expect(new Set(PROGRAMMING_SCENARIO_PACK.roles.map((role) => role.id)).size).toBe(8);
  });

  it("maps planning and parallel research into the research analysis suite", () => {
    expect(RESEARCH_ANALYSIS_SCENARIO_PACK).toMatchObject({
      id: "research-analysis",
      title: "调研分析套件",
    });
    expect(RESEARCH_ANALYSIS_SCENARIO_PACK.teams.map((team) => team.id)).toEqual(["plan-big-goal", "research-brief"]);
    expect(RESEARCH_ANALYSIS_SCENARIO_PACK.roles).toHaveLength(4);
  });

  it("caps the Skills suite at the six most recent portable refs", () => {
    const pack = createBuiltinSkillsScenarioPack(Array.from({ length: 7 }, (_, index) => ({
      description: `第 ${String(index + 1)} 个技能`,
      displayName: `技能 ${String(index + 1)}`,
      id: `agents/skill-${String(index + 1)}`,
      modifiedAt: index + 1,
    })));

    expect(pack.roles).toHaveLength(6);
    expect(pack.sourceSkills).toEqual([
      "agents/skill-7", "agents/skill-6", "agents/skill-5", "agents/skill-4", "agents/skill-3", "agents/skill-2",
    ]);
    expect(pack.roles.every((role) => role.skills.length === 1 && !role.id.includes("/"))).toBe(true);
    expect(pack.roles.some((role) => role.skills.includes("agents/skill-1"))).toBe(false);
  });
});
