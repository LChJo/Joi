import { DomainError } from "../../domain/errors.js";
import type { PartnerEngine } from "../../domain/partners/partner.js";
import type { PartnerEngineRuntime } from "../ports/partner-instances.js";

export interface PartnerEngineStatus {
  available: boolean;
  id: PartnerEngine;
  reason?: string;
  /** Selectable native tool names for the whitelist picker. */
  tools: readonly string[];
}

/** Registry of partner execution engines with health-gated availability. */
export class PartnerEngineCatalog {
  constructor(private readonly engines: Map<string, PartnerEngineRuntime>) {}

  async assertAvailable(engine: PartnerEngine): Promise<void> {
    const runtime = this.engines.get(engine);
    if (runtime === undefined) throw new DomainError("engine_unavailable", "Partner engine is unavailable.");
    const probe = await runtime.health();
    if (!probe.available) {
      throw new DomainError("engine_unavailable", `Partner engine is unavailable${probe.reason === undefined ? "" : `: ${probe.reason}`}.`);
    }
  }

  async list(): Promise<PartnerEngineStatus[]> {
    const statuses: PartnerEngineStatus[] = [];
    for (const [id, runtime] of this.engines.entries()) {
      const probe = await runtime.health();
      statuses.push({ available: probe.available, id: id as PartnerEngine, tools: runtime.toolOptions(), ...(probe.reason === undefined ? {} : { reason: probe.reason }) });
    }
    return statuses;
  }
}
