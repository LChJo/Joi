import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { JoiGoalCardDto } from "../shared/joi";
import type { GoalResultDto, GoalResultSummaryDto } from "../shared/goal-results";
import type { DigitalLifeApi } from "./api";
import { ResultExportMenu } from "./ResultExportMenu";
import { currentLocale, t, useI18n } from "./i18n";

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => href !== undefined && /^https?:\/\//iu.test(href) ? <a href={href} rel="noreferrer" target="_blank">{children}</a> : <span>{children}</span>,
  img: ({ alt }) => <span className="agent-remote-image">{t("home.image")}{alt === undefined ? "" : `：${alt}`}]</span>,
};
const MARKDOWN_PLUGINS = [remarkGfm];
const HistoryMarkdown = memo(function HistoryMarkdown({ body }: { body: string }) {
  useI18n();
  return <ReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={MARKDOWN_PLUGINS} skipHtml>{body}</ReactMarkdown>;
});

function statusLabel(status: GoalResultSummaryDto["status"]) {
  return status === "COMPLETED_WITH_GAPS" ? t("home.completedWithGaps") : t("status.completed");
}

export function GoalResultHistory({ api, goal, onClose, lockPage = true }: { api: DigitalLifeApi; goal: JoiGoalCardDto; onClose: () => void; lockPage?: boolean }) {
  useI18n();
  const [items, setItems] = useState<GoalResultSummaryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<GoalResultSummaryDto | null>(null);
  const [result, setResult] = useState<GoalResultDto | null>(null);
  const [readerBusy, setReaderBusy] = useState(false);
  const [readerFailed, setReaderFailed] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const alive = useRef(true);
  const pageRunning = useRef(false);
  const readerGeneration = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const loadPage = useCallback(async (cursor?: string) => {
    if (pageRunning.current) return;
    pageRunning.current = true;
    setLoading(true); setFailed(false);
    try {
      const page = await api.joiGoalResults(goal.goalId, { limit: 20, ...(cursor === undefined ? {} : { cursor }) });
      if (!alive.current) return;
      setItems(current => cursor === undefined ? page.items : [...current, ...page.items.filter(item => !current.some(existing => existing.resultId === item.resultId))]);
      setNextCursor(page.nextCursor);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      pageRunning.current = false;
      if (alive.current) setLoading(false);
    }
  }, [api, goal.goalId]);
  useEffect(() => {
    alive.current = true;
    const initial = setTimeout(() => void loadPage(), 0);
    return () => { clearTimeout(initial); alive.current = false; };
  }, [loadPage]);
  const read = async (item: GoalResultSummaryDto) => {
    if (list.current !== null) listScroll.current = list.current.scrollTop;
    const generation = ++readerGeneration.current;
    setSelected(item); setResult(null); setReaderBusy(true); setReaderFailed(false); setExportMenu(false);
    try {
      const snapshot = await api.joiGoalResult(goal.goalId, item.resultId);
      if (alive.current && generation === readerGeneration.current) setResult(snapshot);
    } catch {
      if (alive.current && generation === readerGeneration.current) setReaderFailed(true);
    } finally {
      if (alive.current && generation === readerGeneration.current) setReaderBusy(false);
    }
  };
  const backToList = useCallback(() => {
    readerGeneration.current++;
    setSelected(null); setResult(null); setReaderBusy(false); setReaderFailed(false); setExportMenu(false);
  }, []);
  useLayoutEffect(() => {
    if (selected === null && list.current !== null) list.current.scrollTop = listScroll.current;
  }, [selected]);
  useEffect(() => {
    if (!lockPage) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, [lockPage]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (exportMenu) setExportMenu(false);
      else if (selected !== null) backToList();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [backToList, exportMenu, onClose, selected]);
  const close = () => { if (exportMenu) setExportMenu(false); else onClose(); };
  return <div className="joi-drawer-backdrop" onClick={close} role="presentation">
    <section aria-label={t("home.resultHistory")} aria-modal="true" className={`joi-goal-drawer joi-history-drawer${selected === null ? "" : " joi-result-drawer"}`} onClick={event => { event.stopPropagation(); setExportMenu(false); }} role="dialog">
      <header className="joi-goal-detail-header">
        <div className="joi-goal-detail-title">
          <p className="eyebrow">{goal.workbench.name}</p>
          <h1>{t("home.resultHistory")}</h1>
          {selected === null ? <p className="joi-history-goal-title">{goal.title}</p> : <span className="joi-goal-detail-meta"><span className="joi-goal-status completed">{statusLabel(selected.status)}</span><time className="joi-feed-time" dateTime={selected.completedAt}>{t("home.resultAt", { p0: new Date(selected.completedAt).toLocaleString(currentLocale()) })}</time></span>}
        </div>
        <div className="row-actions">
          {selected === null ? null : <button className="button ghost" onClick={backToList} type="button"><ArrowLeftIcon aria-hidden />{t("home.backToResultHistory")}</button>}
          <button className="button quiet" onClick={close} type="button">{t("common.close")}</button>
        </div>
      </header>
      {selected === null ? <div className="joi-goal-drawer-body joi-history-list" ref={list} aria-busy={loading}>
        {items.length === 0 && !loading && !failed ? <p className="content-state">{t("home.noResultHistory")}</p> : null}
        {items.map((item, index) => <button className="joi-history-entry" key={item.resultId} onClick={() => void read(item)} type="button">
          <span><time dateTime={item.completedAt}>{t("home.resultAt", { p0: new Date(item.completedAt).toLocaleString(currentLocale()) })}</time><span className="joi-history-entry-status">{statusLabel(item.status)}{index === 0 ? <small>{t("home.latestResult")}</small> : null}</span></span><ArrowUpRightIcon aria-hidden />
        </button>)}
        {loading ? <p className="content-state" role="status">{t("home.loading")}</p> : null}
        {failed ? <p className="joi-detail-load-notice" role="alert">{t("home.historyLoadFailed")} <button className="button ghost" onClick={() => void loadPage(nextCursor)} type="button">{t("common.retry")}</button></p> : null}
        {nextCursor === undefined || failed ? null : <button className="button ghost joi-history-more" disabled={loading} onClick={() => void loadPage(nextCursor)} type="button">{t("home.loadMoreResults")}</button>}
      </div> : <div className="joi-goal-drawer-body" aria-busy={readerBusy}>
        {readerBusy ? <p className="content-state" role="status">{t("home.loading")}</p> : null}
        {readerFailed ? <p className="joi-detail-load-notice" role="alert">{t("home.historyLoadFailed")} <button className="button ghost" onClick={() => void read(selected)} type="button">{t("common.retry")}</button></p> : null}
        {result === null ? null : <article className="joi-goal-result"><div className="joi-md"><HistoryMarkdown body={result.body} /></div></article>}
      </div>}
      {result === null ? null : <ResultExportMenu api={api} goalId={goal.goalId} resultId={result.resultId} body={result.body} expanded={exportMenu} onExpanded={setExportMenu} />}
    </section>
  </div>;
}
