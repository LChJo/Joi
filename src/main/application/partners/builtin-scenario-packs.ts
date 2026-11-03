import { BUILTIN_SCENARIOS, type ScenarioDto, type ScenarioRoleDto } from "../../../shared/joi.js";
import type { PartnerSkillOption } from "../ports/partner-skills.js";
import {
  AI_BERKSHIRE_SCENARIO_PACK,
  type ScenarioPackDefinition,
  type ScenarioPackRoleDefinition,
} from "./ai-berkshire-scenario-pack.js";

const BUILTIN_SOURCE = {
  license: "内置",
  repository: "joi/builtin",
  revision: "builtin-1",
} as const;

function requiredScenario(id: string): ScenarioDto {
  const scenario = BUILTIN_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`Missing built-in scenario: ${id}`);
  return scenario;
}

function packRole(role: ScenarioRoleDto): ScenarioPackRoleDefinition {
  return {
    blurb: role.blurb ?? "按既定职责完成工作并给出可独立验证的结果。",
    capabilities: [],
    id: role.id,
    prompt: role.prompt,
    skills: role.skills ?? [],
    title: role.title,
    tools: [],
  };
}

function packFromScenarios(input: {
  blurb: string;
  id: string;
  scenarioIds: readonly string[];
  title: string;
}): ScenarioPackDefinition {
  const scenarios = input.scenarioIds.map(requiredScenario);
  return {
    blurb: input.blurb,
    definitionVersion: 1,
    id: input.id,
    roles: scenarios.flatMap((scenario) => (scenario.roles ?? []).map(packRole)),
    source: BUILTIN_SOURCE,
    sourceOverlays: [],
    sourceSkills: [],
    teams: scenarios.map((scenario) => ({
      blurb: scenario.blurb,
      id: scenario.id,
      roleIds: (scenario.roles ?? []).map((role) => role.id),
      title: scenario.title,
    })),
    title: input.title,
  };
}

export const PROGRAMMING_SCENARIO_PACK = packFromScenarios({
  blurb: "从功能实现、代码审查、缺陷诊断到架构演进的完整编程协作套件。",
  id: "programming",
  scenarioIds: ["implement-feature", "review-code", "diagnose-bug", "improve-architecture"],
  title: "编程套件",
});

export const RESEARCH_ANALYSIS_SCENARIO_PACK = packFromScenarios({
  blurb: "把目标拆解、风险识别、多视角调研和结论汇总组合成可复用的分析团队。",
  id: "research-analysis",
  scenarioIds: ["plan-big-goal", "research-brief"],
  title: "调研分析套件",
});

function recentSkills(skills: readonly PartnerSkillOption[]): PartnerSkillOption[] {
  return skills
    .slice()
    .sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0))
    .slice(0, 6);
}

function skillRoleId(skillId: string): string {
  return `skill:${encodeURIComponent(skillId)}`;
}

function skillBlurb(skill: PartnerSkillOption): string {
  const description = skill.description?.trim();
  if (description === undefined || description === "") return "读取并遵循这个 Skill 的工作流，交付可独立验证的结果。";
  return description.length > 160 ? `${description.slice(0, 160)}…` : description;
}

export function createBuiltinSkillsScenarioPack(skills: readonly PartnerSkillOption[]): ScenarioPackDefinition {
  const selected = recentSkills(skills);
  return {
    blurb: selected.length === 0
      ? "自动收纳 Pi core 可用的最近 6 个本机 Skill；当前尚未发现可安装项。"
      : "把 Pi core 当前可用的最近 6 个本机 Skill 组装为可单独或整套安装的能力搭档。",
    definitionVersion: 1,
    id: "builtin-skills",
    roles: selected.map((skill) => ({
      blurb: skillBlurb(skill),
      capabilities: ["skill-workflow"],
      id: skillRoleId(skill.id),
      prompt: `你是一位围绕能力「${skill.displayName}」（${skill.id}）开展工作的搭档。DO：接到相关工作时先读取并遵循该 Skill 的说明，再完成行为并交付结果。验收标准：交付物体现该 Skill 的关键约束，且可被独立验证。范围外：不做与该 Skill 无关的工作、不修改 Skill 本身。`,
      skills: [skill.id],
      title: `${skill.displayName}搭档`,
      tools: [],
    })),
    source: {
      license: "依各 Skill 声明",
      repository: "local/skills",
      revision: "live",
    },
    sourceOverlays: [],
    sourceSkills: selected.map((skill) => skill.id),
    teams: selected.map((skill) => ({
      blurb: skillBlurb(skill),
      id: skillRoleId(skill.id),
      roleIds: [skillRoleId(skill.id)],
      title: skill.displayName,
    })),
    title: "内置 Skills 套件",
  };
}

export function defaultScenarioPacks(skills: readonly PartnerSkillOption[]): readonly ScenarioPackDefinition[] {
  return [
    AI_BERKSHIRE_SCENARIO_PACK,
    PROGRAMMING_SCENARIO_PACK,
    RESEARCH_ANALYSIS_SCENARIO_PACK,
    createBuiltinSkillsScenarioPack(skills),
  ];
}
