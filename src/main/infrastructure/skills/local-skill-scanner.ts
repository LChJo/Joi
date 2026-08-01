import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PartnerEngine } from "../../domain/partners/partner.js";
import type { PartnerSkillCatalog, PartnerSkillOption } from "../../application/ports/partner-skills.js";

type SkillSource = "agents" | "claude-code" | "codex";

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
  "pi-core": ["claude-code"],
};

const PER_SKILL_CHARS = 6000;
const TOTAL_CHARS = 16000;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseDisplayName(content: string, folderName: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (frontmatter !== null) {
    const body = frontmatter[1];
    if (typeof body === "string") {
      const display = /^\s*display_name\s*:\s*(.+?)\s*$/mu.exec(body);
      const value = display?.[1];
      if (typeof value === "string" && value !== "") return stripQuotes(value);
    }
  }
  const titleRe = /^#\s+(.+)$/u;
  const title = content.split(/\r?\n/u).map((line) => titleRe.exec(line)?.[1]?.trim()).find((line): line is string => Boolean(line));
  return title ?? folderName;
}

function parseRef(ref: string): { name: string; source: SkillSource } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const source = ref.slice(0, slash) as SkillSource;
  const name = ref.slice(slash + 1);
  if (!SOURCE_KEYS.has(source) || name === "" || name.includes("/") || name.includes("..")) return null;
  return { name, source };
}

function scanSource(source: SkillSource): PartnerSkillOption[] {
  const dir = sourceDir(source);
  if (!existsSync(dir)) return [];
  const options: PartnerSkillOption[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillMd = join(entryPath, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let displayName = entry;
    try {
      displayName = parseDisplayName(readFileSync(skillMd, "utf8"), entry);
    } catch {
      /* unreadable skill file: keep the folder name */
    }
    options.push({ displayName, id: `${source}/${entry}` });
  }
  return options;
}

export class LocalSkillScanner implements PartnerSkillCatalog {
  listForEngine(engine: PartnerEngine): PartnerSkillOption[] {
    const seen = new Set<string>();
    const options: PartnerSkillOption[] = [];
    for (const source of ENGINE_SOURCES[engine]) {
      for (const option of scanSource(source)) {
        if (seen.has(option.id)) continue;
        seen.add(option.id);
        options.push(option);
      }
    }
    return options.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  readInstructions(refs: readonly string[]): string {
    const sections: string[] = [];
    let total = 0;
    for (const ref of refs) {
      if (total >= TOTAL_CHARS) break;
      const parsed = parseRef(ref);
      if (parsed === null) continue;
      const skillMd = join(sourceDir(parsed.source), parsed.name, "SKILL.md");
      let body: string;
      try {
        body = readFileSync(skillMd, "utf8");
      } catch {
        continue;
      }
      const budget = Math.min(PER_SKILL_CHARS, TOTAL_CHARS - total);
      if (budget <= 200) break;
      const truncated = body.length > budget ? `${body.slice(0, budget)}\n[joi: skill truncated]` : body;
      sections.push(`## Skill: ${parsed.name}\n${truncated}`);
      total += truncated.length;
    }
    return sections.length === 0 ? "" : `# Selected skills\n${sections.join("\n\n")}`;
  }
}
