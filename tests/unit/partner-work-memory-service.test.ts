/* In-memory store keeps work-memory tests free of SQLite. */
/* eslint-disable @typescript-eslint/require-await */
import { deterministicPartnerSummary, PARTNER_MEMORY_LIMITS, PartnerWorkMemoryService } from "../../src/main/application/partners/partner-work-memory-service.js";
import type { PartnerWorkMemoryEntry, PartnerWorkMemoryStore, PartnerWorkMemorySummary } from "../../src/main/application/ports/partner-memory.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

class MemoryWorkMemoryStore implements PartnerWorkMemoryStore {
  readonly entries: PartnerWorkMemoryEntry[] = [];
  summaries = new Map<string, PartnerWorkMemorySummary>();
  async append(entry: PartnerWorkMemoryEntry) { this.entries.push(entry); }
  async count(avatarId: string, partnerId: string) { return this.entries.filter((entry) => entry.avatarId === avatarId && entry.partnerId === partnerId).length; }
  async listEntries(avatarId: string, partnerId: string, limit: number) {
    return this.entries.filter((entry) => entry.avatarId === avatarId && entry.partnerId === partnerId).slice(-limit).reverse();
  }
  async loadSummary(avatarId: string, partnerId: string) { return this.summaries.get(`${avatarId}:${partnerId}`) ?? null; }
  async outcomeCounts(avatarId: string, partnerId: string) {
    const scoped = this.entries.filter((entry) => entry.avatarId === avatarId && entry.partnerId === partnerId);
    return { completed: scoped.filter((entry) => entry.outcome === "COMPLETED").length, total: scoped.length };
  }
  async saveSummary(input: { avatarId: string; entryCount: number; partnerId: string; summary: string; updatedAt: string }) {
    this.summaries.set(`${input.avatarId}:${input.partnerId}`, { entryCount: input.entryCount, summary: input.summary, updatedAt: input.updatedAt });
  }
  async trim(avatarId: string, partnerId: string, keep: number) {
    const scoped = this.entries.filter((entry) => entry.avatarId === avatarId && entry.partnerId === partnerId);
    const overflow = scoped.length - keep;
    if (overflow <= 0) return;
    const doomed = new Set(scoped.slice(0, overflow).map((entry) => entry.memoryId));
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry !== undefined && doomed.has(entry.memoryId)) this.entries.splice(index, 1);
    }
  }
}

function entryTitle(index: number): string {
  return `task ${String(index)}`;
}

describe("partner-work-memory-service", () => {
  it("records ground-truth outcomes, trims to the entry limit and summarizes on cadence", async () => {
    const store = new MemoryWorkMemoryStore();
    const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store });

    for (let index = 0; index < PARTNER_MEMORY_LIMITS.entryLimit + 3; index += 1) {
      await service.recordResult({
        at: `2026-07-29T10:${String(index).padStart(2, "0")}:00.000Z`,
        avatarId: "avatar_1",
        outcome: index % 4 === 3 ? "FAILED" : "COMPLETED",
        partnerId: "partner_1",
        sessionDataSource: `local_pi:action_${String(index)}`,
        title: entryTitle(index),
      });
    }
    expect(store.entries).toHaveLength(PARTNER_MEMORY_LIMITS.entryLimit);

    const summaryRow = store.summaries.get("avatar_1:partner_1");
    expect(summaryRow).toBeDefined();
    expect(summaryRow?.summary).toMatch(/completed/u);
  });

  it("uses the model summarizer when it returns text and falls back when it returns null", async () => {
    const store = new MemoryWorkMemoryStore();
    const withModel = new PartnerWorkMemoryService({
      clock: new TestClock(),
      ids: new TestIds(),
      store,
      summarizer: { summarize: async () => "MODEL_SUMMARY" },
    });
    await withModel.recordResult({ at: "2026-07-29T10:00:00.000Z", avatarId: "avatar_1", outcome: "COMPLETED", partnerId: "partner_m", sessionDataSource: "local_pi:a1", title: "t1" });
    expect(store.summaries.get("avatar_1:partner_m")?.summary).toBe("MODEL_SUMMARY");

    const store2 = new MemoryWorkMemoryStore();
    const withNull = new PartnerWorkMemoryService({
      clock: new TestClock(),
      ids: new TestIds(),
      store: store2,
      summarizer: { summarize: async () => null },
    });
    await withNull.recordResult({ at: "2026-07-29T10:00:00.000Z", avatarId: "avatar_1", outcome: "FAILED", partnerId: "partner_n", sessionDataSource: "local_pi:a2", title: "t2" });
    expect(store2.summaries.get("avatar_1:partner_n")?.summary).toBe(deterministicPartnerSummary(store2.entries));
  });

  it("feeds the previous summary into cadence refreshes", async () => {
    const store = new MemoryWorkMemoryStore();
    const seenPrevious: (string | undefined)[] = [];
    const service = new PartnerWorkMemoryService({
      clock: new TestClock(),
      ids: new TestIds(),
      store,
      summarizer: {
        summarize: async (input) => {
          seenPrevious.push(input.previousSummary);
          return `SUMMARY_${String(seenPrevious.length)}`;
        },
      },
    });
    for (let index = 0; index < PARTNER_MEMORY_LIMITS.summaryCadence; index += 1) {
      await service.recordResult({
        at: `2026-07-29T10:0${String(index)}:00.000Z`,
        avatarId: "avatar_1",
        outcome: "COMPLETED",
        partnerId: "partner_c",
        sessionDataSource: `local_pi:c${String(index)}`,
        title: `c${String(index)}`,
      });
    }
    expect(seenPrevious).toHaveLength(2);
    expect(seenPrevious[0]).toBeUndefined();
    expect(seenPrevious[1]).toBe("SUMMARY_1");
    expect(store.summaries.get("avatar_1:partner_c")?.summary).toBe("SUMMARY_2");
  });

  it("serves bounded digests with success rate, recent three and summary", async () => {
    const store = new MemoryWorkMemoryStore();
    const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store });
    const outcomes = ["COMPLETED", "COMPLETED", "FAILED", "COMPLETED"] as const;
    for (const [index, outcome] of outcomes.entries()) {
      await service.recordResult({
        at: `2026-07-29T10:0${String(index)}:00.000Z`,
        avatarId: "avatar_1",
        outcome,
        partnerId: "partner_d",
        sessionDataSource: `partner_instance_messages:instance_${String(index)}`,
        title: entryTitle(index),
      });
    }
    const digest = await service.digest("avatar_1", "partner_d");
    expect(digest.successRate).toBe(0.75);
    expect(digest.last3.map((item) => item.title)).toEqual(["task 3", "task 2", "task 1"]);
    expect(digest.summary).toMatch(/completed/u);

    const empty = await service.digest("avatar_1", "partner_missing");
    expect(empty).toMatchObject({ last3: [], successRate: 1 });
  });

  it("exposes the full ledger and summary for the read-only debug view", async () => {
    const store = new MemoryWorkMemoryStore();
    const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store });
    await service.recordResult({ at: "2026-07-29T10:00:00.000Z", avatarId: "avatar_1", outcome: "COMPLETED", partnerId: "partner_v", sessionDataSource: "a2a_invocations:inv_1", title: "remote task" });
    const view = await service.debugView("avatar_1", "partner_v");
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ sessionDataSource: "a2a_invocations:inv_1", title: "remote task" });
    expect(view.summary).toMatch(/completed/u);
  });
});
