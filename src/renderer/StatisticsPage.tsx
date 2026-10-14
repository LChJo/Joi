import { ArrowClockwiseIcon, CalendarBlankIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { StatisticsDto, StatisticsQuery, UsageEngine, UsagePurpose, UsageTotals } from "../shared/statistics";
import { ApiError, type DigitalLifeApi } from "./api";
import { Tooltip } from "./Tooltip";

type DatePreset = "today" | "7" | "30" | "90" | "year" | "custom";

const POLL_MS = 15_000;
const PURPOSES: readonly UsagePurpose[] = ["orchestration", "routing", "partner", "evolution", "summary", "probe"];
const PURPOSE_LABELS: Record<UsagePurpose, string> = {
  evolution: "进化", orchestration: "编排", partner: "搭档", probe: "探测", routing: "路由", summary: "总结",
};
const ENGINE_LABELS: Record<UsageEngine, string> = { a2a: "A2A", "claude-code": "Claude Code", codex: "Codex", pi: "pi" };
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const ZERO_TOTALS: UsageTotals = {
  cacheKnownRecords: 0, cacheRead: 0, cacheWrite: 0, failedRecords: 0, input: 0, knownRecords: 0,
  output: 0, reasoning: 0, reasoningKnownRecords: 0, records: 0, total: 0, unknownRecords: 0,
};
/** Height (viewBox units) of the hatched stub drawn for a day/hour whose usage is entirely unknown. */
const UNKNOWN_STUB = 14;

function localDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateRange(preset: Exclude<DatePreset, "custom">, now = new Date()): Pick<StatisticsQuery, "from" | "to"> {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  if (preset === "year") start.setDate(start.getDate() - 364);
  else start.setDate(start.getDate() - (Number(preset === "today" ? 1 : preset) - 1));
  return { from: localDate(start), to: localDate(end) };
}

function inclusiveDays(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function knownValue(value: number, totals: UsageTotals): string {
  return totals.knownRecords === 0 && totals.unknownRecords > 0 ? "未知" : formatNumber(value);
}

function exactValue(value: number, totals: UsageTotals): string {
  return totals.knownRecords === 0 && totals.unknownRecords > 0 ? "未知" : value.toLocaleString("zh-CN");
}

function totalTitle(totals: UsageTotals): string {
  return totals.unknownRecords > 0 ? `${formatNumber(totals.unknownRecords)} 条记录的用量未知` : "用量已完整采集";
}

function intensity(value: number, maximum: number): string {
  if (value <= 0 || maximum <= 0) return "0";
  return String(Math.max(1, Math.ceil((value / maximum) * 4)));
}

function usageTooltip(label: string, totals: UsageTotals): string {
  const parts = [
    `${label} · 总 ${exactValue(totals.total, totals)} Token（输入 ${exactValue(totals.input, totals)} / 输出 ${exactValue(totals.output, totals)}）`,
    `${formatNumber(totals.records)} 条记录`,
  ];
  if (totals.unknownRecords > 0) parts.push(`${formatNumber(totals.unknownRecords)} 条用量未知`);
  if (totals.failedRecords > 0) parts.push(`${formatNumber(totals.failedRecords)} 条失败`);
  return parts.join(" · ");
}

interface TrendPoint { key: string; label: string; totals: UsageTotals }

function DailyTrend({ byHour, daily, hourly }: { byHour: boolean; daily: StatisticsDto["daily"]; hourly: StatisticsDto["hourly"] }) {
  const series = useMemo<TrendPoint[]>(() => {
    if (!byHour) return daily.map((item) => ({ key: item.date, label: item.date, totals: item }));
    const byHourOfDay = new Map<number, UsageTotals>();
    // A single-day query still returns all 168 weekday/hour buckets.
    for (const item of hourly) {
      const totals = byHourOfDay.get(item.hour) ?? { ...ZERO_TOTALS };
      for (const field of Object.keys(ZERO_TOTALS) as (keyof UsageTotals)[]) totals[field] += item[field];
      byHourOfDay.set(item.hour, totals);
    }
    return Array.from({ length: 24 }, (_, hour) => ({
      key: `hour-${String(hour)}`,
      label: `${String(hour).padStart(2, "0")}:00`,
      totals: byHourOfDay.get(hour) ?? ZERO_TOTALS,
    }));
  }, [byHour, daily, hourly]);

  const width = Math.max(720, series.length * (byHour ? 24 : 12)); const height = 210; const inset = 24;
  const maximum = Math.max(1, ...series.map((point) => point.totals.total));
  const step = (width - inset * 2) / Math.max(1, series.length);
  const scale = (height - inset * 2) / maximum;
  const tickEvery = byHour ? 3 : Math.max(1, Math.ceil(series.length / 8));
  return <div className="statistics-chart-wrap">
    <svg aria-label={byHour ? "当日每小时 Token 趋势图" : "每日 Token 趋势图"} className="statistics-line-chart" role="img" style={{ minWidth: series.length > 60 ? width : 0 }} viewBox={`0 0 ${String(width)} ${String(height)}`}>
      <defs><pattern id="statistics-trend-unknown" patternTransform="rotate(135)" patternUnits="userSpaceOnUse" width="6" height="6"><rect fill="var(--wash)" height="6" width="6" /><rect fill="var(--line-strong)" height="6" width="2" /></pattern></defs>
      <text className="statistics-chart-scale" x={inset} y={14}>{formatNumber(maximum)} Token</text>
      <line className="statistics-axis" x1={inset} x2={width - inset} y1={height - inset} y2={height - inset} />
      {series.map((point, index) => {
        const x = inset + index * step + step * .15;
        const totals = point.totals;
        const unknownStub = totals.knownRecords === 0 && totals.unknownRecords > 0;
        const label = `${point.label}，输入 ${exactValue(totals.input, totals)}，输出 ${exactValue(totals.output, totals)}，总 Token ${exactValue(totals.total, totals)}，${totalTitle(totals)}`;
        return <Tooltip content={label} key={point.key}><g aria-label={label} tabIndex={0}>{unknownStub ? <rect className="statistics-bar-unknown" fill="url(#statistics-trend-unknown)" height={UNKNOWN_STUB} width={step * .7} x={x} y={height - inset - UNKNOWN_STUB} /> : null}<rect className="statistics-bar-input" height={totals.input * scale} width={step * .7} x={x} y={height - inset - totals.input * scale} /><rect className="statistics-bar-output" height={totals.output * scale} width={step * .7} x={x} y={height - inset - totals.total * scale} /></g></Tooltip>;
      })}
      {series.map((point, index) => index % tickEvery === 0 ? <text className="statistics-chart-scale" key={`tick-${point.key}`} textAnchor="middle" x={inset + index * step + step / 2} y={height - 8}>{byHour ? point.label.slice(0, 2) : point.label.slice(5)}</text> : null)}
    </svg>
    <div className="statistics-chart-labels"><span>{series[0]?.label}</span><span>{series.at(-1)?.label}</span></div>
    <details><summary>{byHour ? "查看每小时数据表" : "查看每日数据表"}</summary><table aria-label={byHour ? "每小时 Token 明细" : "每日 Token 明细"} className="statistics-data-alternative"><thead><tr><th>{byHour ? "时段" : "日期"}</th><th>输入</th><th>输出</th><th>合计</th></tr></thead><tbody>{series.map((point) => <tr key={point.key}><td>{point.label}</td><td>{exactValue(point.totals.input, point.totals)}</td><td>{exactValue(point.totals.output, point.totals)}</td><td>{exactValue(point.totals.total, point.totals)}</td></tr>)}</tbody></table></details>
  </div>;
}

function CalendarHeatmap({ data }: { data: StatisticsDto["daily"] }) {
  const months = new Map<string, StatisticsDto["daily"]>();
  for (const item of data) { const month = item.date.slice(0, 7); const entries = months.get(month) ?? []; entries.push(item); months.set(month, entries); }
  const maximum = Math.max(1, ...data.map((item) => item.total));
  return <div className="statistics-calendar" role="group" aria-label="日期用量热图">{[...months].map(([month, entries]) => {
    const byDate = new Map(entries.map((item) => [item.date, item]));
    const date = new Date(`${month}-01T00:00:00Z`);
    const offset = (date.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    return <div className="statistics-month" key={month}><h3>{month}</h3><div className="statistics-month-grid">{WEEKDAYS.map((day) => <small key={day}>{day}</small>)}{Array.from({ length: offset }, (_, index) => <span aria-hidden key={`blank-${String(index)}`} />)}{Array.from({ length: days }, (_, index) => { const day = `${month}-${String(index + 1).padStart(2, "0")}`; const item = byDate.get(day); if (item === undefined) return <span className="statistics-outside-day" key={day}>{index + 1}</span>; const tip = usageTooltip(day, item); return <Tooltip content={tip} key={day}><span aria-label={tip} className="statistics-day" data-level={intensity(item.total, maximum)} data-unknown={item.unknownRecords > 0 && item.knownRecords === 0} role="img" tabIndex={0}>{index + 1}</span></Tooltip>; })}</div></div>;
  })}</div>;
}

export function StatisticsPage({ api, onOpenGoal }: { api: DigitalLifeApi; onOpenGoal: (goalId: string) => void }) {
  const initialRange = useMemo(() => dateRange("30"), []);
  const [preset, setPreset] = useState<DatePreset>("30");
  const [dateDraft, setDateDraft] = useState(initialRange);
  const [query, setQuery] = useState<StatisticsQuery>(() => ({ ...initialRange, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }));
  const [data, setData] = useState<StatisticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heatmap, setHeatmap] = useState<"calendar" | "hourly">("calendar");
  const [customError, setCustomError] = useState<string | null>(null);
  const revision = useRef(0);

  const load = useCallback(async () => {
    const requestRevision = ++revision.current;
    try {
      const next = await api.statistics(query);
      if (requestRevision !== revision.current) return;
      setData(next); setError(null);
    } catch (reason) {
      if (requestRevision !== revision.current) return;
      setError(reason instanceof ApiError ? reason.message : "统计暂时无法刷新，已保留上次成功获取的数据。");
    }
  }, [api, query]);

  const invalidateRequests = useCallback(() => { revision.current++; }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => { window.clearTimeout(timer); invalidateRequests(); }; }, [load, invalidateRequests]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load]);

  const choosePreset = (next: Exclude<DatePreset, "custom">) => {
    setPreset(next); setCustomError(null);
    const range = dateRange(next);
    setDateDraft(range);
    setQuery((current) => ({ ...current, ...range }));
  };
  const updateCustomDate = (field: "from" | "to", value: string) => {
    const next = { ...dateDraft, [field]: value };
    setDateDraft(next);
    setPreset("custom");
    if (next.from === "" || next.to === "") { setCustomError("请选择完整的开始和结束日期。"); return; }
    const days = inclusiveDays(next.from, next.to);
    if (days < 1) { setCustomError("结束日期不能早于开始日期。"); return; }
    if (days > 366) { setCustomError("日期范围最多 366 天。"); return; }
    setCustomError(null); setQuery((current) => ({ ...current, ...next }));
  };
  const patchFilter = (patch: Omit<Partial<StatisticsQuery>, "purpose"> & { purpose?: UsagePurpose | "" }) => {
    setQuery((current) => {
      const { purpose, ...next } = { ...current, ...patch };
      if (next.workbenchId === "") delete next.workbenchId;
      if (next.modelKey === "") delete next.modelKey;
      return { ...next, ...(purpose === "" || purpose === undefined ? {} : { purpose }) };
    });
  };
  const clearPurpose = () => {
    setQuery((current) => { const next = { ...current }; delete next.purpose; return next; });
  };

  if (data === null && error === null) return <section aria-label="统计加载中" className="statistics-page statistics-loading" role="status"><span className="load-line wide" /><span className="load-line" /><span className="statistics-skeleton-grid" /></section>;
  if (data === null) return <section className="content-state" role="alert"><p>{error}</p><button className="button quiet" onClick={() => void load()} type="button">重新加载统计</button></section>;

  const maxHourly = Math.max(1, ...data.hourly.map((item) => item.total));
  const hourly = new Map(data.hourly.map((item) => [`${String(item.weekday)}:${String(item.hour)}`, item]));
  const byHour = query.from === query.to;
  const empty = data.overview.records === 0;
  const completeness = data.overview.records === 0 ? null : Math.round((data.overview.knownRecords / data.overview.records) * 100);

  return <section className="statistics-page page-section" aria-labelledby="statistics-title">
    <header className="statistics-header"><div><p className="eyebrow">本机记录</p><h1 id="statistics-title">用量统计</h1><p>查看 joi 调用模型时的 Token 用量与任务完成情况，只呈现实际记录。</p></div><button aria-label="刷新统计" className="icon-button" onClick={() => void load()} title="刷新统计" type="button"><ArrowClockwiseIcon aria-hidden /></button></header>
    <section aria-label="统计筛选" className="statistics-filters">
      <div className="statistics-presets" role="group" aria-label="日期范围">{([ ["today", "今天"], ["7", "最近 7 天"], ["30", "最近 30 天"], ["90", "最近 90 天"], ["year", "过去一年"], ["custom", "自定义"] ] as const).map(([key, label]) => <button aria-pressed={preset === key} key={key} onClick={() => key === "custom" ? setPreset("custom") : choosePreset(key)} type="button">{label}</button>)}</div>
      <div className="statistics-filter-grid">
        <label>开始日期<input max={dateDraft.to} onChange={(event) => updateCustomDate("from", event.target.value)} type="date" value={dateDraft.from} /></label>
        <label>结束日期<input min={dateDraft.from} onChange={(event) => updateCustomDate("to", event.target.value)} type="date" value={dateDraft.to} /></label>
        <label>工作台<select onChange={(event) => patchFilter({ workbenchId: event.target.value })} value={query.workbenchId ?? ""}><option value="">全部工作台</option><option value="unassigned">全局未归属</option>{data.filters.workbenches.filter((item) => item.workbenchId !== "unassigned").map((item) => <option key={item.workbenchId} value={item.workbenchId}>{item.name}{item.archived ? "（已归档）" : ""}</option>)}</select></label>
        <label>模型<select onChange={(event) => patchFilter({ modelKey: event.target.value })} value={query.modelKey ?? ""}><option value="">全部模型</option>{data.filters.models.map((item) => <option key={item.modelKey} value={item.modelKey}>{item.sourceName} / {item.modelId}</option>)}</select></label>
        <label>用途<select onChange={(event) => event.target.value === "" ? clearPurpose() : patchFilter({ purpose: event.target.value as UsagePurpose })} value={query.purpose ?? ""}><option value="">全部用途</option>{PURPOSES.map((item) => <option key={item} value={item}>{PURPOSE_LABELS[item]}</option>)}</select></label>
      </div>
      {customError === null ? null : <p className="statistics-filter-error" role="alert">{customError}</p>}
      <div className="statistics-filter-foot"><small>按 {query.timeZone} 统计 · 每 15 秒更新</small><button className="button quiet" onClick={() => { setQuery(({ from, to, timeZone }) => ({ from, to, timeZone })); }} type="button">清除筛选</button></div>
    </section>
    {error === null ? null : <div className="statistics-error" role="alert"><WarningCircleIcon aria-hidden /><span>{error}</span></div>}
    {data.collectionDegraded ? <div className="statistics-error warning" role="status"><WarningCircleIcon aria-hidden /><span>曾发生采集失败，总量可能偏低；覆盖率仅针对已记录调用。未知用量不等于零。</span></div> : null}

    <div className="statistics-overview" aria-label="统计概览">
      {([["总 Token", knownValue(data.overview.total, data.overview), totalTitle(data.overview)], ["输入", knownValue(data.overview.input, data.overview), null], ["输出", knownValue(data.overview.output, data.overview), null], ["完成目标", formatNumber(data.overview.completedGoals), null]] as [string, string, string | null][]).map(([label, value, tip]) => <div key={label}><span>{label}</span>{tip === null ? <strong>{value}</strong> : <Tooltip content={tip}><strong tabIndex={0}>{value}</strong></Tooltip>}</div>)}
    </div>
    {empty ? <div className="statistics-empty"><CalendarBlankIcon aria-hidden /><div><h2>这个范围还没有记录</h2><p>换一个日期或筛选条件。新的模型调用完成后会自动出现在这里。</p></div></div> : null}

    <section className="statistics-panel statistics-trend" aria-labelledby="daily-trend-title"><header><h2 id="daily-trend-title">每日趋势</h2><p>{byHour ? "当日按小时统计 · " : ""}<i className="statistics-legend-input" />输入 <i className="statistics-legend-output" />输出 <i className="statistics-legend-unknown" />用量未知 · 缓存包含在输入中，推理包含在输出中，不重复计数。</p></header><DailyTrend byHour={byHour} daily={data.daily} hourly={data.hourly} /></section>

    <section className="statistics-panel statistics-heatmaps" aria-labelledby="heatmaps-title"><header><h2 id="heatmaps-title">切换日历与时段</h2><p>颜色表示已知 Token 用量强度，鼠标悬停查看明细。</p></header>
      <div className="statistics-heatmap-controls"><div className="statistics-presets" role="group" aria-label="热图类型"><button aria-pressed={heatmap === "calendar"} onClick={() => setHeatmap("calendar")} type="button">日历热图</button><button aria-pressed={heatmap === "hourly"} onClick={() => setHeatmap("hourly")} type="button">时段热图</button></div><small>少 → 多：已知 Token 用量 · 斜纹：未知</small></div>
      {heatmap === "calendar" ? <CalendarHeatmap data={data.daily} /> : <><div className="statistics-hourly" aria-label="星期小时 Token 热图"><div className="statistics-hour-row statistics-hour-labels"><span>小时</span>{Array.from({ length: 24 }, (_, hour) => <small key={hour}>{hour}</small>)}</div>{WEEKDAYS.map((day, weekday) => <div className="statistics-hour-row" key={day}><span>{day}</span>{Array.from({ length: 24 }, (_, hour) => { const item = hourly.get(`${String(weekday)}:${String(hour)}`); const slot = `${day} ${String(hour).padStart(2, "0")}:00`; const tip = item === undefined ? `${slot} · 无记录` : usageTooltip(slot, item); return <Tooltip content={tip} key={hour}><span aria-label={tip} data-level={intensity(item?.total ?? 0, maxHourly)} data-unknown={item?.knownRecords === 0 && item.unknownRecords > 0} role="img" tabIndex={0} /></Tooltip>; })}</div>)}</div><details><summary>查看时段数据表</summary><table aria-label="星期小时 Token 明细" className="statistics-data-alternative"><thead><tr><th>星期</th><th>小时</th><th>总 Token</th></tr></thead><tbody>{data.hourly.map((item) => <tr key={`${String(item.weekday)}:${String(item.hour)}`}><td>{WEEKDAYS[item.weekday]}</td><td>{String(item.hour).padStart(2, "0")}:00</td><td>{exactValue(item.total, item)}</td></tr>)}</tbody></table></details></>}
    </section>

    <div className="statistics-split">
      <section className="statistics-panel" aria-labelledby="models-title"><header><h2 id="models-title">模型排行</h2><p>鼠标悬停查看该模型的用量明细。</p></header><div className="statistics-ranking">{data.models.map((item, index) => { const share = data.overview.total === 0 ? 0 : Math.round((item.total / data.overview.total) * 100); const tip = `${item.sourceName} / ${item.modelId} · ${ENGINE_LABELS[item.engine]} · 总 ${exactValue(item.total, item)} Token（输入 ${exactValue(item.input, item)} / 输出 ${exactValue(item.output, item)}）· ${formatNumber(item.records)} 条记录 · 占比 ${String(share)}%${item.unknownRecords > 0 ? ` · ${formatNumber(item.unknownRecords)} 条用量未知` : ""}`; return <Tooltip content={tip} key={item.modelKey}><div aria-label={tip} className="statistics-row" role="img" tabIndex={0}><span>{String(index + 1).padStart(2, "0")}</span><span><strong>{item.sourceName}</strong><small>{item.modelId}</small></span><b>{knownValue(item.total, item)}</b></div></Tooltip>; })}</div></section>
      <section className="statistics-panel" aria-labelledby="purposes-title"><header><h2 id="purposes-title">用途构成</h2><p>每个用途的已知 Token 占当前筛选范围的比例，鼠标悬停查看明细。</p></header><div className="statistics-purpose-list">{data.purposes.map((item) => { const share = data.overview.total === 0 ? 0 : Math.round((item.total / data.overview.total) * 100); const tip = `${PURPOSE_LABELS[item.purpose]} · 总 ${exactValue(item.total, item)} Token（输入 ${exactValue(item.input, item)} / 输出 ${exactValue(item.output, item)}）· ${formatNumber(item.records)} 条记录 · 占比 ${String(share)}%${item.unknownRecords > 0 ? ` · ${formatNumber(item.unknownRecords)} 条用量未知` : ""}`; return <Tooltip content={tip} key={item.purpose}><div aria-label={tip} className="statistics-purpose-row" role="img" tabIndex={0}><span><strong>{PURPOSE_LABELS[item.purpose]}</strong><small>{formatNumber(item.records)} 条记录</small></span><b>{knownValue(item.total, item)}</b><i style={{ "--share": `${String(share)}%` } as React.CSSProperties} /></div></Tooltip>; })}</div></section>
    </div>

    <section className="statistics-panel" aria-labelledby="workbenches-title"><header><h2 id="workbenches-title">工作台</h2><p>同一目标只计一次，鼠标悬停查看用量明细。</p></header><div className="statistics-table-scroll"><table className="statistics-table"><thead><tr><th>工作台</th><th>总 Token</th><th>完成</th><th>失败</th><th>等待</th></tr></thead><tbody>{data.workbenches.map((item) => { const tip = `${item.name}${item.archived ? "（已归档）" : ""} · 总 ${exactValue(item.total, item)} Token（输入 ${exactValue(item.input, item)} / 输出 ${exactValue(item.output, item)}）· 完成 ${String(item.completedGoals)} / 失败 ${String(item.failedGoals)} / 等待 ${String(item.waitingGoals)} 个目标${item.unknownRecords > 0 ? ` · ${formatNumber(item.unknownRecords)} 条用量未知` : ""}`; return <Tooltip content={tip} key={item.workbenchId}><tr><th>{item.name}{item.archived ? <small>已归档</small> : null}</th><td>{knownValue(item.total, item)}</td><td>{item.completedGoals}</td><td>{item.failedGoals}</td><td>{item.waitingGoals}</td></tr></Tooltip>; })}</tbody></table></div>
      <div className="statistics-goals"><h3>目标 Top 10</h3>{data.goals.slice(0, 10).map((goal, index) => { const statusLabel = ({ canceled: "已取消", completed: "已完成", failed: "失败", running: "进行中", waiting: "等待中" })[goal.status]; const tip = `${goal.title} · ${goal.workbenchName} · ${statusLabel} · 总 ${exactValue(goal.total, goal)} Token（输入 ${exactValue(goal.input, goal)} / 输出 ${exactValue(goal.output, goal)}）· ${formatNumber(goal.records)} 条记录${goal.unknownRecords > 0 ? ` · ${formatNumber(goal.unknownRecords)} 条用量未知` : ""}`; return <Tooltip content={tip} key={goal.goalId}><button aria-label={`打开目标 ${goal.title}`} onClick={() => onOpenGoal(goal.goalId)} type="button"><span>{String(index + 1).padStart(2, "0")}</span><span><strong>{goal.title}</strong><small>{goal.workbenchName} · {statusLabel}</small></span><b>{knownValue(goal.total, goal)}</b></button></Tooltip>; })}</div>
    </section>

    <section className="statistics-panel statistics-completeness" aria-labelledby="completeness-title"><header><h2 id="completeness-title">数据完整性</h2><p>未知代表供应商没有返回可用量，不会按 0 计算。</p></header><div className="statistics-completeness-grid"><div><span>已知覆盖率</span><strong>{completeness === null ? "未知" : `${String(completeness)}%`}</strong></div><div><span>已知记录</span><strong>{formatNumber(data.overview.knownRecords)}</strong></div><div><span>未知记录</span><strong>{formatNumber(data.overview.unknownRecords)}</strong></div><div><span>失败记录</span><strong>{formatNumber(data.overview.failedRecords)}</strong></div><div><span>缓存细分已知</span><strong>{formatNumber(data.overview.cacheKnownRecords)}</strong></div><div><span>推理细分已知</span><strong>{formatNumber(data.overview.reasoningKnownRecords)}</strong></div></div><footer>采集始于 {new Date(data.collectedSince).toLocaleString()} · 更新于 {new Date(data.updatedAt).toLocaleString()}</footer></section>
  </section>;
}
