/* Deterministic async ports isolate the background model from external services. */
/* eslint-disable @typescript-eslint/require-await */
import { createPartnerMemoryRefreshDispatcher } from "../../src/main/application/partners/partner-memory-refresh-handler.js";
import { PartnerWorkMemoryService } from "../../src/main/application/partners/partner-work-memory-service.js";
import { PARTNER_MEMORY_REFRESH_KIND } from "../../src/main/application/ports/partner-memory.js";
import { OutboxDispatcher } from "../../src/main/application/operations/outbox-dispatcher.js";
import { SqlitePartnerWorkMemoryStore } from "../../src/main/infrastructure/persistence/sqlite-partner-work-memory-store.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

it("lets foreground delivery advance while one durable memory refresh waits on its model", async () => {
  const fixture = await createRuntimeFixture();
  const workbench = await fixture.workbenchRegistry.create({ name: "Memory", personaSummary: "fixture", projectLabel: "fixture", scopeSummary: "fixture" });
  const partner = await fixture.partners.add({ capabilities: [], displayName: "Partner", kind: "local-pi", skills: [], tools: [] });
  let release: ((value: string) => void) | undefined;
  let modelCalls = 0;
  let busy = true;
  const memory = new PartnerWorkMemoryService({ clock: fixture.clock, ids: fixture.ids, store: new SqlitePartnerWorkMemoryStore(fixture.database),
    summarizer: { summarize: async () => { modelCalls++; return await new Promise<string>(resolve => { release = resolve; }); } } });
  const background = createPartnerMemoryRefreshDispatcher({ clock: fixture.clock, store: fixture.database.store, memory, owner: "background", canStart: () => !busy });
  const foreground = new OutboxDispatcher({ clock: fixture.clock, store: fixture.database.store, owner: "foreground", excludeKinds: [PARTNER_MEMORY_REFRESH_KIND],
    handlers: { "fixture.foreground": async () => { busy = false; } } });
  try {
    const now = fixture.clock.now().toISOString();
    await memory.recordResult({ at: now, workbenchId: workbench.workbenchId, partnerId: partner.partnerId, resultId: "result", outcome: "COMPLETED", sessionDataSource: "fixture", title: "Work" });
    fixture.database.transaction(db => db.prepare(`INSERT INTO outbox(outbox_id,kind,payload_json,status,attempt_count,available_at,created_at)
      VALUES ('foreground','fixture.foreground','{}','PENDING',0,?,?)`).run(now, now));
    expect(background.startOnce()).toBe(false);
    await foreground.dispatchOnce();
    expect(background.startOnce()).toBe(true);
    await vi.waitFor(() => expect(modelCalls).toBe(1));
    expect(background.startOnce()).toBe(false);
    expect(fixture.database.transaction(db => db.prepare("SELECT status FROM outbox WHERE outbox_id='foreground'").get())?.status).toBe("DONE");
    expect(background.isRunning).toBe(true);
    release?.("Updated memory");
    await background.drain();
    expect(fixture.database.transaction(db => db.prepare("SELECT status FROM outbox WHERE kind=?").get(PARTNER_MEMORY_REFRESH_KIND))?.status).toBe("DONE");
    expect((await memory.digest(workbench.workbenchId, partner.partnerId)).summary).toBe("Updated memory");
  } finally { release?.("shutdown"); await background.close(); await fixture.close(); }
});
