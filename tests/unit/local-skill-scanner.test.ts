import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalSkillScanner } from "../../src/main/infrastructure/skills/local-skill-scanner.js";

function writeSkill(root: string, relativeDir: string, input: { body?: string; description: string; frontmatter?: string[]; name: string }): string {
  const directory = join(root, ...relativeDir.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), [
    "---",
    `name: ${input.name}`,
    `description: ${input.description}`,
    ...(input.frontmatter ?? []),
    "---",
    input.body ?? "Follow the selected workflow.",
    "",
  ].join("\n"));
  return directory;
}

function withSkillDirs(claudeDir: string, run: (dirs: { agents: string; codex: string }) => void): void {
  const agents = mkdtempSync(join(tmpdir(), "joi-skills-agents-"));
  const codex = mkdtempSync(join(tmpdir(), "joi-skills-codex-"));
  const previousClaude = process.env.JOI_CLAUDE_SKILLS_DIR;
  const previousCodex = process.env.JOI_CODEX_SKILLS_DIR;
  const previousAgents = process.env.JOI_AGENTS_SKILLS_DIR;
  process.env.JOI_CLAUDE_SKILLS_DIR = claudeDir;
  process.env.JOI_CODEX_SKILLS_DIR = codex;
  process.env.JOI_AGENTS_SKILLS_DIR = agents;
  try {
    run({ agents, codex });
  } finally {
    if (previousClaude === undefined) delete process.env.JOI_CLAUDE_SKILLS_DIR; else process.env.JOI_CLAUDE_SKILLS_DIR = previousClaude;
    if (previousCodex === undefined) delete process.env.JOI_CODEX_SKILLS_DIR; else process.env.JOI_CODEX_SKILLS_DIR = previousCodex;
    if (previousAgents === undefined) delete process.env.JOI_AGENTS_SKILLS_DIR; else process.env.JOI_AGENTS_SKILLS_DIR = previousAgents;
  }
}

describe("local skill scanner", () => {
  it("uses the Pi SDK parser for nested Skill metadata and engine-specific collision precedence", () => {
    const claude = mkdtempSync(join(tmpdir(), "joi-skills-claude-"));
    writeSkill(claude, "groups/review", { description: "Review a change safely", name: "review" });

    withSkillDirs(claude, ({ agents, codex }) => {
      writeSkill(agents, "shared", { description: "Preferred shared workflow", name: "shared" });
      writeSkill(codex, "other-folder", { description: "Lower priority duplicate", name: "shared" });
      writeSkill(codex, "release", { description: "Prepare a release", name: "release" });
      const scanner = new LocalSkillScanner();

      expect(scanner.listForEngine("claude-code")).toEqual([
        expect.objectContaining({ description: "Review a change safely", displayName: "review", id: "claude-code/groups/review" }),
      ]);
      expect(scanner.listForEngine("codex").map((option) => option.id)).toEqual(["codex/release", "agents/shared"]);
      expect(scanner.listForEngine("pi-core").map((option) => option.id)).toEqual([
        "codex/release", "claude-code/groups/review", "agents/shared",
      ]);
      expect(scanner.listForEngine("pi-core").every((option) => typeof option.modifiedAt === "number")).toBe(true);
    });
  });

  it("loads only exact selected Skill paths and formats metadata without eagerly injecting the body", () => {
    const claude = mkdtempSync(join(tmpdir(), "joi-skills-claude-"));
    const selectedRoot = writeSkill(claude, "selected", {
      body: "SELECTED_BODY_MUST_BE_READ_ON_DEMAND",
      description: "Selected skill description",
      name: "selected",
    });
    writeSkill(claude, "unselected", { body: "UNSELECTED_PRIVATE_BODY", description: "Unselected description", name: "unselected" });

    withSkillDirs(claude, () => {
      const scanner = new LocalSkillScanner();
      const dispatch = scanner.resolveForPi(["claude-code/selected"]);
      expect(dispatch.skillCount).toBe(1);
      expect(dispatch.environmentKeys).toEqual([]);
      expect(dispatch.promptSection).toContain("selected");
      expect(dispatch.promptSection).toContain("Selected skill description");
      expect(dispatch.promptSection).toContain(join(selectedRoot, "SKILL.md"));
      expect(dispatch.promptSection).not.toContain("SELECTED_BODY_MUST_BE_READ_ON_DEMAND");
      expect(dispatch.promptSection).not.toContain("unselected");
      expect(dispatch.promptSection).not.toContain("UNSELECTED_PRIVATE_BODY");

      expect(scanner.readInstructions(["claude-code/selected"])).toContain("SELECTED_BODY_MUST_BE_READ_ON_DEMAND");
    });
  });

  it("returns normalized required environment names only for exact selected Skills", () => {
    const claude = mkdtempSync(join(tmpdir(), "joi-skills-claude-"));
    writeSkill(claude, "search", {
      description: "Search safely",
      frontmatter: ["metadata:", "  joi_required_env: [tavily_api_key, TAVILY_API_KEY, SEARCH_REGION]"],
      name: "search",
    });
    writeSkill(claude, "other", {
      description: "Other workflow",
      frontmatter: ["metadata:", "  joi_required_env: [OTHER_PRIVATE_KEY]"],
      name: "other",
    });

    withSkillDirs(claude, () => {
      const scanner = new LocalSkillScanner();
      expect(scanner.resolveForPi(["claude-code/search"]).environmentKeys).toEqual(["TAVILY_API_KEY", "SEARCH_REGION"]);
    });
  });

  it("fails selected Skills closed when required environment metadata is malformed", () => {
    const claude = mkdtempSync(join(tmpdir(), "joi-skills-claude-"));
    writeSkill(claude, "invalid-env", {
      description: "Invalid environment declaration",
      frontmatter: ["metadata:", "  joi_required_env: [TAVILY_API_KEY, 42]"],
      name: "invalid-env",
    });

    withSkillDirs(claude, () => {
      const scanner = new LocalSkillScanner();
      expect(() => scanner.resolveForPi(["claude-code/invalid-env"]))
        .toThrow(expect.objectContaining({ code: "partner_skill_environment_invalid" }));
    });
  });

  it("fails closed for malformed, missing, colliding or engine-incompatible references", () => {
    const claude = mkdtempSync(join(tmpdir(), "joi-skills-claude-"));
    writeSkill(claude, "one", { description: "One", name: "duplicate" });
    writeSkill(claude, "two", { description: "Two", name: "duplicate" });

    withSkillDirs(claude, () => {
      const scanner = new LocalSkillScanner();
      expect(() => scanner.validateRefs("pi-core", ["not-a-ref"])).toThrow(expect.objectContaining({ code: "partner_skill_ref_invalid" }));
      expect(() => scanner.validateRefs("pi-core", ["claude-code/../../etc"])).toThrow(expect.objectContaining({ code: "partner_skill_ref_invalid" }));
      expect(() => scanner.validateRefs("pi-core", ["claude-code/missing"])).toThrow(expect.objectContaining({ code: "partner_skill_not_found" }));
      expect(() => scanner.validateRefs("codex", ["claude-code/one"])).toThrow(expect.objectContaining({ code: "partner_skill_not_found" }));
      expect(() => scanner.resolveForPi(["claude-code/one", "claude-code/two"])).toThrow(expect.objectContaining({ code: "partner_skill_collision" }));
    });
  });
});
