import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRightIcon, CaretDownIcon, CheckCircleIcon, CircleIcon, CopyIcon, FlagIcon, ProhibitIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { JoiGoalMapDetailDto, JoiGoalMapPathDto } from "../shared/joi.js";
import { t, useI18n } from "./i18n";

export function GoalTitle({ title, fullTitle }: { title: string; fullTitle?: string }) {
  useI18n();
  const tooltipId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const anchor = useRef({ x: 0, y: 0, gap: 12 });
  const pinned = useRef(false);
  const copying = useRef(false);
  const suppressPreview = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState<"copied" | "failed" | null>(null);
  const placeOverlay = useCallback(() => {
    if (overlay.current === null) return;
    const { width, height } = overlay.current.getBoundingClientRect();
    const { x, y, gap } = anchor.current;
    const left = x + gap + width <= window.innerWidth - 12 ? x + gap : x - width - gap;
    const top = y + gap + height <= window.innerHeight - 12 ? y + gap : y - height - gap;
    overlay.current.style.left = `${String(Math.max(12, Math.min(left, window.innerWidth - width - 12)))}px`;
    overlay.current.style.top = `${String(Math.max(12, Math.min(top, window.innerHeight - height - 12)))}px`;
  }, []);
  function keyboardAnchor() {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect !== undefined) anchor.current = { x: rect.left, y: rect.bottom, gap: 8 };
  }
  const close = useCallback(() => { pinned.current = false; setMenu(false); setPreview(false); }, []);
  useLayoutEffect(() => { placeOverlay(); }, [menu, preview, fullTitle, placeOverlay]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!menu && !preview) return;
    if (menu) copyButton.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !overlay.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", close); };
  }, [menu, preview, close]);
  async function copy() {
    if (fullTitle === undefined || copying.current) return;
    copying.current = true;
    let showText = false;
    try { await navigator.clipboard.writeText(fullTitle); setNotice("copied"); }
    catch { setNotice("failed"); showText = true; }
    finally {
      copying.current = false; setMenu(false);
      suppressPreview.current = true; trigger.current?.focus(); suppressPreview.current = false;
      clearTimeout(hideTimer.current); pinned.current = showText; setPreview(showText);
    }
  }
  return <div className="joi-full-title" ref={root} onMouseEnter={() => clearTimeout(hideTimer.current)}
    onMouseLeave={() => { if (!pinned.current) hideTimer.current = setTimeout(() => { if (!pinned.current) setPreview(false); }, 180); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && (preview || menu)) { event.stopPropagation(); suppressPreview.current = true; trigger.current?.focus(); suppressPreview.current = false; close(); }
    }}>
    <h1><button className="joi-full-title-trigger" ref={trigger} type="button"
      aria-describedby={preview && fullTitle !== undefined ? tooltipId : undefined} aria-haspopup="menu" aria-expanded={menu}
      onMouseEnter={(event) => { if (!menu && !pinned.current) { anchor.current = { x: event.clientX, y: event.clientY, gap: 12 }; setPreview(true); placeOverlay(); } }}
      onMouseMove={(event) => { if (!menu && !pinned.current) { anchor.current = { x: event.clientX, y: event.clientY, gap: 12 }; placeOverlay(); } }}
      onFocus={() => { clearTimeout(hideTimer.current); if (!suppressPreview.current) { keyboardAnchor(); setPreview(true); } }}
      onClick={(event) => { if (event.detail === 0) keyboardAnchor(); else anchor.current = { x: event.clientX, y: event.clientY, gap: 12 }; pinned.current = true; setPreview(true); placeOverlay(); }}
      onContextMenu={(event) => { event.preventDefault(); clearTimeout(hideTimer.current); if (event.clientX === 0 && event.clientY === 0) keyboardAnchor(); else anchor.current = { x: event.clientX, y: event.clientY, gap: 0 }; setMenu(true); setPreview(false); placeOverlay(); }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); clearTimeout(hideTimer.current); keyboardAnchor(); setMenu(true); setPreview(false); }
      }}>{title}</button></h1>
    {preview && !menu && fullTitle !== undefined ? <div ref={overlay} className="joi-full-title-preview" id={tooltipId} role="tooltip" tabIndex={0}
      onPointerDown={() => { pinned.current = true; clearTimeout(hideTimer.current); }}>{fullTitle}</div> : null}
    {menu ? <div ref={overlay} className="joi-title-menu" role="menu" aria-label={t("home.goalTitleActions")}>
      <button ref={copyButton} disabled={fullTitle === undefined} onClick={() => void copy()} role="menuitem" type="button"><CopyIcon aria-hidden size={16} />{t("export.copyFullText")}</button>
      {fullTitle === undefined ? <small>{t("home.fullTitleNotLoaded")}</small> : null}
    </div> : null}
    {notice === null ? null : <p className={`joi-title-notice ${notice}`} role={notice === "failed" ? "alert" : "status"}>{notice === "copied" ? t("export.fullTextCopied") : t("home.titleCopyFailed")}</p>}
  </div>;
}

