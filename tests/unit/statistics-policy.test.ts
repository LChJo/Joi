import { aggregateStatistics, validateStatisticsQuery, validateTokenUsage } from "../../src/main/domain/statistics/statistics";
import type { StatisticsSnapshot, UsageRecord } from "../../src/main/application/ports/usage";
import type { StatisticsQuery } from "../../src/shared/statistics";

const query: StatisticsQuery = { from: "2026-09-21", to: "2026-09-22", timeZone: "Asia/Shanghai" };
const record = (id: string, overrides: { [K in keyof UsageRecord]?: UsageRecord[K] | undefined } = {}): UsageRecord => Object.fromEntries(Object.entries({ id, invocationId: id, at: "2026-09-21T16:30:00.000Z", status: "completed", engine: "pi", purpose: "partner", workbenchId: "a", goalId: "g", modelId: "model", sourceName: "Source", sourceId: "source", tokens: { input: 100, output: 30, cacheRead: 70, cacheWrite: 10, reasoning: 20 }, ...overrides }).filter(([, v]) => v !== undefined)) as unknown as UsageRecord;
const snapshot = (records: UsageRecord[]): StatisticsSnapshot => ({ records, collectedSince: "2026-09-20T00:00:00.000Z", workbenches: [{ workbenchId: "a", name: "工作台 A", archived: false }, { workbenchId: "b", name: "工作台 B", archived: true }], goals: [{ goalId: "g", workbenchId: "a", title: "目标", status: "completed", completedAt: "2026-09-22T00:00:00.000Z" }] });
describe("statistics numeric rules", () => {
  it("never adds cached input or reasoning output twice and conserves every grouping", () => {
    const result = aggregateStatistics(snapshot([record("1"), record("2", { tokens: null, status: "failed", workbenchId: "b" }), record("3", { workbenchId: undefined, goalId: undefined, purpose: "probe" })]), query, "2026-09-22T10:00:00Z", false);
    expect(result.overview).toMatchObject({ total: 260, input: 200, output: 60, records: 3, knownRecords: 2, unknownRecords: 1, failedRecords: 1, completedGoals: 1 });
    for (const rows of [result.daily, result.hourly, result.models, result.workbenches, result.purposes]) expect(rows.reduce((n, row) => n + row.total, 0)).toBe(260);
    expect(result.daily.map((row) => row.total)).toEqual([0, 260]);
    expect(result.hourly.find((row) => row.weekday === 1 && row.hour === 0)?.total).toBe(260);
    expect(result.goals).toHaveLength(1);
    expect(result.workbenches.find((row) => row.workbenchId === "b")?.archived).toBe(true);
  });
  it("applies all filters without removing available filter choices", () => {
    const facts = snapshot([record("1"), record("2", { modelId: "other", workbenchId: "b", tokens: null, purpose: "evolution" })]);
    const initial = aggregateStatistics(facts, query, "now", false);
    const modelKey = initial.models[0]?.modelKey; assert(modelKey);
    const result = aggregateStatistics(facts, { ...query, modelKey, workbenchId: "a", purpose: "partner" }, "now", true);
    expect(result.overview.total).toBe(130);
    expect(result.filters.models).toHaveLength(2);
    expect(result.collectionDegraded).toBe(true);
    expect(aggregateStatistics(facts, { ...query, workbenchId: "unassigned" }, "now", false).overview.total).toBe(0);
  });
  it("handles DST repeated hours, range edges and unknown usage without fake token counts", () => {
    const facts = snapshot([record("1", { at: "2026-11-01T05:30:00Z" }), record("2", { at: "2026-11-01T06:30:00Z" }), record("3", { at: "2026-11-02T05:00:00Z" })]);
    const result = aggregateStatistics(facts, { from: "2026-11-01", to: "2026-11-01", timeZone: "America/New_York" }, "now", false);
    expect(result.overview.total).toBe(260);
    expect(result.hourly.find((r) => r.weekday === 6 && r.hour === 1)?.total).toBe(260);
    expect(result.overview.completedGoals).toBe(0);
  });
  it.each([{ from: "2026-02-30" }, { to: "2026-09-20" }, { from: "2020-01-01" }, { timeZone: "not-a-zone" }, { from: "garbage" }, { purpose: "invalid" }])("rejects invalid or unbounded queries: %j", (overrides) => {
    expect(() => validateStatisticsQuery({ ...query, ...overrides })).toThrow();
  });
  it("accepts a leap year of 366 days and validates subsets", () => {
    expect(validateStatisticsQuery({ from: "2024-01-01", to: "2024-12-31", timeZone: "UTC" }).from).toBe("2024-01-01");
    expect(validateTokenUsage({ input: 10, output: 5, cacheRead: 8, cacheWrite: 2, reasoning: 4 })).not.toBeNull();
    for (const tokens of [null, {}, { input: -1, output: 1 }, { input: 1, output: Infinity }, { input: 10, output: 2, cacheRead: 11, cacheWrite: 0, reasoning: null }, { input: 10, output: 2, cacheRead: null, cacheWrite: null, reasoning: 3 }]) expect(validateTokenUsage(tokens)).toBeNull();
  });
  it("ranks the top ten, preserves absent model/workbench identities and excludes unrelated goal counts", () => {
    const records = Array.from({ length: 12 }, (_, i) => record(String(i), { goalId: `g${String(i)}`, workbenchId: "gone", modelId: undefined, sourceId: undefined, sourceName: undefined, tokens: { input: i, output: 0, cacheRead: null, cacheWrite: null, reasoning: null } }));
    const result = aggregateStatistics(snapshot(records), { ...query, purpose: "partner" }, "now", false);
    expect(result.goals).toHaveLength(10);
    expect(result.goals[0]).toMatchObject({ goalId: "g11", title: "已归档目标" });
    expect(result.models[0]?.modelId).toBe("未报告模型");
    expect(result.workbenches[0]?.archived).toBe(true);
    expect(result.overview.completedGoals).toBe(0);
    expect(result.overview.cacheKnownRecords).toBe(0);
    expect(result.overview.reasoningKnownRecords).toBe(0);
  });
  it.each([{ workbenchId: "" }, { modelKey: 1 }, { timeZone: 1 }, { workbenchId: "x".repeat(1001) }])("rejects malformed selectors: %j", (extra) => {
    expect(() => validateStatisticsQuery({ ...query, ...extra })).toThrow();
  });
});
