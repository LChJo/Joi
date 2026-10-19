/* In-memory store keeps work-memory tests free of SQLite. */
/* eslint-disable @typescript-eslint/require-await */
import { deterministicPartnerSummary, PARTNER_MEMORY_LIMITS, PartnerWorkMemoryService } from "../../src/main/application/partners/partner-work-memory-service.js";
import type { PartnerWorkMemoryEntry, PartnerWorkMemoryRefresh, PartnerWorkMemoryStore, PartnerWorkMemorySummary } from "../../src/main/application/ports/partner-memory.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

class MemoryWorkMemoryStore implements PartnerWorkMemoryStore {
  readonly entries: PartnerWorkMemoryEntry[] = [];
  summaries = new Map<string, PartnerWorkMemorySummary>();
  readonly receipts = new Set<string>();
  readonly counts = new Map<string, number>();
  readonly pending = new Map<string, PartnerWorkMemoryRefresh[]>();
  async recordResult(entry: PartnerWorkMemoryEntry, options: { entryLimit: number; resultKey: string; summaryCadence: number }) {
    const key = `${entry.workbenchId}:${entry.partnerId}`;
    const receipt = `${key}:${options.resultKey}`;
    if (this.receipts.has(receipt)) return;
    this.receipts.add(receipt);
    this.entries.push(entry);
    const sequence = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, sequence);
    await this.trim(entry.workbenchId, entry.partnerId, options.entryLimit);
    if (sequence === 1 || sequence % options.summaryCadence === 0) {
      const jobs = this.pending.get(key) ?? [];
      const afterSequence = Math.max(jobs.at(-1)?.sequence ?? 0, this.summaries.get(key)?.coveredSequence ?? 0);
      jobs.push({ createdAt: entry.createdAt, entries: (await this.listEntries(entry.workbenchId, entry.partnerId, options.entryLimit)).slice(0, sequence - afterSequence), sequence });
      this.pending.set(key, jobs);
    }
  }
  async loadNextRefresh(workbenchId: string, partnerId: string, throughSequence: number) {
    const key = `${workbenchId}:${partnerId}`;
    return this.pending.get(key)?.find((job) => job.sequence <= throughSequence && job.sequence > (this.summaries.get(key)?.coveredSequence ?? 0)) ?? null;
  }
  async listEntries(workbenchId: string, partnerId: string, limit: number) {
    return this.entries.filter((entry) => entry.workbenchId === workbenchId && entry.partnerId === partnerId).slice(-limit).reverse();
  }
  async loadSummary(workbenchId: string, partnerId: string) { return this.summaries.get(`${workbenchId}:${partnerId}`) ?? null; }
  async outcomeCounts(workbenchId: string, partnerId: string) {
    const scoped = this.entries.filter((entry) => entry.workbenchId === workbenchId && entry.partnerId === partnerId);
    return { completed: scoped.filter((entry) => entry.outcome === "COMPLETED").length, total: scoped.length };
  }
  async saveSummary(input: { workbenchId: string; coveredSequence: number; entryCount: number; partnerId: string; summary: string; updatedAt: string }) {
    this.summaries.set(`${input.workbenchId}:${input.partnerId}`, { coveredSequence: input.coveredSequence, entryCount: input.entryCount, summary: input.summary, updatedAt: input.updatedAt });
  }
  async trim(workbenchId: string, partnerId: string, keep: number) {
    const scoped = this.entries.filter((entry) => entry.workbenchId === workbenchId && entry.partnerId === partnerId);
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
  it("aborts background inference on emergency stop without advancing or discarding durable coverage", async () => {
    const store = new MemoryWorkMemoryStore();
    let signal: AbortSignal | undefined;
    const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store,
      summarizer: { summarize: async input => { signal = input.signal; return await new Promise<null>(resolve => {
        input.signal?.addEventListener("abort", () => { resolve(null); }, { once: true });
      }); } } });
    await service.recordResult({ at: "2026-10-19T00:00:00Z", workbenchId: "workbench", partnerId: "partner",
      outcome: "COMPLETED", sessionDataSource: "run", title: "Work" });
    const refreshing = service.refreshSummary({ workbenchId: "workbench", partnerId: "partner", throughSequence: 1 });
    await vi.waitFor(() => expect(signal).toBeDefined());
    service.emergencyStop();
    await expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
    expect(store.summaries.size).toBe(0);
    expect(store.pending.get("workbench:partner")).toHaveLength(1);
    await expect(service.refreshSummary({ workbenchId: "workbench", partnerId: "partner", throughSequence: 1 })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("uses cumulative cadence after the bounded ledger reaches 32 entries", async () => {
    const store = new MemoryWorkMemoryStore();
    let calls = 0;
    const events: { event: string; fields: unknown }[] = [];
    const service = new PartnerWorkMemoryService({
      clock: new TestClock(), ids: new TestIds(), store,
      diagnostics: { emit: (event: string, fields: unknown) => { events.push({ event, fields }); } },
      summarizer: { summarize: async () => { calls += 1; return "PRIVATE_MEMORY_TEXT"; } },
    });
    for (let index = 1; index <= 40; index += 1) {
      await service.recordResult({ at: "2026-07-29T10:00:00.000Z", workbenchId: "workbench_1", partnerId: "partner_cadence", outcome: "COMPLETED", sessionDataSource: `local_pi:${String(index)}`, title: entryTitle(index) });
    }
    expect(calls).toBe(0);
    expect(store.pending.get("workbench_1:partner_cadence")?.map((job) => job.sequence)).toEqual([1, 8, 16, 24, 32, 40]);
    expect(store.pending.get("workbench_1:partner_cadence")?.map((job) => job.entries.length)).toEqual([1, 7, 8, 8, 8, 8]);
    await service.refreshSummary({ workbenchId: "workbench_1", partnerId: "partner_cadence", throughSequence: 40 });
    expect(calls).toBe(6);
    expect(events.filter(event => event.event === "joi.partner.memory_refreshed").map(event => (event.fields as { coveredSequence: number }).coveredSequence)).toEqual([1, 8, 16, 24, 32, 40]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_MEMORY_TEXT");
  });
  it("records ground-truth outcomes, trims to the entry limit and summarizes on cadence", async () => {
    const store = new MemoryWorkMemoryStore();
    const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store });

    for (let index = 0; index < PARTNER_MEMORY_LIMITS.entryLimit + 3; index += 1) {
      await service.recordResult({
        at: `2026-07-29T10:${String(index).padStart(2, "0")}:00.000Z`,
        workbenchId: "workbench_1",
        outcome: index % 4 === 3 ? "FAILED" : "COMPLETED",
        partnerId: "partner_1",
        sessionDataSource: `local_pi:action_${String(index)}`,
        title: entryTitle(index),
      });
    }
    expect(store.entries).toHaveLength(PARTNER_MEMORY_LIMITS.entryLimit);
    await service.refreshSummary({ workbenchId: "workbench_1", partnerId: "partner_1", throughSequence: 35 });

    const summaryRow = store.summaries.get("workbench_1:partner_1");
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
    await withModel.recordResult({ at: "2026-07-29T10:00:00.000Z", workbenchId: "workbench_1", outcome: "COMPLETED", partnerId: "partner_m", sessionDataSource: "local_pi:a1", title: "t1" });
    await withModel.refreshSummary({ workbenchId: "workbench_1", partnerId: "partner_m", throughSequence: 1 });
    expect(store.summaries.get("workbench_1:partner_m")?.summary).toBe("MODEL_SUMMARY");

    const store2 = new MemoryWorkMemoryStore();
    const withNull = new PartnerWorkMemoryService({
      clock: new TestClock(),
      ids: new TestIds(),
      store: store2,
      summarizer: { summarize: async () => null },
    });
    await withNull.recordResult({ at: "2026-07-29T10:00:00.000Z", workbenchId: "workbench_1", outcome: "FAILED", partnerId: "partner_n", sessionDataSource: "local_pi:a2", title: "t2" });
    await withNull.refreshSummary({ workbenchId: "workbench_1", partnerId: "partner_n", throughSequence: 1 });
    expect(store2.summaries.get("workbench_1:partner_n")?.summary).toBe(deterministicPartnerSummary(store2.entries));
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
        workbenchId: "workbench_1",
        outcome: "COMPLETED",
        partnerId: "partner_c",
        sessionDataSource: `local_pi:c${String(index)}`,
        title: `c${String(index)}`,
      });
    }
    await service.refreshSummary({ workbenchId: "workbench_1", partnerId: "partner_c", throughSequence: 8 });
    expect(seenPrevious).toHaveLength(2);
    expect(seenPrevious[0]).toBeUndefined();
    expect(seenPrevious[1]).toBe("SUMMARY_1");
    expect(store.summaries.get("workbench_1:partner_c")?.summary).toBe("SUMMARY_2");
  });

  it("serves bounded digests with success rate, recent three and summary", async () => {
    const store = new MemoryWorkMemoryStore();
    const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store });
    const outcomes = ["COMPLETED", "COMPLETED", "FAILED", "COMPLETED"] as const;
    for (const [index, outcome] of outcomes.entries()) {
      await service.recordResult({
        at: `2026-07-29T10:0${String(index)}:00.000Z`,
        workbenchId: "workbench_1",
        outcome,
        partnerId: "partner_d",
        sessionDataSource: `partner_instance_messages:instance_${String(index)}`,
        title: entryTitle(index),
      });
    }
    const digest = await service.digest("workbench_1", "partner_d");
    expect(digest.successRate).toBe(0.75);
    expect(digest.last3.map((item) => item.title)).toEqual(["task 3", "task 2", "task 1"]);
    expect(digest.summary).toMatch(/completed/u);

    const empty = await service.digest("workbench_1", "partner_missing");
    expect(empty).toMatchObject({ last3: [], successRate: 1 });
  });

  it("exposes the full ledger and summary for the read-only debug view", async () => {
    const store = new MemoryWorkMemoryStore();
    const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store });
    await service.recordResult({ at: "2026-07-29T10:00:00.000Z", workbenchId: "workbench_1", outcome: "COMPLETED", partnerId: "partner_v", sessionDataSource: "a2a_invocations:inv_1", title: "remote task" });
    await service.refreshSummary({ workbenchId: "workbench_1", partnerId: "partner_v", throughSequence: 1 });
    const view = await service.debugView("workbench_1", "partner_v");
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ sessionDataSource: "a2a_invocations:inv_1", title: "remote task" });
    expect(view.summary).toMatch(/completed/u);
  });

  it("deduplicates stable results across service instances and retries only uncommitted snapshots", async () => {
    const store = new MemoryWorkMemoryStore();
    let fail = true;
    let calls = 0;
    const dependencies = { clock: new TestClock(), ids: new TestIds(), store,
      summarizer: { summarize: async () => { calls += 1; if (fail) throw new Error("model_unavailable"); return "recovered"; } } };
    const input = { at: "2026-07-29T10:00:00.000Z", workbenchId: "workbench_1", partnerId: "partner_replay", resultId: "result_1",
      outcome: "COMPLETED" as const, sessionDataSource: "local_pi:one", title: "one" };
    const service = new PartnerWorkMemoryService(dependencies);
    await service.recordResult(input);
    await service.recordResult({ ...input, at: "2026-07-29T10:01:00.000Z" });
    expect(store.entries).toHaveLength(1);
    await expect(service.refreshSummary({ workbenchId: input.workbenchId, partnerId: input.partnerId, throughSequence: 1 })).rejects.toThrow("model_unavailable");
    expect(store.summaries.size).toBe(0);
    fail = false;
    const recovered = new PartnerWorkMemoryService(dependencies);
    await recovered.recordResult(input);
    await recovered.refreshSummary({ workbenchId: input.workbenchId, partnerId: input.partnerId, throughSequence: 1 });
    await recovered.refreshSummary({ workbenchId: input.workbenchId, partnerId: input.partnerId, throughSequence: 1 });
    expect(calls).toBe(2);
    expect(store.entries).toHaveLength(1);
    expect(store.summaries.get("workbench_1:partner_replay")).toMatchObject({ coveredSequence: 1, summary: "recovered" });
  });

  it("serializes overlapping refresh deliveries and treats empty model output as unavailable", async () => {
    const store = new MemoryWorkMemoryStore();
    let calls = 0;
    const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store,
      summarizer: { summarize: async () => { calls += 1; return "  "; } } });
    for (let index = 1; index <= 8; index += 1) {
      await service.recordResult({ at: "2026-07-29T10:00:00.000Z", workbenchId: "workbench_1", partnerId: "partner_overlap", resultId: `r${String(index)}`,
        outcome: "COMPLETED", sessionDataSource: "shared_session", title: entryTitle(index) });
    }
    await Promise.all([service.refreshSummary({ workbenchId: "workbench_1", partnerId: "partner_overlap", throughSequence: 1 }),
      service.refreshSummary({ workbenchId: "workbench_1", partnerId: "partner_overlap", throughSequence: 8 })]);
    expect(calls).toBe(2);
    const recent = await store.listEntries("workbench_1", "partner_overlap", 32);
    expect(store.summaries.get("workbench_1:partner_overlap")).toMatchObject({ coveredSequence: 8, entryCount: 8,
      summary: deterministicPartnerSummary(recent.slice(0, 7), deterministicPartnerSummary(recent.slice(7))) });
  });
});
