import { currentLocale, noticeMessage, t, useI18n, useNotice } from "./i18n";
import { ArrowClockwiseIcon, CalendarBlankIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { StatisticsDto, StatisticsQuery, UsageEngine, UsagePurpose, UsageTotals } from "../shared/statistics";
import { ApiError, type DigitalLifeApi } from "./api";
import { Tooltip } from "./Tooltip";

type DatePreset = "today" | "7" | "30" | "90" | "year" | "custom";

const POLL_MS = 15_000;
const PURPOSES: readonly UsagePurpose[] = ["orchestration", "routing", "partner", "evolution", "summary", "probe"];
const PURPOSE_LABELS: Record<UsagePurpose, string> = {
  get evolution() { return t("statistics.evolution"); }, get orchestration() { return t("statistics.orchestration"); }, get partner() { return t("common.partners"); }, get probe() { return t("statistics.probe"); }, get routing() { return t("statistics.routing"); }, get summary() { return t("statistics.summary"); },
};
const ENGINE_LABELS: Record<UsageEngine, string> = { a2a: "A2A", "claude-code": "Claude Code", codex: "Codex", pi: "pi" };
const WEEKDAYS = () => [t("common.weekdayMonday"), t("common.weekdayTuesday"), t("common.weekdayWednesday"), t("common.weekdayThursday"), t("common.weekdayFriday"), t("common.weekdaySaturday"), t("common.weekdaySunday")];
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
  return new Intl.NumberFormat(currentLocale(), { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function knownValue(value: number, totals: UsageTotals): string {
  return totals.knownRecords === 0 && totals.unknownRecords > 0 ? t("statistics.unknown") : formatNumber(value);
}

function exactValue(value: number, totals: UsageTotals): string {
  return totals.knownRecords === 0 && totals.unknownRecords > 0 ? t("statistics.unknown") : value.toLocaleString(currentLocale());
}

function totalTitle(totals: UsageTotals): string {
  return totals.unknownRecords > 0 ? t("statistics.usageUnknownForValueRecords", { p0: formatNumber(totals.unknownRecords) }) : t("statistics.usageCollectionComplete");
}

function intensity(value: number, maximum: number): string {
  if (value <= 0 || maximum <= 0) return "0";
  return String(Math.max(1, Math.ceil((value / maximum) * 4)));
}

function usageTooltip(label: string, totals: UsageTotals): string {
  const parts = [
    t("statistics.valueValueTotalTokensInputValueOutputValue", { p0: label, p1: exactValue(totals.total, totals), p2: exactValue(totals.input, totals), p3: exactValue(totals.output, totals) }),
    t("statistics.valueRecords", { p0: formatNumber(totals.records) }),
  ];
  if (totals.unknownRecords > 0) parts.push(t("statistics.valueUnknownUsage", { p0: formatNumber(totals.unknownRecords) }));
  if (totals.failedRecords > 0) parts.push(t("statistics.valueFailed", { p0: formatNumber(totals.failedRecords) }));
  return parts.join(" · ");
}

interface TrendPoint { key: string; label: string; totals: UsageTotals }

function DailyTrend({ byHour, daily, hourly }: { byHour: boolean; daily: StatisticsDto["daily"]; hourly: StatisticsDto["hourly"] }) {
  useI18n();
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
    <svg aria-label={byHour ? t("statistics.hourlyTokenTrendForTheDay") : t("statistics.dailyTokenTrend")} className="statistics-line-chart" role="img" style={{ minWidth: series.length > 60 ? width : 0 }} viewBox={`0 0 ${String(width)} ${String(height)}`}>
      <defs><pattern id="statistics-trend-unknown" patternTransform="rotate(135)" patternUnits="userSpaceOnUse" width="6" height="6"><rect fill="var(--wash)" height="6" width="6" /><rect fill="var(--line-strong)" height="6" width="2" /></pattern></defs>
      <text className="statistics-chart-scale" x={inset} y={14}>{formatNumber(maximum)} Token</text>
      <line className="statistics-axis" x1={inset} x2={width - inset} y1={height - inset} y2={height - inset} />
      {series.map((point, index) => {
        const x = inset + index * step + step * .15;
        const totals = point.totals;
        const unknownStub = totals.knownRecords === 0 && totals.unknownRecords > 0;
        const label = t("statistics.valueInputValueOutputValueTotalTokensValueValue", { p0: point.label, p1: exactValue(totals.input, totals), p2: exactValue(totals.output, totals), p3: exactValue(totals.total, totals), p4: totalTitle(totals) });
        return <Tooltip content={label} key={point.key}><g aria-label={label} tabIndex={0}>{unknownStub ? <rect className="statistics-bar-unknown" fill="url(#statistics-trend-unknown)" height={UNKNOWN_STUB} width={step * .7} x={x} y={height - inset - UNKNOWN_STUB} /> : null}<rect className="statistics-bar-input" height={totals.input * scale} width={step * .7} x={x} y={height - inset - totals.input * scale} /><rect className="statistics-bar-output" height={totals.output * scale} width={step * .7} x={x} y={height - inset - totals.total * scale} /></g></Tooltip>;
      })}
      {series.map((point, index) => index % tickEvery === 0 ? <text className="statistics-chart-scale" key={`tick-${point.key}`} textAnchor="middle" x={inset + index * step + step / 2} y={height - 8}>{byHour ? point.label.slice(0, 2) : point.label.slice(5)}</text> : null)}
    </svg>
    <div className="statistics-chart-labels"><span>{series[0]?.label}</span><span>{series.at(-1)?.label}</span></div>
    <details><summary>{byHour ? t("statistics.viewHourlyDataTable") : t("statistics.viewDailyDataTable")}</summary><table aria-label={byHour ? t("statistics.hourlyTokenDetails") : t("statistics.dailyTokenDetails")} className="statistics-data-alternative"><thead><tr><th>{byHour ? t("statistics.timePeriod") : t("statistics.date")}</th><th>{t("statistics.input")}</th><th>{t("home.output")}</th><th>{t("evolution.total")}</th></tr></thead><tbody>{series.map((point) => <tr key={point.key}><td>{point.label}</td><td>{exactValue(point.totals.input, point.totals)}</td><td>{exactValue(point.totals.output, point.totals)}</td><td>{exactValue(point.totals.total, point.totals)}</td></tr>)}</tbody></table></details>
  </div>;
}

function CalendarHeatmap({ data }: { data: StatisticsDto["daily"] }) {
  useI18n();
  const months = new Map<string, StatisticsDto["daily"]>();
  for (const item of data) { const month = item.date.slice(0, 7); const entries = months.get(month) ?? []; entries.push(item); months.set(month, entries); }
  const maximum = Math.max(1, ...data.map((item) => item.total));
  return <div className="statistics-calendar" role="group" aria-label={t("statistics.dailyUsageHeatmap")}>{[...months].map(([month, entries]) => {
    const byDate = new Map(entries.map((item) => [item.date, item]));
    const date = new Date(`${month}-01T00:00:00Z`);
    const offset = (date.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    return <div className="statistics-month" key={month}><h3>{month}</h3><div className="statistics-month-grid">{WEEKDAYS().map((day) => <small key={day}>{day}</small>)}{Array.from({ length: offset }, (_, index) => <span aria-hidden key={`blank-${String(index)}`} />)}{Array.from({ length: days }, (_, index) => { const day = `${month}-${String(index + 1).padStart(2, "0")}`; const item = byDate.get(day); if (item === undefined) return <span className="statistics-outside-day" key={day}>{index + 1}</span>; const tip = usageTooltip(day, item); return <Tooltip content={tip} key={day}><span aria-label={tip} className="statistics-day" data-level={intensity(item.total, maximum)} data-unknown={item.unknownRecords > 0 && item.knownRecords === 0} role="img" tabIndex={0}>{index + 1}</span></Tooltip>; })}</div></div>;
  })}</div>;
}

export function StatisticsPage({ api, onOpenGoal }: { api: DigitalLifeApi; onOpenGoal: (goalId: string) => void }) {
  useI18n();
  const initialRange = useMemo(() => dateRange("30"), []);
  const [preset, setPreset] = useState<DatePreset>("30");
  const [dateDraft, setDateDraft] = useState(initialRange);
  const [query, setQuery] = useState<StatisticsQuery>(() => ({ ...initialRange, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }));
  const [data, setData] = useState<StatisticsDto | null>(null);
  const [error, setError] = useNotice();
  const [heatmap, setHeatmap] = useState<"calendar" | "hourly">("calendar");
  const [customError, setCustomError] = useNotice();
  const revision = useRef(0);

  const load = useCallback(async () => {
    const requestRevision = ++revision.current;
    try {
      const next = await api.statistics(query);
      if (requestRevision !== revision.current) return;
      setData(next); setError(null);
    } catch (reason) {
      if (requestRevision !== revision.current) return;
      setError(reason instanceof ApiError ? reason.displayMessage : noticeMessage("statistics.statisticsCouldNotBeRefreshedTheLastSuccessfulData"));
    }
  }, [api, query, setError]);

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
    if (next.from === "" || next.to === "") { setCustomError(noticeMessage("statistics.chooseBothAStartDateAndAnEndDate")); return; }
    const days = inclusiveDays(next.from, next.to);
    if (days < 1) { setCustomError(noticeMessage("statistics.theEndDateCannotBeEarlierThanTheStart")); return; }
    if (days > 366) { setCustomError(noticeMessage("statistics.theDateRangeCannotExceed366Days")); return; }
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

  if (data === null && error === null) return <section aria-label={t("statistics.loadingStatistics")} className="statistics-page statistics-loading" role="status"><span className="load-line wide" /><span className="load-line" /><span className="statistics-skeleton-grid" /></section>;
  if (data === null) return <section className="content-state" role="alert"><p>{error}</p><button className="button quiet" onClick={() => void load()} type="button">{t("statistics.reloadStatistics")}</button></section>;

  const maxHourly = Math.max(1, ...data.hourly.map((item) => item.total));
  const hourly = new Map(data.hourly.map((item) => [`${String(item.weekday)}:${String(item.hour)}`, item]));
  const byHour = query.from === query.to;
  const empty = data.overview.records === 0;
  const completeness = data.overview.records === 0 ? null : Math.round((data.overview.knownRecords / data.overview.records) * 100);

  return <section className="statistics-page page-section" aria-labelledby="statistics-title">
    <header className="statistics-header"><div><p className="eyebrow">{t("statistics.localRecords")}</p><h1 id="statistics-title">{t("statistics.usageStatistics")}</h1><p>{t("statistics.viewRecordedTokenUsageAndTaskCompletionForJoi")}</p></div><button aria-label={t("statistics.refreshStatistics")} className="icon-button" onClick={() => void load()} title={t("statistics.refreshStatistics")} type="button"><ArrowClockwiseIcon aria-hidden /></button></header>
    <section aria-label={t("statistics.statisticsFilters")} className="statistics-filters">
      <div className="statistics-presets" role="group" aria-label={t("statistics.dateRange")}>{([ ["today", t("statistics.today")], ["7", t("statistics.last7Days")], ["30", t("statistics.last30Days")], ["90", t("statistics.last90Days")], ["year", t("statistics.pastYear")], ["custom", t("statistics.custom")] ] as const).map(([key, label]) => <button aria-pressed={preset === key} key={key} onClick={() => key === "custom" ? setPreset("custom") : choosePreset(key)} type="button">{label}</button>)}</div>
      <div className="statistics-filter-grid">
        <label>{t("automation.startDate")}<input max={dateDraft.to} onChange={(event) => updateCustomDate("from", event.target.value)} type="date" value={dateDraft.from} /></label>
        <label>{t("automation.endDate")}<input min={dateDraft.from} onChange={(event) => updateCustomDate("to", event.target.value)} type="date" value={dateDraft.to} /></label>
        <label>{t("common.workbenches")}<select onChange={(event) => patchFilter({ workbenchId: event.target.value })} value={query.workbenchId ?? ""}><option value="">{t("evolution.allWorkbenches")}</option><option value="unassigned">{t("statistics.globalUnassigned")}</option>{data.filters.workbenches.filter((item) => item.workbenchId !== "unassigned").map((item) => <option key={item.workbenchId} value={item.workbenchId}>{item.name}{item.archived ? t("statistics.archived") : ""}</option>)}</select></label>
        <label>{t("statistics.model")}<select onChange={(event) => patchFilter({ modelKey: event.target.value })} value={query.modelKey ?? ""}><option value="">{t("statistics.allModels")}</option>{data.filters.models.map((item) => <option key={item.modelKey} value={item.modelKey}>{item.sourceName} / {item.modelId}</option>)}</select></label>
        <label>{t("statistics.purpose")}<select onChange={(event) => event.target.value === "" ? clearPurpose() : patchFilter({ purpose: event.target.value as UsagePurpose })} value={query.purpose ?? ""}><option value="">{t("statistics.allPurposes")}</option>{PURPOSES.map((item) => <option key={item} value={item}>{PURPOSE_LABELS[item]}</option>)}</select></label>
      </div>
      {customError === null ? null : <p className="statistics-filter-error" role="alert">{customError}</p>}
      <div className="statistics-filter-foot"><small>{t("statistics.by")} {query.timeZone}  {t("statistics.updatesEvery15Seconds")}</small><button className="button quiet" onClick={() => { setQuery(({ from, to, timeZone }) => ({ from, to, timeZone })); }} type="button">{t("statistics.clearFilters")}</button></div>
    </section>
    {error === null ? null : <div className="statistics-error" role="alert"><WarningCircleIcon aria-hidden /><span>{error}</span></div>}
    {data.collectionDegraded ? <div className="statistics-error warning" role="status"><WarningCircleIcon aria-hidden /><span>{t("statistics.collectionHasFailedBeforeSoTotalsMayBeLow")}</span></div> : null}

    <div className="statistics-overview" aria-label={t("statistics.statisticsOverview")}>
      {([[t("statistics.totalTokens"), knownValue(data.overview.total, data.overview), totalTitle(data.overview)], [t("statistics.input"), knownValue(data.overview.input, data.overview), null], [t("home.output"), knownValue(data.overview.output, data.overview), null], [t("statistics.completedGoals"), formatNumber(data.overview.completedGoals), null]] as [string, string, string | null][]).map(([label, value, tip]) => <div key={label}><span>{label}</span>{tip === null ? <strong>{value}</strong> : <Tooltip content={tip}><strong tabIndex={0}>{value}</strong></Tooltip>}</div>)}
    </div>
    {empty ? <div className="statistics-empty"><CalendarBlankIcon aria-hidden /><div><h2>{t("statistics.noRecordsInThisRange")}</h2><p>{t("statistics.tryADifferentDateOrFilterNewModelCalls")}</p></div></div> : null}

    <section className="statistics-panel statistics-trend" aria-labelledby="daily-trend-title"><header><h2 id="daily-trend-title">{t("statistics.dailyTrend")}</h2><p>{byHour ? t("statistics.hourlyBreakdownForTheDay") : ""}<i className="statistics-legend-input" />{t("statistics.input")} <i className="statistics-legend-output" />{t("home.output")} <i className="statistics-legend-unknown" />{t("statistics.unknownUsageCacheIsIncludedInInputAndReasoning")}</p></header><DailyTrend byHour={byHour} daily={data.daily} hourly={data.hourly} /></section>

    <section className="statistics-panel statistics-heatmaps" aria-labelledby="heatmaps-title"><header><h2 id="heatmaps-title">{t("statistics.switchBetweenCalendarAndTimePeriods")}</h2><p>{t("statistics.colorShowsKnownTokenUsageIntensityHoverForDetails")}</p></header>
      <div className="statistics-heatmap-controls"><div className="statistics-presets" role="group" aria-label={t("statistics.heatmapType")}><button aria-pressed={heatmap === "calendar"} onClick={() => setHeatmap("calendar")} type="button">{t("statistics.calendarHeatmap")}</button><button aria-pressed={heatmap === "hourly"} onClick={() => setHeatmap("hourly")} type="button">{t("statistics.timePeriodHeatmap")}</button></div><small>{t("statistics.lowHighKnownTokenUsageStripesUnknown")}</small></div>
      {heatmap === "calendar" ? <CalendarHeatmap data={data.daily} /> : <><div className="statistics-hourly" aria-label={t("statistics.weekdayAndHourTokenHeatmap")}><div className="statistics-hour-row statistics-hour-labels"><span>{t("statistics.hour")}</span>{Array.from({ length: 24 }, (_, hour) => <small key={hour}>{hour}</small>)}</div>{WEEKDAYS().map((day, weekday) => <div className="statistics-hour-row" key={day}><span>{day}</span>{Array.from({ length: 24 }, (_, hour) => { const item = hourly.get(`${String(weekday)}:${String(hour)}`); const slot = `${day} ${String(hour).padStart(2, "0")}:00`; const tip = item === undefined ? t("statistics.valueNoRecords", { p0: slot }) : usageTooltip(slot, item); return <Tooltip content={tip} key={hour}><span aria-label={tip} data-level={intensity(item?.total ?? 0, maxHourly)} data-unknown={item?.knownRecords === 0 && item.unknownRecords > 0} role="img" tabIndex={0} /></Tooltip>; })}</div>)}</div><details><summary>{t("statistics.viewTimePeriodDataTable")}</summary><table aria-label={t("statistics.weekdayAndHourTokenDetails")} className="statistics-data-alternative"><thead><tr><th>{t("statistics.weekday")}</th><th>{t("statistics.hour")}</th><th>{t("statistics.totalTokens")}</th></tr></thead><tbody>{data.hourly.map((item) => <tr key={`${String(item.weekday)}:${String(item.hour)}`}><td>{WEEKDAYS()[item.weekday]}</td><td>{String(item.hour).padStart(2, "0")}:00</td><td>{exactValue(item.total, item)}</td></tr>)}</tbody></table></details></>}
    </section>

    <div className="statistics-split">
      <section className="statistics-panel" aria-labelledby="models-title"><header><h2 id="models-title">{t("statistics.modelRanking")}</h2><p>{t("statistics.hoverToViewUsageDetailsForAModel")}</p></header><div className="statistics-ranking">{data.models.map((item, index) => { const share = data.overview.total === 0 ? 0 : Math.round((item.total / data.overview.total) * 100); const tip = t("statistics.valueValueValueValueTotalTokensInputValueOutput", { p0: item.sourceName, p1: item.modelId, p2: ENGINE_LABELS[item.engine], p3: exactValue(item.total, item), p4: exactValue(item.input, item), p5: exactValue(item.output, item), p6: formatNumber(item.records), p7: String(share), p8: (item.unknownRecords > 0 ? t("statistics.valueUnknownUsagebc8a20", { p0: formatNumber(item.unknownRecords) }) : "") }); return <Tooltip content={tip} key={item.modelKey}><div aria-label={tip} className="statistics-row" role="img" tabIndex={0}><span>{String(index + 1).padStart(2, "0")}</span><span><strong>{item.sourceName}</strong><small>{item.modelId}</small></span><b>{knownValue(item.total, item)}</b></div></Tooltip>; })}</div></section>
      <section className="statistics-panel" aria-labelledby="purposes-title"><header><h2 id="purposes-title">{t("statistics.usageByPurpose")}</h2><p>{t("statistics.shareOfKnownTokensByPurposeWithinTheCurrent")}</p></header><div className="statistics-purpose-list">{data.purposes.map((item) => { const share = data.overview.total === 0 ? 0 : Math.round((item.total / data.overview.total) * 100); const tip = t("statistics.valueValueTotalTokensInputValueOutputValueValue", { p0: PURPOSE_LABELS[item.purpose], p1: exactValue(item.total, item), p2: exactValue(item.input, item), p3: exactValue(item.output, item), p4: formatNumber(item.records), p5: String(share), p6: (item.unknownRecords > 0 ? t("statistics.valueUnknownUsagebc8a20", { p0: formatNumber(item.unknownRecords) }) : "") }); return <Tooltip content={tip} key={item.purpose}><div aria-label={tip} className="statistics-purpose-row" role="img" tabIndex={0}><span><strong>{PURPOSE_LABELS[item.purpose]}</strong><small>{formatNumber(item.records)}  {t("statistics.records")}</small></span><b>{knownValue(item.total, item)}</b><i style={{ "--share": `${String(share)}%` } as React.CSSProperties} /></div></Tooltip>; })}</div></section>
    </div>

    <section className="statistics-panel" aria-labelledby="workbenches-title"><header><h2 id="workbenches-title">{t("common.workbenches")}</h2><p>{t("statistics.eachGoalIsCountedOnceHoverForUsageDetails")}</p></header><div className="statistics-table-scroll"><table className="statistics-table"><thead><tr><th>{t("common.workbenches")}</th><th>{t("statistics.totalTokens")}</th><th>{t("statistics.completed")}</th><th>{t("statistics.failed")}</th><th>{t("statistics.waiting")}</th></tr></thead><tbody>{data.workbenches.map((item) => { const tip = t("statistics.valueValueValueTotalTokensInputValueOutputValue", { p0: item.name, p1: (item.archived ? t("statistics.archived") : ""), p2: exactValue(item.total, item), p3: exactValue(item.input, item), p4: exactValue(item.output, item), p5: String(item.completedGoals), p6: String(item.failedGoals), p7: String(item.waitingGoals), p8: (item.unknownRecords > 0 ? t("statistics.valueUnknownUsagebc8a20", { p0: formatNumber(item.unknownRecords) }) : "") }); return <Tooltip content={tip} key={item.workbenchId}><tr><th>{item.name}{item.archived ? <small>{t("common.archived")}</small> : null}</th><td>{knownValue(item.total, item)}</td><td>{item.completedGoals}</td><td>{item.failedGoals}</td><td>{item.waitingGoals}</td></tr></Tooltip>; })}</tbody></table></div>
      <div className="statistics-goals"><h3>{t("statistics.top10Goals")}</h3>{data.goals.slice(0, 10).map((goal, index) => { const statusLabel = ({ canceled: t("status.canceled"), completed: t("status.completed"), failed: t("statistics.failed"), running: t("status.inProgress"), waiting: t("status.waiting") })[goal.status]; const tip = t("statistics.valueValueValueValueTotalTokensInputValueOutputb38516", { p0: goal.title, p1: goal.workbenchName, p2: statusLabel, p3: exactValue(goal.total, goal), p4: exactValue(goal.input, goal), p5: exactValue(goal.output, goal), p6: formatNumber(goal.records), p7: (goal.unknownRecords > 0 ? t("statistics.valueUnknownUsagebc8a20", { p0: formatNumber(goal.unknownRecords) }) : "") }); return <Tooltip content={tip} key={goal.goalId}><button aria-label={t("statistics.openGoalValue", { p0: goal.title })} onClick={() => onOpenGoal(goal.goalId)} type="button"><span>{String(index + 1).padStart(2, "0")}</span><span><strong>{goal.title}</strong><small>{goal.workbenchName} · {statusLabel}</small></span><b>{knownValue(goal.total, goal)}</b></button></Tooltip>; })}</div>
    </section>

    <section className="statistics-panel statistics-completeness" aria-labelledby="completeness-title"><header><h2 id="completeness-title">{t("statistics.dataCompleteness")}</h2><p>{t("statistics.unknownMeansTheProviderDidNotReturnUsableUsage")}</p></header><div className="statistics-completeness-grid"><div><span>{t("statistics.knownUsageCoverage")}</span><strong>{completeness === null ? t("statistics.unknown") : `${String(completeness)}%`}</strong></div><div><span>{t("statistics.knownRecords")}</span><strong>{formatNumber(data.overview.knownRecords)}</strong></div><div><span>{t("statistics.unknownRecords")}</span><strong>{formatNumber(data.overview.unknownRecords)}</strong></div><div><span>{t("statistics.failedRecords")}</span><strong>{formatNumber(data.overview.failedRecords)}</strong></div><div><span>{t("statistics.knownCacheBreakdown")}</span><strong>{formatNumber(data.overview.cacheKnownRecords)}</strong></div><div><span>{t("statistics.knownReasoningBreakdown")}</span><strong>{formatNumber(data.overview.reasoningKnownRecords)}</strong></div></div><footer>{t("statistics.collectionStarted")} {new Date(data.collectedSince).toLocaleString(currentLocale())}  {t("statistics.updated")} {new Date(data.updatedAt).toLocaleString(currentLocale())}</footer></section>
  </section>;
}
