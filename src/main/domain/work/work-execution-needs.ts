import { DomainError } from "../errors.js";
import type { PartnerEngine, PartnerRevision } from "../partners/partner.js";
import type { WorkAccessMode } from "./work.js";

export type WorkExecutionNeed = "SHELL" | "FILE_WRITE";
export interface LocalExecutionCapabilities { engine: PartnerEngine; shell: boolean; fileWrites: boolean }

export function localExecutionCapabilities(revision: PartnerRevision): LocalExecutionCapabilities | undefined {
  if (revision.kind !== "local-pi") return undefined;
  const names = revision.tools.map(name => name.toLowerCase());
  const all = (revision.toolPolicyMode ?? (names.length === 0 ? "ALL" : "CUSTOM")) === "ALL";
  return { engine: revision.engine,
    shell: revision.engine === "codex" || all || names.includes("bash"),
    fileWrites: revision.engine === "codex" ? revision.codexPermissions?.sandboxMode !== "read-only" : all || names.some(name => ["bash", "write", "edit", "multiedit", "notebookedit"].includes(name)),
  };
}

/** Missing declarations identify legacy briefs; they never imply permission to write. */
export function readExecutionNeeds(value: unknown): WorkExecutionNeed[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(need => need !== "SHELL" && need !== "FILE_WRITE")) {
    throw new DomainError("work_execution_needs_invalid", "Execution needs must be SHELL or FILE_WRITE.");
  }
  return [...new Set(value)] as WorkExecutionNeed[];
}

export function assertExecutionAccess(access: WorkAccessMode, needs: readonly WorkExecutionNeed[] | undefined, capabilities?: LocalExecutionCapabilities): void {
  if (needs === undefined) return;
  const writes = needs.includes("FILE_WRITE");
  const shell = needs.includes("SHELL");
  const conflict = (writes && (access !== "WRITE" || capabilities?.fileWrites === false))
    || (shell && (access === "NONE" || capabilities?.shell === false || (capabilities?.engine !== "codex" && access !== "WRITE")));
  if (conflict) throw new DomainError("work_execution_access_conflict", "The declared execution needs exceed this Work or partner's permission ceiling.");
}
