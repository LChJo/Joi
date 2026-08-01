import type { PartnerEngine } from "../../domain/partners/partner.js";

export interface PartnerSkillOption {
  displayName: string;
  /** Portable reference `${source}/${name}` so selections survive backup/restore. */
  id: string;
}

/** Read-only catalog of locally installed skills, scanned per engine. */
export interface PartnerSkillCatalog {
  listForEngine(engine: PartnerEngine): PartnerSkillOption[];
  /** Concatenates the selected skills' instructions for system-prompt injection. */
  readInstructions(refs: readonly string[]): string;
}
