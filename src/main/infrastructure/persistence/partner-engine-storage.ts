import type { PartnerEngine } from "../../domain/partners/partner.js";

/**
 * The legacy engine CHECK columns only allow PI_CORE / MANA_SDK. The Agent SDK
 * driver (MANA_SDK) spawns either Claude Code or Codex; that choice is kept in a
 * separate cli_protocol column so the domain can expose three engines without a
 * SQLite table rebuild. Shared by every table that stores a partner engine.
 */
export function mapStoredEngine(storedEngine: unknown, cliProtocol: unknown): PartnerEngine {
  if (storedEngine === "PI_CORE") return "pi-core";
  return cliProtocol === "CODEX" ? "codex" : "claude-code";
}

export function storageEngine(engine: PartnerEngine): string {
  return engine === "pi-core" ? "PI_CORE" : "MANA_SDK";
}

export function storageCliProtocol(engine: PartnerEngine): string | null {
  if (engine === "pi-core") return null;
  return engine === "codex" ? "CODEX" : "CLAUDE";
}
