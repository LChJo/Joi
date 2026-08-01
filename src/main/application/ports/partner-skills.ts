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

/** Read-only catalog of locally installed skills, scanned per engine. */
export interface PartnerSkillCatalog {
  listForEngine(engine: PartnerEngine): PartnerSkillOption[];
  /** Concatenates the selected skills' instructions for system-prompt injection. */
  readInstructions(refs: readonly string[]): string;
}
