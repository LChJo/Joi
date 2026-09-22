import { ArrowClockwiseIcon, CalendarBlankIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { StatisticsDto, StatisticsQuery, UsagePurpose, UsageTotals } from "../shared/statistics";
import { ApiError, type DigitalLifeApi } from "./api";

type DatePreset = "today" | "7" | "30" | "90" | "year" | "custom";

const POLL_MS = 15_000;
const PURPOSES: readonly UsagePurpose[] = ["orchestration", "routing", "partner", "evolution", "summary", "probe"];
const PURPOSE_LABELS: Record<UsagePurpose, string> = {
  evolution: "进化", orchestration: "编排", partner: "搭档", probe: "探测", routing: "路由", summary: "总结",
};
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

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

function DailyTrend({ data }: { data: StatisticsDto["daily"] }) {
  const width = Math.max(720, data.length * 12); const height = 210; const inset = 24;
  const maximum = Math.max(1, ...data.map((item) => item.total));
  const step = (width - inset * 2) / Math.max(1, data.length);
  const scale = (height - inset * 2) / maximum;
  return <div className="statistics-chart-wrap">
    <svg aria-label="每日 Token 趋势图" className="statistics-line-chart" role="img" style={{ minWidth: data.length > 60 ? width : 0 }} viewBox={`0 0 ${String(width)} ${String(height)}`}>
      <text className="statistics-chart-scale" x={inset} y={14}>{formatNumber(maximum)} Token</text>
      <line className="statistics-axis" x1={inset} x2={width - inset} y1={height - inset} y2={height - inset} />
      {data.map((item, index) => {
        const x = inset + index * step + step * .15;
        const label = `${item.date}，输入 ${exactValue(item.input, item)}，输出 ${exactValue(item.output, item)}，总 Token ${exactValue(item.total, item)}，${totalTitle(item)}`;
        return <g aria-label={label} key={item.date} tabIndex={0}><title>{label}</title><rect className="statistics-bar-input" height={item.input * scale} width={step * .7} x={x} y={height - inset - item.input * scale} /><rect className="statistics-bar-output" height={item.output * scale} width={step * .7} x={x} y={height - inset - item.total * scale} />{item.unknownRecords > 0 ? <text className="statistics-chart-unknown" x={x} y={height - 7}>?</text> : null}</g>;
      })}
    </svg>
    <div className="statistics-chart-labels"><span>{data[0]?.date}</span><span>{data.at(-1)?.date}</span></div>
    <details><summary>查看每日数据表</summary><table aria-label="每日 Token 明细" className="statistics-data-alternative"><thead><tr><th>日期</th><th>输入</th><th>输出</th><th>合计</th></tr></thead><tbody>{data.map((item) => <tr key={item.date}><td>{item.date}</td><td>{exactValue(item.input, item)}</td><td>{exactValue(item.output, item)}</td><td>{exactValue(item.total, item)}</td></tr>)}</tbody></table></details>
  </div>;
}

function CalendarHeatmap({ data, selected, onSelect }: { data: StatisticsDto["daily"]; selected: string | null; onSelect: (date: string) => void }) {
  const months = new Map<string, StatisticsDto["daily"]>();
  for (const item of data) { const month = item.date.slice(0, 7); const entries = months.get(month) ?? []; entries.push(item); months.set(month, entries); }
  const maximum = Math.max(1, ...data.map((item) => item.total));
  return <div className="statistics-calendar" role="group" aria-label="日期用量热图">{[...months].map(([month, entries]) => {
    const byDate = new Map(entries.map((item) => [item.date, item]));
    const date = new Date(`${month}-01T00:00:00Z`);
    const offset = (date.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    return <div className="statistics-month" key={month}><h3>{month}</h3><div className="statistics-month-grid">{WEEKDAYS.map((day) => <small key={day}>{day}</small>)}{Array.from({ length: offset }, (_, index) => <span aria-hidden key={`blank-${String(index)}`} />)}{Array.from({ length: days }, (_, index) => { const day = `${month}-${String(index + 1).padStart(2, "0")}`; const item = byDate.get(day); return item === undefined ? <span className="statistics-outside-day" key={day}>{index + 1}</span> : <button aria-label={`查看 ${day}，${exactValue(item.total, item)} Token，${totalTitle(item)}`} aria-pressed={selected === day} data-level={intensity(item.total, maximum)} data-unknown={item.unknownRecords > 0 && item.knownRecords === 0} key={day} onClick={() => onSelect(day)} title={`${day} · ${exactValue(item.total, item)} Token`} type="button">{index + 1}</button>; })}</div></div>;
  })}</div>;
}

function DayDetail({ api, query, date, onClose, onOpenGoal }: { api: DigitalLifeApi; query: StatisticsQuery; date: string; onClose: () => void; onOpenGoal: (goalId: string) => void }) {
  const [data, setData] = useState<StatisticsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; void api.statistics({ ...query, from: date, to: date }).then((next) => { if (active) { setData(next); setFailed(false); } }).catch(() => { if (active) setFailed(true); }); return () => { active = false; }; }, [api, query, date, attempt]);
  return <section aria-label="当日明细" className="statistics-drilldown"><header><h3>{date} 明细</h3><button className="button quiet" onClick={onClose} type="button">收起</button></header>{failed ? <p role="alert">当天数据暂时无法读取。<button className="button quiet" onClick={() => setAttempt((value) => value + 1)} type="button">重试</button></p> : data === null ? <p role="status">正在读取当天记录…</p> : <><p>输入 {exactValue(data.overview.input, data.overview)} · 输出 {exactValue(data.overview.output, data.overview)} · {totalTitle(data.overview)}</p><div className="statistics-day-columns"><div><h4>模型</h4>{data.models.map((item) => <p key={item.modelKey}>{item.sourceName} / {item.modelId}<b>{exactValue(item.total, item)}</b></p>)}</div><div><h4>工作台</h4>{data.workbenches.map((item) => <p key={item.workbenchId}>{item.name}<b>{exactValue(item.total, item)}</b></p>)}</div><div><h4>目标</h4>{data.goals.map((item) => <button className="statistics-day-goal" key={item.goalId} onClick={() => onOpenGoal(item.goalId)} type="button">{item.title}<b>{exactValue(item.total, item)}</b></button>)}</div></div>{data.overview.records === 0 ? <p>当天没有调用记录。</p> : null}</>}</section>;
}

