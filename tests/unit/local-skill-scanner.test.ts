import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalSkillScanner } from "../../src/main/infrastructure/skills/local-skill-scanner.js";

function withSkillDirs(claudeDir: string, run: () => void): void {
  const empty = mkdtempSync(join(tmpdir(), "joi-skills-empty-"));
  const previousClaude = process.env.JOI_CLAUDE_SKILLS_DIR;
  const previousCodex = process.env.JOI_CODEX_SKILLS_DIR;
  const previousAgents = process.env.JOI_AGENTS_SKILLS_DIR;
  process.env.JOI_CLAUDE_SKILLS_DIR = claudeDir;
  process.env.JOI_CODEX_SKILLS_DIR = empty;
  process.env.JOI_AGENTS_SKILLS_DIR = empty;
  try {
    run();
  } finally {
    if (previousClaude === undefined) delete process.env.JOI_CLAUDE_SKILLS_DIR; else process.env.JOI_CLAUDE_SKILLS_DIR = previousClaude;
    if (previousCodex === undefined) delete process.env.JOI_CODEX_SKILLS_DIR; else process.env.JOI_CODEX_SKILLS_DIR = previousCodex;
    if (previousAgents === undefined) delete process.env.JOI_AGENTS_SKILLS_DIR; else process.env.JOI_AGENTS_SKILLS_DIR = previousAgents;
  }
}

describe("local skill scanner", () => {
  it("lists skills per engine from the on-disk sources and reads selected instructions", () => {
    const root = mkdtempSync(join(tmpdir(), "joi-skills-claude-"));
    const skillDir = join(root, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: my-skill\ndisplay_name: 我的技能\n---\n# Title\nbody text here\n");
    const titled = join(root, "titled-skill");
    mkdirSync(titled, { recursive: true });
    writeFileSync(join(titled, "SKILL.md"), "# Heading Only\nsome body\n");

    const scanner = new LocalSkillScanner();
    withSkillDirs(root, () => {
      const listed = scanner.listForEngine("claude-code");
      expect(listed).toHaveLength(2);
      expect(listed.every((option) => typeof option.modifiedAt === "number")).toBe(true);
      expect(listed).toEqual(expect.arrayContaining([
        expect.objectContaining({ displayName: "Heading Only", id: "claude-code/titled-skill" }),
        expect.objectContaining({ displayName: "我的技能", id: "claude-code/my-skill" }),
      ]));
      expect(scanner.listForEngine("pi-core").map((option) => option.id)).toContain("claude-code/my-skill");
      expect(scanner.listForEngine("codex")).toEqual([]);

      const instructions = scanner.readInstructions(["claude-code/my-skill"]);
      expect(instructions).toContain("## Skill: my-skill");
      expect(instructions).toContain("body text here");
      expect(scanner.readInstructions(["claude-code/missing"])).toBe("");
      expect(scanner.readInstructions(["not-a-ref"])).toBe("");
      expect(scanner.readInstructions(["claude-code/../../etc"])).toBe("");
    });
  });
});
