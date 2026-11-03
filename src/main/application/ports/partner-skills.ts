import type { PartnerEngine } from "../../domain/partners/partner.js";

export interface PartnerSkillOption {
  /** Optional one-line summary from the skill's frontmatter, used as a scenario blurb. */
  description?: string;
  displayName: string;
  /** Portable reference `${source}/${name}` so selections survive backup/restore. */
  id: string;
  /** Directory mtime (ms) so scenario lists can show the most recent skills first. */
  modifiedAt?: number;
}

/** Pi receives catalog metadata up front and reads the skill files on demand. */
export interface PartnerPiSkillDispatch {
  /** Environment variable names required by the exact selected Skills; never values. */
  environmentKeys: readonly string[];
  promptSection: string;
  skillCount: number;
}

/** Read-only catalog of locally installed skills, scanned per engine. */
export interface PartnerSkillCatalog {
  listForEngine(engine: PartnerEngine): PartnerSkillOption[];
  /** Resolves exact selected Skill paths through the Pi SDK with defaults disabled. */
  resolveForPi(refs: readonly string[]): PartnerPiSkillDispatch;
  /** Concatenates the selected skills' instructions for system-prompt injection. */
  readInstructions(refs: readonly string[]): string;
  /** Fails closed when a persisted reference no longer belongs to the engine catalog. */
  validateRefs(engine: PartnerEngine, refs: readonly string[]): void;
}
