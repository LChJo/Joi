import { DomainError } from "../errors.js";
import type { StatisticsSnapshot, UsageRecord } from "./usage-types.js";
import type { StatisticsDto, StatisticsQuery, StatisticsWorkbenchRow, TokenUsage, UsagePurpose, UsageTotals } from "../../../shared/statistics.js";

export const USAGE_PURPOSES: readonly UsagePurpose[] = ["orchestration", "routing", "partner", "evolution", "summary", "probe"];
const DAY = 86_400_000;
const validDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function validateStatisticsQuery(value: Record<string, unknown>): StatisticsQuery {
  const invalid = () => new DomainError("statistics_query_invalid", "Statistics filters are invalid.");
  if (!validDay(value.from) || !validDay(value.to) || value.to < value.from || (Date.parse(value.to) - Date.parse(value.from)) / DAY >= 366) throw invalid();
  if (typeof value.timeZone !== "string" || value.timeZone.length > 100) throw invalid();
  try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format(0); } catch { throw invalid(); }
  if (value.purpose !== undefined && !USAGE_PURPOSES.includes(value.purpose as UsagePurpose)) throw invalid();
  for (const key of ["workbenchId", "modelKey"]) if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 1000)) throw invalid();
  return { from: value.from, to: value.to, timeZone: value.timeZone,
    ...(value.workbenchId === undefined ? {} : { workbenchId: value.workbenchId as string }),
    ...(value.modelKey === undefined ? {} : { modelKey: value.modelKey as string }),
    ...(value.purpose === undefined ? {} : { purpose: value.purpose as UsagePurpose }) };
}
export function validateTokenUsage(value: unknown): TokenUsage | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!count(v.input) || !count(v.output) || !Number.isSafeInteger(v.input + v.output)) return null;
  if ([v.cacheRead, v.cacheWrite, v.reasoning].some((n) => n !== null && !count(n))) return null;
  if ((v.cacheRead as number | null ?? 0) + (v.cacheWrite as number | null ?? 0) > v.input || (v.reasoning as number | null ?? 0) > v.output) return null;
  return { input: v.input, output: v.output, cacheRead: v.cacheRead as number | null, cacheWrite: v.cacheWrite as number | null, reasoning: v.reasoning as number | null };
}
export const emptyUsageTotals = (): UsageTotals => ({ input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cacheKnownRecords: 0, reasoningKnownRecords: 0, records: 0, knownRecords: 0, unknownRecords: 0, failedRecords: 0 });
function add(total: UsageTotals, record: UsageRecord): void {
  total.records++;
  if (record.status === "failed") total.failedRecords++;
  const tokens = validateTokenUsage(record.tokens);
  if (tokens === null) { total.unknownRecords++; return; }
  total.knownRecords++;
  total.input += tokens.input; total.output += tokens.output; total.total += tokens.input + tokens.output;
  total.cacheRead += tokens.cacheRead ?? 0; total.cacheWrite += tokens.cacheWrite ?? 0; total.reasoning += tokens.reasoning ?? 0;
  if (tokens.cacheRead !== null || tokens.cacheWrite !== null) total.cacheKnownRecords++;
  if (tokens.reasoning !== null) total.reasoningKnownRecords++;
}
export function usageModelKey(record: UsageRecord): string {
  return [record.engine, record.sourceId ?? record.engine, record.modelId ?? "unknown"].map(encodeURIComponent).join("|");
}
export function aggregateStatistics(snapshot: StatisticsSnapshot, query: StatisticsQuery, now: string, collectionDegraded: boolean): StatisticsDto {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: query.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const local = (at: string) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
    return { date: `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`, hour: Number(parts.hour) };
  };
  const inRange = (date: string) => date >= query.from && date <= query.to;
  const scoped = snapshot.records.filter((r) => inRange(local(r.at).date));
  const records = scoped.filter((r) => (query.workbenchId === undefined || (r.workbenchId ?? "unassigned") === query.workbenchId)
    && (query.modelKey === undefined || usageModelKey(r) === query.modelKey) && (query.purpose === undefined || r.purpose === query.purpose));
  const options = new Map(scoped.map((r) => [usageModelKey(r), { modelKey: usageModelKey(r), modelId: r.modelId ?? "未报告模型", sourceName: r.sourceName ?? r.engine, engine: r.engine }]));
  const workbenchNames = new Map(snapshot.workbenches.map((w) => [w.workbenchId, w]));
  const workbench = (id: string) => workbenchNames.get(id) ?? { workbenchId: id, name: id === "unassigned" ? "全局 / 未归属" : "已归档工作台", archived: id !== "unassigned" };
  const overview = { ...emptyUsageTotals(), completedGoals: 0 };
  const daily = new Map<string, UsageTotals & { date: string }>();
  for (let at = Date.parse(query.from); at <= Date.parse(query.to); at += DAY) { const date = new Date(at).toISOString().slice(0, 10); daily.set(date, { ...emptyUsageTotals(), date }); }
  const hourly = Array.from({ length: 168 }, (_, i) => ({ ...emptyUsageTotals(), weekday: Math.floor(i / 24), hour: i % 24 }));
  const models = new Map<string, StatisticsDto["models"][number]>();
  const workbenches = new Map<string, StatisticsWorkbenchRow>();
  const purposes = new Map<UsagePurpose, StatisticsDto["purposes"][number]>();
  const goals = new Map<string, StatisticsDto["goals"][number]>();
  const facts = new Map(snapshot.goals.map((g) => [g.goalId, g]));
  const getWorkbench = (id: string) => {
    let row = workbenches.get(id);
    if (row === undefined) { row = { ...emptyUsageTotals(), ...workbench(id), completedGoals: 0, failedGoals: 0, waitingGoals: 0 }; workbenches.set(id, row); }
    return row;
  };
  for (const record of records) {
    const at = local(record.at);
    const day = daily.get(at.date);
    const hour = hourly[((new Date(at.date).getUTCDay() + 6) % 7) * 24 + at.hour];
    add(overview, record);
    if (day !== undefined) add(day, record);
    if (hour !== undefined) add(hour, record);
    const modelKey = usageModelKey(record);
    let model = models.get(modelKey);
    if (model === undefined) { model = { ...emptyUsageTotals(), modelKey, modelId: record.modelId ?? "未报告模型", sourceName: record.sourceName ?? record.engine, engine: record.engine }; models.set(modelKey, model); }
    add(model, record);
    add(getWorkbench(record.workbenchId ?? "unassigned"), record);
    let purpose = purposes.get(record.purpose);
    if (purpose === undefined) { purpose = { ...emptyUsageTotals(), purpose: record.purpose }; purposes.set(record.purpose, purpose); }
    add(purpose, record);
    if (record.goalId !== undefined) {
      let goal = goals.get(record.goalId);
      const fact = facts.get(record.goalId);
      if (goal === undefined) { goal = { ...emptyUsageTotals(), goalId: record.goalId, title: fact?.title ?? "已归档目标", status: fact?.status ?? "running", workbenchId: record.workbenchId ?? "unassigned", workbenchName: workbench(record.workbenchId ?? "unassigned").name }; goals.set(record.goalId, goal); }
      add(goal, record);
    }
  }
  const seen = new Set<string>();
  for (const fact of snapshot.goals) {
    if (seen.has(fact.goalId) || (query.workbenchId !== undefined && fact.workbenchId !== query.workbenchId)
      || ((query.modelKey !== undefined || query.purpose !== undefined) && !goals.has(fact.goalId))) continue;
    seen.add(fact.goalId);
    if (fact.status === "completed" && fact.completedAt !== null && inRange(local(fact.completedAt).date) && fact.completedAt >= snapshot.collectedSince) { overview.completedGoals++; getWorkbench(fact.workbenchId).completedGoals++; }
    if (goals.has(fact.goalId) && fact.status === "failed") getWorkbench(fact.workbenchId).failedGoals++;
    if (goals.has(fact.goalId) && fact.status === "waiting") getWorkbench(fact.workbenchId).waitingGoals++;
  }
  const byTotal = <T extends UsageTotals>(rows: Iterable<T>): T[] => [...rows].sort((a, b) => b.total - a.total);
  return { query, collectedSince: snapshot.collectedSince, updatedAt: now, collectionDegraded, overview,
    daily: [...daily.values()], hourly, models: byTotal(models.values()), workbenches: byTotal(workbenches.values()), purposes: byTotal(purposes.values()), goals: byTotal(goals.values()).slice(0, 10),
    filters: { models: [...options.values()], workbenches: [...new Map([...snapshot.workbenches, ...scoped.map((r) => workbench(r.workbenchId ?? "unassigned"))].map((w) => [w.workbenchId, w])).values()] } };
}
