import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import type { PartnerDto, ScenarioDto, ScenarioPackDto, ScenarioPackInstallResultDto } from "../../src/shared/joi";
import { createRuntimeFixture } from "../support/runtime-fixture";

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

async function createSession() {
  const fixture = await createRuntimeFixture();
  const listeners = await startRuntimeListeners({ handler: createApiHandler(fixture), loopbackPort: 0 });
  const bootstrap = await fixture.auth.issueDesktopBootstrap();
  const authenticated = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
    body: JSON.stringify({ nonce: bootstrap.nonce }),
    headers: { "content-type": "application/json", origin: "null" },
    method: "POST",
  });
  const cookie = cookieFrom(authenticated);
  const { csrfToken } = await authenticated.json() as { csrfToken: string };
  return {
    async close() {
      await listeners.close();
      await fixture.close();
    },
    headers: { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": csrfToken },
    url: listeners.loopback.url,
  };
}

describe("scenarios HTTP API", () => {
  it("lists the multi-suite catalog and installs built-in teams without exposing embedded prompts", async () => {
    const emptyClaude = mkdtempSync(join(tmpdir(), "joi-suite-empty-claude-"));
    const emptyCodex = mkdtempSync(join(tmpdir(), "joi-suite-empty-codex-"));
    const emptyAgents = mkdtempSync(join(tmpdir(), "joi-suite-empty-agents-"));
    const previousAgents = process.env.JOI_AGENTS_SKILLS_DIR;
    const previousClaude = process.env.JOI_CLAUDE_SKILLS_DIR;
    const previousCodex = process.env.JOI_CODEX_SKILLS_DIR;
    process.env.JOI_CLAUDE_SKILLS_DIR = emptyClaude;
    process.env.JOI_CODEX_SKILLS_DIR = emptyCodex;
    process.env.JOI_AGENTS_SKILLS_DIR = emptyAgents;
    const session = await createSession();
    try {
      const listed = await fetch(`${session.url}/api/v1/scenario-packs`, { headers: session.headers });
      expect(listed.status).toBe(200);
      const body = await listed.json() as { items: ScenarioPackDto[] };
      expect(body.items.map((item) => item.id)).toEqual([
        "ai-berkshire-value-research",
        "programming",
        "research-analysis",
        "builtin-skills",
      ]);
      expect(body.items[0]).toMatchObject({ id: "ai-berkshire-value-research", installedRoleCount: 0, status: "NOT_INSTALLED", totalRoleCount: 15 });
      expect(body.items.find((item) => item.id === "programming")).toMatchObject({ status: "NOT_INSTALLED", title: "编程套件", totalRoleCount: 8 });
      expect(body.items.find((item) => item.id === "research-analysis")).toMatchObject({ status: "NOT_INSTALLED", title: "调研分析套件", totalRoleCount: 4 });
      expect(body.items.find((item) => item.id === "builtin-skills")).toMatchObject({ status: "NOT_INSTALLED", title: "内置 Skills 套件", totalRoleCount: 0 });
      expect(JSON.stringify(body)).not.toContain("你的职责");
      expect(body.items[0]?.teams).toHaveLength(6);

      const programmed = await fetch(`${session.url}/api/v1/scenario-packs/programming/install`, {
        body: JSON.stringify({ teamIds: ["implement-feature"] }), headers: session.headers, method: "POST",
      });
      expect(programmed.status).toBe(201);
      expect(await programmed.json() as ScenarioPackInstallResultDto).toMatchObject({ installedRoleCount: 2, packId: "programming", status: "ACTIVE" });

      const emptySkillsInstall = await fetch(`${session.url}/api/v1/scenario-packs/builtin-skills/install`, {
        body: JSON.stringify({}), headers: session.headers, method: "POST",
      });
      expect(emptySkillsInstall.status).toBe(400);
      expect(await emptySkillsInstall.json()).toMatchObject({ code: "scenario_pack_empty" });

      const installed = await fetch(`${session.url}/api/v1/scenario-packs/ai-berkshire-value-research/install`, {
        body: JSON.stringify({ teamIds: ["research-publishing"] }), headers: session.headers, method: "POST",
      });
      expect(installed.status).toBe(201);
      expect(await installed.json() as ScenarioPackInstallResultDto).toMatchObject({ installedRoleCount: 3, packId: "ai-berkshire-value-research", status: "ACTIVE" });

      const invalid = await fetch(`${session.url}/api/v1/scenario-packs/ai-berkshire-value-research/install`, {
        body: JSON.stringify({ teamIds: [] }), headers: session.headers, method: "POST",
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "scenario_pack_team_selection_empty" });
    } finally {
      await session.close();
      if (previousClaude === undefined) delete process.env.JOI_CLAUDE_SKILLS_DIR; else process.env.JOI_CLAUDE_SKILLS_DIR = previousClaude;
      if (previousCodex === undefined) delete process.env.JOI_CODEX_SKILLS_DIR; else process.env.JOI_CODEX_SKILLS_DIR = previousCodex;
      if (previousAgents === undefined) delete process.env.JOI_AGENTS_SKILLS_DIR; else process.env.JOI_AGENTS_SKILLS_DIR = previousAgents;
    }
  });

  it("serves built-in scenarios and maps scanned local skills into supplementary ones", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "joi-scenario-claude-"));
    const emptyCodex = mkdtempSync(join(tmpdir(), "joi-scenario-codex-"));
    const emptyAgents = mkdtempSync(join(tmpdir(), "joi-scenario-agents-"));
    const previousAgents = process.env.JOI_AGENTS_SKILLS_DIR;
    const previousClaude = process.env.JOI_CLAUDE_SKILLS_DIR;
    const previousCodex = process.env.JOI_CODEX_SKILLS_DIR;
    process.env.JOI_CLAUDE_SKILLS_DIR = claudeDir;
    process.env.JOI_CODEX_SKILLS_DIR = emptyCodex;
    process.env.JOI_AGENTS_SKILLS_DIR = emptyAgents;
    const session = await createSession();
    try {
      const builtinOnly = await fetch(`${session.url}/api/v1/scenarios`, { headers: session.headers });
      expect(builtinOnly.status).toBe(200);
      const firstItems = (await builtinOnly.json() as { items: ScenarioDto[] }).items;
      expect(firstItems.some((item) => item.id === "plan-big-goal" && item.source === "builtin")).toBe(true);
      expect(firstItems.every((item) => item.source === "builtin")).toBe(true);
      const builtins = firstItems.filter((item) => item.source === "builtin");
      expect(builtins).toHaveLength(6);
      for (const item of builtins) {
        expect(item.roles?.length ?? 0).toBeGreaterThanOrEqual(2);
        for (const role of item.roles ?? []) {
          expect(role.id.length).toBeGreaterThan(0);
          expect(role.title.length).toBeGreaterThan(0);
          expect(role.prompt.length).toBeGreaterThan(0);
        }
      }

      const skillDir = join(claudeDir, "demo-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: 演示技能工作流\ndisplay_name: 演示技能\n---\n# Demo\nbody\n");
      const withSkill = await fetch(`${session.url}/api/v1/scenarios`, { headers: session.headers });
      const secondItems = (await withSkill.json() as { items: ScenarioDto[] }).items;
      const skillScenario = secondItems.find((item) => item.source === "skill");
      expect(skillScenario).toMatchObject({ id: "skill:claude-code/demo-skill", source: "skill", title: "演示技能" });
      expect(skillScenario?.prompt).toContain("演示技能");
      expect(skillScenario?.roles).toEqual([expect.objectContaining({ skills: ["claude-code/demo-skill"] })]);

      const packsResponse = await fetch(`${session.url}/api/v1/scenario-packs`, { headers: session.headers });
      const packs = (await packsResponse.json() as { items: ScenarioPackDto[] }).items;
      const skillsPack = packs.find((item) => item.id === "builtin-skills");
      expect(skillsPack).toMatchObject({ title: "内置 Skills 套件", totalRoleCount: 1 });
      expect(skillsPack?.teams).toEqual([
        expect.objectContaining({ title: "演示技能", roles: [expect.objectContaining({ title: "演示技能工坊" })] }),
      ]);

      const installed = await fetch(`${session.url}/api/v1/scenario-packs/builtin-skills/install`, {
        body: JSON.stringify({ teamIds: [skillsPack?.teams[0]?.id] }), headers: session.headers, method: "POST",
      });
      expect(installed.status).toBe(201);
      const installedResult = await installed.json() as ScenarioPackInstallResultDto;
      expect(installedResult).toMatchObject({ installedRoleCount: 1, packId: "builtin-skills", status: "ACTIVE" });
      const partners = (await (await fetch(`${session.url}/api/v1/partners`, { headers: session.headers })).json() as { items: PartnerDto[] }).items;
      expect(partners.some((partner) => partner.skills.includes("claude-code/demo-skill"))).toBe(true);
    } finally {
      await session.close();
      if (previousClaude === undefined) delete process.env.JOI_CLAUDE_SKILLS_DIR; else process.env.JOI_CLAUDE_SKILLS_DIR = previousClaude;
      if (previousCodex === undefined) delete process.env.JOI_CODEX_SKILLS_DIR; else process.env.JOI_CODEX_SKILLS_DIR = previousCodex;
      if (previousAgents === undefined) delete process.env.JOI_AGENTS_SKILLS_DIR; else process.env.JOI_AGENTS_SKILLS_DIR = previousAgents;
    }
  });

  it("caps the skill-derived scenarios at the six most recent skills", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "joi-scenario-cap-"));
    const emptyCodex = mkdtempSync(join(tmpdir(), "joi-scenario-cap-codex-"));
    const emptyAgents = mkdtempSync(join(tmpdir(), "joi-scenario-cap-agents-"));
    const previousAgents = process.env.JOI_AGENTS_SKILLS_DIR;
    const previousClaude = process.env.JOI_CLAUDE_SKILLS_DIR;
    const previousCodex = process.env.JOI_CODEX_SKILLS_DIR;
    process.env.JOI_CLAUDE_SKILLS_DIR = claudeDir;
    process.env.JOI_CODEX_SKILLS_DIR = emptyCodex;
    process.env.JOI_AGENTS_SKILLS_DIR = emptyAgents;
    const session = await createSession();
    try {
      for (let index = 1; index <= 7; index += 1) {
        const dir = join(claudeDir, `skill-${String(index)}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: skill-${String(index)}\ndescription: 技能 ${String(index)} 工作流\ndisplay_name: 技能 ${String(index)}\n---\n# 技能 ${String(index)}\nbody\n`);
        utimesSync(dir, new Date(1_000_000 + index * 1_000), new Date(1_000_000 + index * 1_000));
      }
      const response = await fetch(`${session.url}/api/v1/scenarios`, { headers: session.headers });
      const items = (await response.json() as { items: ScenarioDto[] }).items;
      const skillItems = items.filter((item) => item.source === "skill");
      expect(skillItems).toHaveLength(6);
      expect(skillItems.some((item) => item.title === "技能 7")).toBe(true);
      expect(skillItems.some((item) => item.title === "技能 1")).toBe(false);
      const packs = (await (await fetch(`${session.url}/api/v1/scenario-packs`, { headers: session.headers })).json() as { items: ScenarioPackDto[] }).items;
      const skillsPack = packs.find((item) => item.id === "builtin-skills");
      expect(skillsPack?.totalRoleCount).toBe(6);
      expect(skillsPack?.teams.some((team) => team.title === "技能 7")).toBe(true);
      expect(skillsPack?.teams.some((team) => team.title === "技能 1")).toBe(false);
    } finally {
      await session.close();
      if (previousClaude === undefined) delete process.env.JOI_CLAUDE_SKILLS_DIR; else process.env.JOI_CLAUDE_SKILLS_DIR = previousClaude;
      if (previousCodex === undefined) delete process.env.JOI_CODEX_SKILLS_DIR; else process.env.JOI_CODEX_SKILLS_DIR = previousCodex;
      if (previousAgents === undefined) delete process.env.JOI_AGENTS_SKILLS_DIR; else process.env.JOI_AGENTS_SKILLS_DIR = previousAgents;
    }
  });

  it("creates partners deterministically from a scenario's selected roles", async () => {
    const session = await createSession();
    try {
      const list = (await (await fetch(`${session.url}/api/v1/scenarios`, { headers: session.headers })).json() as { items: ScenarioDto[] }).items;
      const review = list.find((item) => item.id === "review-code");
      const firstRoleId = review?.roles?.[0]?.id ?? "missing";

      const all = await fetch(`${session.url}/api/v1/scenarios/review-code/partners`, { body: JSON.stringify({}), headers: session.headers, method: "POST" });
      expect(all.status).toBe(201);
      const allItems = (await all.json() as { items: PartnerDto[] }).items;
      expect(allItems).toHaveLength(review?.roles?.length ?? 0);
      expect(allItems.every((item) => item.createdBy === "user" && item.engine === "pi-core" && item.kind === "local-pi")).toBe(true);

      const subset = await fetch(`${session.url}/api/v1/scenarios/review-code/partners`, { body: JSON.stringify({ roleIds: [firstRoleId] }), headers: session.headers, method: "POST" });
      expect(subset.status).toBe(201);
      const subsetItems = (await subset.json() as { items: PartnerDto[] }).items;
      expect(subsetItems).toHaveLength(1);
      expect(subsetItems[0]?.displayName).toBe(review?.roles?.[0]?.title);

      const badRole = await fetch(`${session.url}/api/v1/scenarios/review-code/partners`, { body: JSON.stringify({ roleIds: ["nope"] }), headers: session.headers, method: "POST" });
      expect(badRole.status).toBe(400);
      expect(await badRole.json()).toMatchObject({ code: "scenario_role_invalid" });

      const missing = await fetch(`${session.url}/api/v1/scenarios/unknown-scenario/partners`, { body: JSON.stringify({}), headers: session.headers, method: "POST" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "scenario_not_found" });

      const unauth = await fetch(`${session.url}/api/v1/scenarios/review-code/partners`, {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      expect(unauth.status).toBe(401);
    } finally {
      await session.close();
    }
  });

  it("attaches the scanned skill to the partner created from a skill scenario", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "joi-scenario-create-"));
    const emptyCodex = mkdtempSync(join(tmpdir(), "joi-scenario-create-codex-"));
    const emptyAgents = mkdtempSync(join(tmpdir(), "joi-scenario-create-agents-"));
    const previousAgents = process.env.JOI_AGENTS_SKILLS_DIR;
    const previousClaude = process.env.JOI_CLAUDE_SKILLS_DIR;
    const previousCodex = process.env.JOI_CODEX_SKILLS_DIR;
    process.env.JOI_CLAUDE_SKILLS_DIR = claudeDir;
    process.env.JOI_CODEX_SKILLS_DIR = emptyCodex;
    process.env.JOI_AGENTS_SKILLS_DIR = emptyAgents;
    const skillDir = join(claudeDir, "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: 演示技能工作流\ndisplay_name: 演示技能\n---\n# Demo\nbody\n");
    const session = await createSession();
    try {
      const response = await fetch(`${session.url}/api/v1/scenarios/${encodeURIComponent("skill:claude-code/demo-skill")}/partners`, { body: JSON.stringify({}), headers: session.headers, method: "POST" });
      expect(response.status).toBe(201);
      const items = (await response.json() as { items: PartnerDto[] }).items;
      expect(items).toHaveLength(1);
      expect(items[0]?.skills).toEqual(["claude-code/demo-skill"]);
      expect(items[0]?.displayName).toContain("演示技能");
    } finally {
      await session.close();
      if (previousClaude === undefined) delete process.env.JOI_CLAUDE_SKILLS_DIR; else process.env.JOI_CLAUDE_SKILLS_DIR = previousClaude;
      if (previousCodex === undefined) delete process.env.JOI_CODEX_SKILLS_DIR; else process.env.JOI_CODEX_SKILLS_DIR = previousCodex;
      if (previousAgents === undefined) delete process.env.JOI_AGENTS_SKILLS_DIR; else process.env.JOI_AGENTS_SKILLS_DIR = previousAgents;
    }
  });
});
