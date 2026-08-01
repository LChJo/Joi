import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import type { ScenarioDto } from "../../src/shared/joi";
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

      const skillDir = join(claudeDir, "demo-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndisplay_name: 演示技能\n---\n# Demo\nbody\n");
      const withSkill = await fetch(`${session.url}/api/v1/scenarios`, { headers: session.headers });
      const secondItems = (await withSkill.json() as { items: ScenarioDto[] }).items;
      const skillScenario = secondItems.find((item) => item.source === "skill");
      expect(skillScenario).toMatchObject({ id: "skill:claude-code/demo-skill", source: "skill", title: "演示技能" });
      expect(skillScenario?.prompt).toContain("演示技能");
    } finally {
      await session.close();
      if (previousClaude === undefined) delete process.env.JOI_CLAUDE_SKILLS_DIR; else process.env.JOI_CLAUDE_SKILLS_DIR = previousClaude;
      if (previousCodex === undefined) delete process.env.JOI_CODEX_SKILLS_DIR; else process.env.JOI_CODEX_SKILLS_DIR = previousCodex;
      if (previousAgents === undefined) delete process.env.JOI_AGENTS_SKILLS_DIR; else process.env.JOI_AGENTS_SKILLS_DIR = previousAgents;
    }
  });
});
