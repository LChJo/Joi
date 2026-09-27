import { BACKGROUND_CONTEXT, generateSummary, type AgentMessage } from "@earendil-works/pi-agent-core";

import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { PartnerMemorySummarizer, PartnerWorkMemoryEntry } from "../../application/ports/partner-memory.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import { trackPiModels } from "./pi-usage.js";

/**
 * Rolls the partner work ledger into a bounded summary using the global joi model
 * sources. Any provider failure returns null so the application layer can fall back
 * to a deterministic summary; memory refresh must never break result recording.
 */
export class PiPartnerMemorySummarizer implements PartnerMemorySummarizer {
  constructor(private readonly dependencies: {
    usage?: UsageRecorder;
    resolver: PiConfiguredModelResolver;
    sources: Pick<ReasoningSourceSelector, "selectInitial">;
  }) {}

  async summarize(input: { workbenchId: string; entries: PartnerWorkMemoryEntry[]; partnerId: string; previousSummary?: string }): Promise<string | null> {
    try {
      const pin = await this.dependencies.sources.selectInitial(`partner_memory:${input.workbenchId}:${input.partnerId}`);
      const resolved = await this.dependencies.resolver.resolve(pin);
      const ledger = input.entries
        .map((entry) => `- [${entry.outcome}] ${entry.title} (source: ${entry.sessionDataSource}, at: ${entry.createdAt})`)
        .join("\n");
      const messages: AgentMessage[] = [{ content: ledger, role: "user", timestamp: Date.now() }];
      const generated = await generateSummary(
        messages,
        trackPiModels(resolved.models, this.dependencies.usage, () => ({ engine: "pi", purpose: "summary", workbenchId: input.workbenchId, partnerId: input.partnerId, sourceId: pin.sourceId, modelId: pin.modelId })),
        resolved.model,
        512,
        "Summarize what this partner has worked on and how reliably it completed work. Do not invent facts.",
        input.previousSummary,
        undefined,
        undefined,
        undefined,
        // A memory refresh runs outside any user turn and has no cancellation of its own.
        BACKGROUND_CONTEXT,
      );
      return generated.ok ? generated.value : null;
    } catch {
      return null;
    }
  }
}
