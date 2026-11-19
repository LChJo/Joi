import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels,fauxAssistantMessage,fauxProvider } from "@earendil-works/pi-ai";
import { PiHistoricalMemoryOrganizer } from "../../src/main/infrastructure/pi/pi-historical-memory-organizer.js";
import { PiNativeSessionStore } from "../../src/main/infrastructure/pi/pi-native-session-store.js";
import type { HistoricalMemoryUpdate } from "../../src/main/application/ports/historical-memory.js";

it("HIST-03/04 derives reusable partner experience with the Work's pin and no project bodies", async () => {
  const root = await mkdtemp(join(tmpdir(),"joi-history-organizer-"));
  try {
    const nativeSessions = new PiNativeSessionStore(root);
    const native = await nativeSessions.open({ identity: ["partner","wb","p","local_pi_ephemeral:a","work"],cwd: root });
    const pin = { sourceId: "p-source",sourceRevisionId: "sr",modelRevisionId: "mr",modelId: "m" };
    native.manager.appendCustomEntry("joi.usage_context",{ ...pin,actionId: "a" });
    native.manager.appendMessage({ role: "toolResult",toolCallId: "call",toolName: "read",content: [{ type: "text",text: "PRIVATE_SOURCE_BODY" }],isError: false,timestamp: 1 });
    native.manager.appendCustomEntry("joi.usage_idle",{});
    const faux = fauxProvider({ provider: "memory-organizer" }), models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([context => {
      expect(JSON.stringify(context)).not.toContain("PRIVATE_SOURCE_BODY");
      expect(JSON.stringify(context)).not.toContain("PRIOR_EXPERIENCE");
      expect(JSON.stringify(context)).toContain("toolOutcomes");
      return fauxAssistantMessage(JSON.stringify([
        { section: "verification",text: "Recheck the results of read-only verification before reporting completion." },
        { section: "verification",text: "See C:\\private\\report for the project's result." },
      ]));
    },context => {
      const request = JSON.stringify(context);
      expect(request).toContain("PRIOR_EXPERIENCE");
      expect(request).not.toContain("PRIVATE_SOURCE_BODY");
      expect(request).not.toContain("toolOutcomes");
      return fauxAssistantMessage(JSON.stringify([
        { index: 0,text: "Verify results." },{ index: 7,text: "Unknown entry" },
      ]));
    }]);
    const resolve = vi.fn(() => Promise.resolve({ model: faux.getModel(),models,thinkingLevel: "off" as const }));
    const selectInitial = vi.fn(() => Promise.reject(new Error("No main model should be selected")));
    const organizer = new PiHistoricalMemoryOrganizer({ nativeSessions,resolver: { resolve },sources: { selectInitial },
      usage: { begin: () => ({ id: "summary",record: () => undefined,finish: () => undefined }) },
    });
    const update: HistoricalMemoryUpdate = { scope: "partner",ownerId: "p",workbenchId: "wb",sourceId: "source",revision: 1,
      entries: [{ section: "verification",text: "PRIOR_EXPERIENCE",source: "old" }],facts: { verification: "PASSED" },
      partner: { revisionId: "revision",instanceId: "instance",workId: "work",actionId: "a" } };
    await expect(organizer.organize(update,new AbortController().signal)).resolves.toEqual([
      { section: "verification",text: "Recheck the results of read-only verification before reporting completion." },
    ]);
    await expect(organizer.compact(update,update.entries,new AbortController().signal)).resolves.toEqual(new Map([[0,"Verify results."]]));
    expect(resolve).toHaveBeenCalledWith(pin);
    expect(selectInitial).not.toHaveBeenCalled();
  } finally { await rm(root,{ recursive: true,force: true }); }
});