function pathStatus(path: JoiGoalMapPathDto) {
  return path.status === "OPEN" ? t("home.mapPathOpen") : path.status === "CLOSED" ? t("home.mapPathClosed") : t("home.mapPathOutOfScope");
}

function workStatus(status: NonNullable<JoiGoalMapPathDto["workStatus"]>) {
  const labels = {
    PLANNED: "home.mapWorkPlanned", READY: "home.mapWorkReady", RUNNING: "home.mapWorkRunning", WAITING: "home.mapWorkWaiting",
    COMPLETED: "home.mapWorkCompleted", FAILED: "home.mapWorkFailed", CANCELED: "home.mapWorkCanceled",
  } as const;
  return t(labels[status]);
}

export function GoalMap({ harness, hasMore = false, busy = false, failed = false, onLoadMore, onRetry }: {
  harness: JoiGoalMapDetailDto; hasMore?: boolean; busy?: boolean; failed?: boolean; onLoadMore?: () => void; onRetry?: () => void;
}) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  const [visited, setVisited] = useState(false);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [tab, setTab] = useState<"paths" | "decisions" | "fog">("paths");
  const [layerOverrides, setLayerOverrides] = useState<Record<number, boolean>>({});
  const root = useRef<HTMLElement>(null);
  const pathDetail = useRef<HTMLElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef({ paths: 0, decisions: 0, fog: 0 });
  const pathId = useId();
  const detailsId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const selected = harness.paths.find((path) => path.pathId === selectedPathId);
  const decision = harness.decisions.find((item) => item.decisionId === selected?.resolvedDecisionId);
  const layers = [...new Set(harness.paths.map((path) => path.layer))].sort((a, b) => b - a);
  useLayoutEffect(() => { if (scrollArea.current !== null) scrollArea.current.scrollTop = scrollPositions.current[tab]; }, [tab, visited]);
  function selectPath(id: string) {
    const path = harness.paths.find((item) => item.pathId === id);
    if (path === undefined) return;
    setSelectedPathId(id);
    setTab("paths");
    setLayerOverrides((previous) => ({ ...previous, [path.layer]: true }));
    requestAnimationFrame(() => {
      const node = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-path-id]") ?? []).find((node) => node.dataset.pathId === id);
      node?.focus({ preventScroll: true }); pathDetail.current?.scrollIntoView({ block: "nearest" });
    });
  }
  return <article ref={root} className="joi-route-map" role="region" aria-label={t("home.goalRouteMap")}>
    <div className="joi-route-map-heading"><h2><FlagIcon aria-hidden size={18} />{t("home.goalRouteMap")}</h2>
      <span className={`joi-route-map-status ${harness.mapStatus.toLowerCase()}`}>{harness.mapStatus === "CLEARED" ? <CheckCircleIcon aria-hidden /> : <CircleIcon aria-hidden />}{harness.mapStatus === "CLEARED" ? t("home.routeMapCleared") : t("home.routeMapActive")}</span>
    </div>
    <div className="joi-route-destination compact"><small>{t("home.routeDestination")}</small><p>{harness.destination ?? t("home.unnamedDestinationJoiWillNameItDuringReview")}</p></div>
    <p className="joi-route-counts">{t("home.routeMapCounts", { paths: String(harness.pathCount), decisions: String(harness.decisionCount), fog: String(harness.fogCount) })}</p>
    <div className="joi-route-overview-actions"><small>{harness.pathCount === 0 ? t("home.routeMapEmpty") : t("home.routeCurrentLayer", { layer: String(harness.currentLayer) })}</small>
      <button ref={toggle} className="button ghost" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => {
        setVisited(true); setExpanded(!expanded);
        if (expanded) requestAnimationFrame(() => toggle.current?.scrollIntoView({ block: "nearest" }));
      }}>{expanded ? t("home.routeCollapse") : t("home.routeExpand")}<CaretDownIcon aria-hidden className={expanded ? "expanded" : ""} /></button>
    </div>
    {failed && !expanded ? <p className="joi-detail-load-notice" role="alert">{t("home.goalDetailLoadFailed")} <button className="button ghost" disabled={busy} onClick={onRetry} type="button">{t("common.retry")}</button></p> : null}
    <div id={detailsId} className="joi-route-expanded" hidden={!expanded}>{visited ? <>
    <div className="joi-route-tabs" role="group" aria-label={t("home.routeDetails")}>
      <button aria-pressed={tab === "paths"} type="button" onClick={() => setTab("paths")}>{t("home.routePaths")} <span>{harness.pathCount}</span></button>
      <button aria-pressed={tab === "decisions"} type="button" onClick={() => setTab("decisions")}>{t("home.routeDecisions")} <span>{harness.decisionCount}</span></button>
      <button aria-pressed={tab === "fog"} type="button" onClick={() => setTab("fog")}>{t("home.routeFog")} <span>{harness.fogCount}</span></button>
    </div>
    <div ref={scrollArea} className="joi-route-detail-scroll" tabIndex={0} role="region" aria-label={t("home.routeDetails")}
      onScroll={(event) => { scrollPositions.current[tab] = event.currentTarget.scrollTop; }}>
    <p className="joi-route-detail-destination">{harness.destination ?? t("home.unnamedDestinationJoiWillNameItDuringReview")}</p>
    <p className="joi-route-loaded">{t("home.routeLoaded", { loaded: String(tab === "paths" ? harness.paths.length : tab === "decisions" ? harness.decisions.length : harness.fog.length), total: String(tab === "paths" ? harness.pathCount : tab === "decisions" ? harness.decisionCount : harness.fogCount) })}</p>
    <div hidden={tab !== "paths"}>
    {layers.length === 0 ? <p className="plain-empty">{harness.pathCount === 0 ? t("home.routeMapEmpty") : t("home.routeRelatedNotLoaded")}</p> : <div className="joi-route-layers">
      {layers.map((layer) => <details className="joi-route-layer" key={layer} open={layerOverrides[layer] ?? layer === harness.currentLayer}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setLayerOverrides((previous) => previous[layer] === open ? previous : { ...previous, [layer]: open });
        }}>
        <summary><span aria-hidden="true" className="joi-route-layer-number">{layer}</span><strong>{t("home.routeLayer", { layer: String(layer) })}</strong>{layer === harness.currentLayer ? <small>{t("home.routeLatestLayer")}</small> : null}</summary>
        <div className="joi-route-nodes">{harness.paths.filter((path) => path.layer === layer).map((path) => <button
          className={`joi-route-node ${path.status.toLowerCase()} ${path.workStatus === "FAILED" ? "work-failed" : ""}`} key={path.pathId} data-path-id={path.pathId}
          aria-pressed={path.pathId === selectedPathId} aria-controls={selected === undefined ? undefined : pathId} onClick={() => {
            setSelectedPathId((value) => value === path.pathId ? null : path.pathId);
            requestAnimationFrame(() => pathDetail.current?.scrollIntoView({ block: "nearest" }));
          }} type="button">
          <span className="joi-route-node-state">{path.status === "OPEN" ? <CircleIcon aria-hidden /> : path.status === "CLOSED" ? <CheckCircleIcon aria-hidden /> : <ProhibitIcon aria-hidden />}{pathStatus(path)}</span>
          <strong>{path.title}</strong>
          {path.workStatus === undefined ? null : <span className={`joi-route-work-status ${path.workStatus.toLowerCase()}`}>{path.workStatus === "FAILED" ? <WarningCircleIcon aria-hidden /> : null}{workStatus(path.workStatus)}</span>}
        </button>)}</div>
        {selected?.layer !== layer ? null : <section ref={pathDetail} className="joi-route-path-detail" id={pathId} aria-label={t("home.routePathDetails")}>
          <h3>{selected.title}</h3><p>{pathStatus(selected)}{selected.workStatus === undefined ? "" : ` · ${workStatus(selected.workStatus)}`}</p>
          {decision === undefined ? selected.resolvedDecisionId === undefined ? null : <p>{t("home.routeRelatedNotLoaded")}</p> : <div><strong>{decision.summary}</strong>{decision.detail === "" ? null : <p>{decision.detail}</p>}</div>}
          {harness.fog.filter((fog) => fog.graduatedPathId === selected.pathId).map((fog) => <p key={fog.fogId}>{t("home.routePromotedFromFog", { note: fog.note })}</p>)}
        </section>}
      </details>)}
    </div>}
    </div>
      <div className="joi-route-note-list" hidden={tab !== "decisions"}>
        {harness.decisions.length === 0 ? <p>{harness.decisionCount === 0 ? t("home.routeNoDecisions") : t("home.routeRelatedNotLoaded")}</p> : harness.decisions.map((item) => <details key={item.decisionId}><summary>{item.summary}</summary><p>{item.detail || item.summary}</p></details>)}
      </div><div className="joi-route-note-list" hidden={tab !== "fog"}>
        {harness.fog.length === 0 ? <p>{harness.fogCount === 0 ? t("home.routeNoFog") : t("home.routeRelatedNotLoaded")}</p> : harness.fog.map((fog) => <div className="joi-route-fog" key={fog.fogId}><p>{fog.note}</p>
          <small>{fog.status === "ACTIVE" ? t("home.routeFogActive") : t("home.routeFogGraduated")}</small>
          {fog.graduatedPathId === undefined ? null : <button className="button ghost" disabled={!harness.paths.some((path) => path.pathId === fog.graduatedPathId)} title={harness.paths.some((path) => path.pathId === fog.graduatedPathId) ? undefined : t("home.routeLoadMore")} onClick={() => { if (fog.graduatedPathId !== undefined) selectPath(fog.graduatedPathId); }} type="button"><ArrowUpRightIcon aria-hidden />{t("home.routeViewPromotedPath")}</button>}
        </div>)}
      </div>
    </div>
    <div className="joi-route-detail-footer">
      {failed ? <p className="joi-detail-load-notice" role="alert">{t("home.goalDetailLoadFailed")} <button className="button ghost" disabled={busy} onClick={onRetry} type="button">{t("common.retry")}</button></p> : null}
      {hasMore ? <button className="button ghost joi-route-load-more" disabled={busy} onClick={onLoadMore} type="button">{t("home.routeLoadMore")}</button> : null}
    </div>
    </> : null}</div>
  </article>;
}
