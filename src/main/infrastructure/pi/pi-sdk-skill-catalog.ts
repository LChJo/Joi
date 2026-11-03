import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  formatSkillsForPrompt,
  loadSkills,
  loadSkillsFromDir,
  parseFrontmatter,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import type { PartnerEngine } from "../../domain/partners/partner.js";
import type {
  PartnerPiSkillDispatch,
  PartnerSkillCatalog,
  PartnerSkillOption,
} from "../../application/ports/partner-skills.js";
import { DomainError } from "../../domain/errors.js";

type SkillSource = "agents" | "claude-code" | "codex";

interface ScannedSkill {
  environmentKeys: readonly string[] | null;
  option: PartnerSkillOption;
  skill: Skill;
  source: SkillSource;
}

const SOURCE_KEYS = new Set<SkillSource>(["agents", "claude-code", "codex"]);

function sourceDir(source: SkillSource): string {
  const envVar = source === "claude-code" ? "JOI_CLAUDE_SKILLS_DIR" : source === "codex" ? "JOI_CODEX_SKILLS_DIR" : "JOI_AGENTS_SKILLS_DIR";
  const fallback = source === "claude-code" ? join(homedir(), ".claude", "skills") : source === "codex" ? join(homedir(), ".codex", "skills") : join(homedir(), ".agents", "skills");
  const override = process.env[envVar]?.trim();
  return override === undefined || override === "" ? fallback : override;
}

const ENGINE_SOURCES: Record<PartnerEngine, readonly SkillSource[]> = {
  "claude-code": ["claude-code"],
  codex: ["agents", "codex"],
  "pi-core": ["agents", "claude-code", "codex"],
};

const PER_SKILL_CHARS = 6000;
const TOTAL_CHARS = 16000;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function parseRequiredEnvironment(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (entries === null || entries.some((entry) => typeof entry !== "string")) return null;
  const normalized = entries.map((entry) => (entry as string).trim().toUpperCase());
  if (normalized.some((entry) => !ENVIRONMENT_NAME.test(entry))) return null;
  return [...new Set(normalized)];
}

function parseRef(ref: string): { relativeDir: string; source: SkillSource } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || ref.includes("\\")) return null;
  const source = ref.slice(0, slash) as SkillSource;
  const relativeDir = ref.slice(slash + 1);
  const segments = relativeDir.split("/");
  if (!SOURCE_KEYS.has(source) || isAbsolute(relativeDir)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return { relativeDir, source };
}

function within(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

function toPortablePath(value: string): string {
  return value.split(sep).join("/");
}

function scanSource(source: SkillSource): ScannedSkill[] {
  const configuredRoot = sourceDir(source);
  if (!existsSync(configuredRoot)) return [];
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(configuredRoot);
  } catch {
    return [];
  }
  const loaded = loadSkillsFromDir({ dir: configuredRoot, source });
  const scanned: ScannedSkill[] = [];
  for (const skill of loaded.skills) {
    if (basename(skill.filePath).toLocaleLowerCase() !== "skill.md") continue;
    let canonicalBase: string;
    let modifiedAt: number;
    try {
      canonicalBase = realpathSync(skill.baseDir);
      if (!within(canonicalRoot, canonicalBase)) continue;
      modifiedAt = statSync(canonicalBase).mtimeMs;
    } catch {
      continue;
    }
    const relativeDir = toPortablePath(relative(canonicalRoot, canonicalBase));
    if (relativeDir === "" || relativeDir.split("/").some((part) => part === "" || part === "." || part === "..")) continue;
    let displayName = skill.name;
    let environmentKeys: readonly string[] | null;
    try {
      const parsed = parseFrontmatter<{ display_name?: unknown; metadata?: unknown }>(readFileSync(skill.filePath, "utf8"));
      if (typeof parsed.frontmatter.display_name === "string" && parsed.frontmatter.display_name.trim() !== "") {
        displayName = parsed.frontmatter.display_name.trim();
      }
      const metadata = parsed.frontmatter.metadata;
      const requiredEnvironment = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).joi_required_env
        : undefined;
      environmentKeys = parseRequiredEnvironment(requiredEnvironment);
    } catch {
      // The SDK validated canonical fields, but invalid JOI extension metadata must fail closed when selected.
      environmentKeys = null;
    }
    scanned.push({
      environmentKeys,
      option: {
        description: skill.description,
        displayName,
        id: `${source}/${relativeDir}`,
        modifiedAt,
      },
      skill: { ...skill, baseDir: canonicalBase, filePath: realpathSync(skill.filePath) },
      source,
    });
  }
  return scanned;
}

