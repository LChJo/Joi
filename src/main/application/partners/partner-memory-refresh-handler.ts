import { OutboxDispatcher, type OutboxHandler } from "../operations/outbox-dispatcher.js";
import type { Clock, RuntimeStore } from "../ports/runtime-store.js";
import type { RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import { PARTNER_MEMORY_REFRESH_KIND } from "../ports/partner-memory.js";
import type { PartnerWorkMemoryService } from "./partner-work-memory-service.js";

export function createPartnerMemoryRefreshHandler(service: Pick<PartnerWorkMemoryService, "refreshSummary">): OutboxHandler {
  return async (record) => {
    const { workbenchId, partnerId, throughSequence } = record.payload;
    if (record.kind !== PARTNER_MEMORY_REFRESH_KIND || typeof workbenchId !== "string" || workbenchId.length === 0
      || typeof partnerId !== "string" || partnerId.length === 0 || typeof throughSequence !== "number"
      || !Number.isSafeInteger(throughSequence) || throughSequence < 1) throw new Error("partner_memory_refresh_payload_invalid");
    await service.refreshSummary({ workbenchId, partnerId, throughSequence });
  };
}

/** Memory inference uses the existing durable dispatcher without joining the root tick's await chain. */
export function createPartnerMemoryRefreshDispatcher(input: {
  clock: Clock; store: RuntimeStore; memory: Pick<PartnerWorkMemoryService, "refreshSummary">;
  owner: string; canStart: () => boolean; diagnostics?: RuntimeDiagnostics; onBackgroundError?: (error: unknown) => void;
}): OutboxDispatcher {
  return new OutboxDispatcher({ clock: input.clock, store: input.store, owner: input.owner, canStart: input.canStart,
    includeKinds: [PARTNER_MEMORY_REFRESH_KIND], handlers: { [PARTNER_MEMORY_REFRESH_KIND]: createPartnerMemoryRefreshHandler(input.memory) },
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    ...(input.onBackgroundError === undefined ? {} : { onBackgroundError: input.onBackgroundError }),
  });
}
