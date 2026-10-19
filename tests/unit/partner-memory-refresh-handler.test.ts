/* eslint-disable @typescript-eslint/require-await */
import { createPartnerMemoryRefreshHandler } from "../../src/main/application/partners/partner-memory-refresh-handler.js";
import { PARTNER_MEMORY_REFRESH_KIND } from "../../src/main/application/ports/partner-memory.js";
import type { OutboxRecord } from "../../src/main/application/ports/runtime-store.js";

function record(payload: Record<string, unknown>, kind = PARTNER_MEMORY_REFRESH_KIND): OutboxRecord {
  return { attemptCount: 0, availableAt: "2026-10-19T10:00:00.000Z", createdAt: "2026-10-19T10:00:00.000Z", kind,
    outboxId: "memory_refresh_1", payload, status: "CLAIMED" };
}

describe("partner memory refresh outbox handler", () => {
  it("awaits refresh completion with identifier-only inputs", async () => {
    const seen: unknown[] = [];
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const handler = createPartnerMemoryRefreshHandler({ refreshSummary: async (input) => { seen.push(input); await wait; } });
    let complete = false;
    const delivery = handler(record({ workbenchId: "workbench_1", partnerId: "partner_1", throughSequence: 8 })).then(() => { complete = true; });
    await Promise.resolve();
    expect(seen).toEqual([{ workbenchId: "workbench_1", partnerId: "partner_1", throughSequence: 8 }]);
    expect(complete).toBe(false);
    finish();
    await delivery;
    expect(complete).toBe(true);
  });

  it.each([{}, { workbenchId: "", partnerId: "p", throughSequence: 1 }, { workbenchId: "w", partnerId: "p", throughSequence: 0 },
    { workbenchId: "w", partnerId: "p", throughSequence: 1.5 }, { workbenchId: "w", partnerId: "p", throughSequence: Number.POSITIVE_INFINITY }])("rejects invalid refresh payload %j", async (payload) => {
    const handler = createPartnerMemoryRefreshHandler({ refreshSummary: async () => { throw new Error("must_not_run"); } });
    await expect(handler(record(payload))).rejects.toThrow("partner_memory_refresh_payload_invalid");
  });
});