function FilterButton({ children, label, onSelect }: { children: React.ReactNode; label: string; onSelect: () => void }) {
  return <button aria-label={label} className="statistics-row-button" onClick={onSelect} onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); }
  }} type="button">{children}</button>;
}

export function StatisticsPage({ api, onOpenGoal }: { api: DigitalLifeApi; onOpenGoal: (goalId: string) => void }) {
  const initialRange = useMemo(() => dateRange("30"), []);
  const [preset, setPreset] = useState<DatePreset>("30");
  const [dateDraft, setDateDraft] = useState(initialRange);
  const [query, setQuery] = useState<StatisticsQuery>(() => ({ ...initialRange, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }));
  const [data, setData] = useState<StatisticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
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
    setPreset(next); setCustomError(null); setSelectedDate(null);
    const range = dateRange(next);
    setDateDraft(range);
    setQuery((current) => ({ ...current, ...range }));
  };
  const updateCustomDate = (field: "from" | "to", value: string) => {
    const next = { ...dateDraft, [field]: value };
    setDateDraft(next);
    setPreset("custom"); setSelectedDate(null);
    if (next.from === "" || next.to === "") { setCustomError("请选择完整的开始和结束日期。"); return; }
    const days = inclusiveDays(next.from, next.to);
    if (days < 1) { setCustomError("结束日期不能早于开始日期。"); return; }
    if (days > 366) { setCustomError("日期范围最多 366 天。"); return; }
    setCustomError(null); setQuery((current) => ({ ...current, ...next }));
  };
  const patchFilter = (patch: Omit<Partial<StatisticsQuery>, "purpose"> & { purpose?: UsagePurpose | "" }) => {
    setSelectedDate(null);
    setQuery((current) => {
      const { purpose, ...next } = { ...current, ...patch };
      if (next.workbenchId === "") delete next.workbenchId;
      if (next.modelKey === "") delete next.modelKey;
      return { ...next, ...(purpose === "" || purpose === undefined ? {} : { purpose }) };
    });
  };
  const clearPurpose = () => {
    setSelectedDate(null);
    setQuery((current) => { const next = { ...current }; delete next.purpose; return next; });
  };

  if (data === null && error === null) return <section aria-label="统计加载中" className="statistics-page statistics-loading" role="status"><span className="load-line wide" /><span className="load-line" /><span className="statistics-skeleton-grid" /></section>;
  if (data === null) return <section className="content-state" role="alert"><p>{error}</p><button className="button quiet" onClick={() => void load()} type="button">重新加载统计</button></section>;

  const maxHourly = Math.max(1, ...data.hourly.map((item) => item.total));
  const hourly = new Map(data.hourly.map((item) => [`${String(item.weekday)}:${String(item.hour)}`, item]));
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
      <div className="statistics-filter-foot"><small>按 {query.timeZone} 统计 · 每 15 秒更新</small><button className="button quiet" onClick={() => { setSelectedDate(null); setQuery(({ from, to, timeZone }) => ({ from, to, timeZone })); }} type="button">清除筛选</button></div>
    </section>
    {error === null ? null : <div className="statistics-error" role="alert"><WarningCircleIcon aria-hidden /><span>{error}</span></div>}
    {data.collectionDegraded ? <div className="statistics-error warning" role="status"><WarningCircleIcon aria-hidden /><span>曾发生采集失败，总量可能偏低；覆盖率仅针对已记录调用。未知用量不等于零。</span></div> : null}

    <div className="statistics-overview" aria-label="统计概览">
      {[["总 Token", knownValue(data.overview.total, data.overview)], ["输入", knownValue(data.overview.input, data.overview)], ["输出", knownValue(data.overview.output, data.overview)], ["完成目标", formatNumber(data.overview.completedGoals)]].map(([label, value]) => <div key={label}><span>{label}</span><strong title={label === "总 Token" ? totalTitle(data.overview) : undefined}>{value}</strong></div>)}
    </div>
    {empty ? <div className="statistics-empty"><CalendarBlankIcon aria-hidden /><div><h2>这个范围还没有记录</h2><p>换一个日期或筛选条件。新的模型调用完成后会自动出现在这里。</p></div></div> : null}

    <section className="statistics-panel statistics-trend" aria-labelledby="daily-trend-title"><header><h2 id="daily-trend-title">每日趋势</h2><p><i className="statistics-legend-input" />输入 <i className="statistics-legend-output" />输出 · 缓存包含在输入中，推理包含在输出中，不重复计数。</p></header><DailyTrend data={data.daily} /></section>

    <section className="statistics-panel statistics-heatmaps" aria-labelledby="heatmaps-title"><header><h2 id="heatmaps-title">切换日历与时段</h2><p>颜色表示已知 Token 用量强度。选择日期只查看当天明细，不改变主筛选范围。</p></header>
      <div className="statistics-heatmap-controls"><div className="statistics-presets" role="group" aria-label="热图类型"><button aria-pressed={heatmap === "calendar"} onClick={() => setHeatmap("calendar")} type="button">日历热图</button><button aria-pressed={heatmap === "hourly"} onClick={() => setHeatmap("hourly")} type="button">时段热图</button></div><small>少 → 多：已知 Token 用量 · 斜纹：未知</small></div>
      {heatmap === "calendar" ? <CalendarHeatmap data={data.daily} onSelect={setSelectedDate} selected={selectedDate} /> : <><div className="statistics-hourly" aria-label="星期小时 Token 热图"><div className="statistics-hour-row statistics-hour-labels"><span>小时</span>{Array.from({ length: 24 }, (_, hour) => <small key={hour}>{hour}</small>)}</div>{WEEKDAYS.map((day, weekday) => <div className="statistics-hour-row" key={day}><span>{day}</span>{Array.from({ length: 24 }, (_, hour) => { const item = hourly.get(`${String(weekday)}:${String(hour)}`); const label = `${day} ${String(hour).padStart(2, "0")}:00，${item === undefined ? "0" : exactValue(item.total, item)} Token`; return <span aria-label={label} data-level={intensity(item?.total ?? 0, maxHourly)} data-unknown={item?.knownRecords === 0 && item.unknownRecords > 0} key={hour} role="img" tabIndex={0} title={label} />; })}</div>)}</div><details><summary>查看时段数据表</summary><table aria-label="星期小时 Token 明细" className="statistics-data-alternative"><thead><tr><th>星期</th><th>小时</th><th>总 Token</th></tr></thead><tbody>{data.hourly.map((item) => <tr key={`${String(item.weekday)}:${String(item.hour)}`}><td>{WEEKDAYS[item.weekday]}</td><td>{String(item.hour).padStart(2, "0")}:00</td><td>{exactValue(item.total, item)}</td></tr>)}</tbody></table></details></>}
      {selectedDate === null ? null : <DayDetail api={api} date={selectedDate} key={`${selectedDate}:${JSON.stringify(query)}`} onClose={() => setSelectedDate(null)} onOpenGoal={onOpenGoal} query={query} />}
    </section>

    <div className="statistics-split">
      <section className="statistics-panel" aria-labelledby="models-title"><header><h2 id="models-title">模型排行</h2><p>选择一行可筛选整个页面。</p></header><div className="statistics-ranking">{data.models.map((item, index) => <FilterButton key={item.modelKey} label={`筛选模型 ${item.sourceName}`} onSelect={() => patchFilter({ modelKey: item.modelKey })}><span>{String(index + 1).padStart(2, "0")}</span><span><strong>{item.sourceName}</strong><small>{item.modelId}</small></span><b>{knownValue(item.total, item)}</b></FilterButton>)}</div></section>
      <section className="statistics-panel" aria-labelledby="purposes-title"><header><h2 id="purposes-title">用途构成</h2><p>每个用途的已知 Token 占当前筛选范围的比例。</p></header><div className="statistics-purpose-list">{data.purposes.map((item) => { const share = data.overview.total === 0 ? 0 : Math.round((item.total / data.overview.total) * 100); return <button key={item.purpose} onClick={() => patchFilter({ purpose: item.purpose })} type="button"><span><strong>{PURPOSE_LABELS[item.purpose]}</strong><small>{formatNumber(item.records)} 条记录</small></span><b>{knownValue(item.total, item)}</b><i style={{ "--share": `${String(share)}%` } as React.CSSProperties} /></button>; })}</div></section>
    </div>

    <section className="statistics-panel" aria-labelledby="workbenches-title"><header><h2 id="workbenches-title">工作台</h2><p>同一目标只计一次。选择工作台可收窄全页数据。</p></header><div className="statistics-table-scroll"><table className="statistics-table"><thead><tr><th>工作台</th><th>总 Token</th><th>完成</th><th>失败</th><th>等待</th></tr></thead><tbody>{data.workbenches.map((item) => <tr key={item.workbenchId}><th><button aria-label={`筛选工作台 ${item.name}`} onClick={() => patchFilter({ workbenchId: item.workbenchId })} type="button">{item.name}{item.archived ? <small>已归档</small> : null}</button></th><td>{knownValue(item.total, item)}</td><td>{item.completedGoals}</td><td>{item.failedGoals}</td><td>{item.waitingGoals}</td></tr>)}</tbody></table></div>
      <div className="statistics-goals"><h3>目标 Top 10</h3>{data.goals.slice(0, 10).map((goal, index) => <button aria-label={`打开目标 ${goal.title}`} key={goal.goalId} onClick={() => onOpenGoal(goal.goalId)} type="button"><span>{String(index + 1).padStart(2, "0")}</span><span><strong>{goal.title}</strong><small>{goal.workbenchName} · {({ completed: "已完成", failed: "失败", waiting: "等待中", running: "进行中", canceled: "已取消" })[goal.status]}</small></span><b>{knownValue(goal.total, goal)}</b></button>)}</div>
    </section>

    <section className="statistics-panel statistics-completeness" aria-labelledby="completeness-title"><header><h2 id="completeness-title">数据完整性</h2><p>未知代表供应商没有返回可用量，不会按 0 计算。</p></header><div className="statistics-completeness-grid"><div><span>已知覆盖率</span><strong>{completeness === null ? "未知" : `${String(completeness)}%`}</strong></div><div><span>已知记录</span><strong>{formatNumber(data.overview.knownRecords)}</strong></div><div><span>未知记录</span><strong>{formatNumber(data.overview.unknownRecords)}</strong></div><div><span>失败记录</span><strong>{formatNumber(data.overview.failedRecords)}</strong></div><div><span>缓存细分已知</span><strong>{formatNumber(data.overview.cacheKnownRecords)}</strong></div><div><span>推理细分已知</span><strong>{formatNumber(data.overview.reasoningKnownRecords)}</strong></div></div><footer>采集始于 {new Date(data.collectedSince).toLocaleString()} · 更新于 {new Date(data.updatedAt).toLocaleString()}</footer></section>
  </section>;
}