function collisionKey(skill: ScannedSkill): string {
  return skill.skill.name.toLocaleLowerCase();
}

export class PiSdkSkillCatalog implements PartnerSkillCatalog {
  listForEngine(engine: PartnerEngine): PartnerSkillOption[] {
    const seenNames = new Set<string>();
    const options: PartnerSkillOption[] = [];
    for (const source of ENGINE_SOURCES[engine]) {
      for (const candidate of scanSource(source)) {
        const nameKey = collisionKey(candidate);
        if (seenNames.has(nameKey)) continue;
        seenNames.add(nameKey);
        options.push(candidate.option);
      }
    }
    return options.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  validateRefs(engine: PartnerEngine, refs: readonly string[]): void {
    this.#resolve(engine, refs);
  }

  resolveForPi(refs: readonly string[]): PartnerPiSkillDispatch {
    if (refs.length === 0) return { environmentKeys: [], promptSection: "", skillCount: 0 };
    const selected = this.#resolve("pi-core", refs);
    const loaded = loadSkills({
      agentDir: sourceDir("agents"),
      cwd: process.cwd(),
      includeDefaults: false,
      skillPaths: selected.map((candidate) => candidate.skill.filePath),
    });
    if (loaded.skills.length !== selected.length) {
      throw new DomainError("partner_skill_load_failed", "Selected partner Skills could not be loaded.");
    }
    const selectedNames = new Set(selected.map((candidate) => candidate.skill.name.toLocaleLowerCase()));
    if (loaded.skills.some((skill) => !selectedNames.has(skill.name.toLocaleLowerCase()))) {
      throw new DomainError("partner_skill_load_failed", "Selected partner Skills could not be loaded.");
    }
    return {
      environmentKeys: [...new Set(selected.flatMap((candidate) => candidate.environmentKeys ?? []))],
      promptSection: formatSkillsForPrompt(loaded.skills),
      skillCount: loaded.skills.length,
    };
  }

  readInstructions(refs: readonly string[]): string {
    const selected = this.#resolve(undefined, refs);
    const sections: string[] = [];
    let total = 0;
    for (const candidate of selected) {
      let body: string;
      try {
        body = readFileSync(candidate.skill.filePath, "utf8");
      } catch {
        throw new DomainError("partner_skill_not_found", "Selected partner skill is not available.");
      }
      const budget = Math.min(PER_SKILL_CHARS, TOTAL_CHARS - total);
      if (budget <= 200) continue;
      const truncated = body.length > budget ? `${body.slice(0, budget)}\n[joi: skill truncated]` : body;
      sections.push(`## Skill: ${candidate.skill.name}\n${truncated}`);
      total += truncated.length;
    }
    return sections.length === 0 ? "" : `# Selected skills\n${sections.join("\n\n")}`;
  }

  #resolve(engine: PartnerEngine | undefined, refs: readonly string[]): ScannedSkill[] {
    const resolved: ScannedSkill[] = [];
    const seenNames = new Set<string>();
    for (const ref of refs) {
      const parsed = parseRef(ref);
      if (parsed === null) throw new DomainError("partner_skill_ref_invalid", "Partner skill reference is invalid.");
      if (engine !== undefined && !ENGINE_SOURCES[engine].includes(parsed.source)) {
        throw new DomainError("partner_skill_not_found", "Selected partner skill is not available for this engine.");
      }
      const candidate = scanSource(parsed.source).find((item) => item.option.id === ref);
      if (candidate === undefined) throw new DomainError("partner_skill_not_found", "Selected partner skill is not available.");
      if (candidate.environmentKeys === null) {
        throw new DomainError("partner_skill_environment_invalid", "Selected partner Skill has invalid environment requirements.");
      }
      const key = collisionKey(candidate);
      if (seenNames.has(key)) throw new DomainError("partner_skill_collision", "Selected partner Skills contain duplicate names.");
      seenNames.add(key);
      resolved.push(candidate);
    }
    return resolved;
  }
}
