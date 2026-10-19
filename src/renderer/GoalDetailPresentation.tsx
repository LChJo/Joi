import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRightIcon, CheckCircleIcon, CircleIcon, CopyIcon, FlagIcon, ProhibitIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { JoiGoalMapDetailDto, JoiGoalMapPathDto } from "../shared/joi.js";
import { t, useI18n } from "./i18n";

export function GoalTitle({ title, fullTitle }: { title: string; fullTitle?: string }) {
  useI18n();
  const tooltipId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const copying = useRef(false);
  const suppressPreview = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState<"copied" | "failed" | null>(null);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!menu && !preview) return;
    if (menu) copyButton.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) { setMenu(false); setPreview(false); } };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu, preview]);
  async function copy() {
    if (fullTitle === undefined || copying.current) return;
    copying.current = true;
    let showText = false;
    try { await navigator.clipboard.writeText(fullTitle); setNotice("copied"); }
    catch { setNotice("failed"); showText = true; }
    finally {
      copying.current = false; setMenu(false);
      suppressPreview.current = true; trigger.current?.focus(); suppressPreview.current = false;
      setPreview(showText);
    }
  }
  return <div className="joi-full-title" ref={root} onMouseEnter={() => clearTimeout(hideTimer.current)}
    onMouseLeave={() => { hideTimer.current = setTimeout(() => setPreview(false), 180); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setPreview(false); setMenu(false); } }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && (preview || menu)) { event.stopPropagation(); suppressPreview.current = true; trigger.current?.focus(); suppressPreview.current = false; setPreview(false); setMenu(false); }
    }}>
    <h1><button className="joi-full-title-trigger" ref={trigger} type="button"
      aria-describedby={preview && fullTitle !== undefined ? tooltipId : undefined} aria-haspopup="menu" aria-expanded={menu}
      onMouseEnter={() => setPreview(true)} onFocus={() => { clearTimeout(hideTimer.current); if (!suppressPreview.current) setPreview(true); }} onClick={() => setPreview(true)}
      onContextMenu={(event) => { event.preventDefault(); setMenu(true); setPreview(false); }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); setMenu(true); setPreview(false); }
      }}>{title}</button></h1>
    {preview && !menu && fullTitle !== undefined ? <div className="joi-full-title-preview" id={tooltipId} role="tooltip" tabIndex={0}>{fullTitle}</div> : null}
    {menu ? <div className="joi-title-menu" role="menu" aria-label={t("home.goalTitleActions")}>
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

export function GoalMap({ harness }: { harness: JoiGoalMapDetailDto }) {
  useI18n();
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [tab, setTab] = useState<"decisions" | "fog">("decisions");
  const [layerOverrides, setLayerOverrides] = useState<Record<number, boolean>>({});
  const root = useRef<HTMLElement>(null);
  const pathId = useId();
  const selected = harness.paths.find((path) => path.pathId === selectedPathId);
  const decision = harness.decisions.find((item) => item.decisionId === selected?.resolvedDecisionId);
  const layers = [...new Set(harness.paths.map((path) => path.layer))].sort((a, b) => a - b);
  function selectPath(id: string) {
    const path = harness.paths.find((item) => item.pathId === id);
    if (path === undefined) return;
    setSelectedPathId(id);
    setLayerOverrides((previous) => ({ ...previous, [path.layer]: true }));
    requestAnimationFrame(() => Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-path-id]") ?? []).find((node) => node.dataset.pathId === id)?.focus());
  }
  return <article ref={root} className="joi-route-map" role="region" aria-label={t("home.goalRouteMap")}>
    <div className="joi-route-map-heading"><h2><FlagIcon aria-hidden size={18} />{t("home.goalRouteMap")}</h2>
      <span className={`joi-route-map-status ${harness.mapStatus.toLowerCase()}`}>{harness.mapStatus === "CLEARED" ? <CheckCircleIcon aria-hidden /> : <CircleIcon aria-hidden />}{harness.mapStatus === "CLEARED" ? t("home.routeMapCleared") : t("home.routeMapActive")}</span>
    </div>
    <div className="joi-route-destination"><small>{t("home.routeDestination")}</small><p>{harness.destination ?? t("home.unnamedDestinationJoiWillNameItDuringReview")}</p></div>
    <p className="joi-route-counts">{t("home.routeMapCounts", { paths: String(harness.pathCount), decisions: String(harness.decisionCount), fog: String(harness.fogCount) })}</p>
    {layers.length === 0 ? <p className="plain-empty">{t("home.routeMapEmpty")}</p> : <div className="joi-route-layers">
      {layers.map((layer) => <details className="joi-route-layer" key={layer} open={layerOverrides[layer] ?? layer === harness.currentLayer}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setLayerOverrides((previous) => previous[layer] === open ? previous : { ...previous, [layer]: open });
        }}>
        <summary><span aria-hidden="true" className="joi-route-layer-number">{layer}</span><strong>{t("home.routeLayer", { layer: String(layer) })}</strong>{layer === harness.currentLayer ? <small>{t("home.routeLatestLayer")}</small> : null}</summary>
        <div className="joi-route-nodes">{harness.paths.filter((path) => path.layer === layer).map((path) => <button
          className={`joi-route-node ${path.status.toLowerCase()} ${path.workStatus === "FAILED" ? "work-failed" : ""}`} key={path.pathId} data-path-id={path.pathId}
          aria-pressed={path.pathId === selectedPathId} aria-controls={selected === undefined ? undefined : pathId} onClick={() => setSelectedPathId((value) => value === path.pathId ? null : path.pathId)} type="button">
          <span className="joi-route-node-state">{path.status === "OPEN" ? <CircleIcon aria-hidden /> : path.status === "CLOSED" ? <CheckCircleIcon aria-hidden /> : <ProhibitIcon aria-hidden />}{pathStatus(path)}</span>
          <strong>{path.title}</strong>
          {path.workStatus === undefined ? null : <span className={`joi-route-work-status ${path.workStatus.toLowerCase()}`}>{path.workStatus === "FAILED" ? <WarningCircleIcon aria-hidden /> : null}{workStatus(path.workStatus)}</span>}
        </button>)}</div>
      </details>)}
    </div>}
    {selected === undefined ? null : <section className="joi-route-path-detail" id={pathId} aria-label={t("home.routePathDetails")}>
      <h3>{selected.title}</h3><p>{pathStatus(selected)}{selected.workStatus === undefined ? "" : ` · ${workStatus(selected.workStatus)}`}</p>
      {decision === undefined ? null : <div><strong>{decision.summary}</strong>{decision.detail === "" ? null : <p>{decision.detail}</p>}</div>}
      {harness.fog.filter((fog) => fog.graduatedPathId === selected.pathId).map((fog) => <p key={fog.fogId}>{t("home.routePromotedFromFog", { note: fog.note })}</p>)}
    </section>}
    <div className="joi-route-notes">
      <div className="joi-route-tabs" role="group" aria-label={t("home.routeNotes")}>
        <button aria-pressed={tab === "decisions"} type="button" onClick={() => setTab("decisions")}>{t("home.routeDecisions")} <span>{harness.decisionCount}</span></button>
        <button aria-pressed={tab === "fog"} type="button" onClick={() => setTab("fog")}>{t("home.routeFog")} <span>{harness.fogCount}</span></button>
      </div>
      {tab === "decisions" ? <div className="joi-route-note-list">
        {harness.decisions.length === 0 ? <p>{t("home.routeNoDecisions")}</p> : harness.decisions.map((item) => <details key={item.decisionId}><summary>{item.summary}</summary><p>{item.detail || item.summary}</p></details>)}
      </div> : <div className="joi-route-note-list">
        {harness.fog.length === 0 ? <p>{t("home.routeNoFog")}</p> : harness.fog.map((fog) => <div className="joi-route-fog" key={fog.fogId}><p>{fog.note}</p>
          <small>{fog.status === "ACTIVE" ? t("home.routeFogActive") : t("home.routeFogGraduated")}</small>
          {fog.graduatedPathId === undefined ? null : <button className="button ghost" disabled={!harness.paths.some((path) => path.pathId === fog.graduatedPathId)} title={harness.paths.some((path) => path.pathId === fog.graduatedPathId) ? undefined : t("home.routeLoadMore")} onClick={() => { if (fog.graduatedPathId !== undefined) selectPath(fog.graduatedPathId); }} type="button"><ArrowUpRightIcon aria-hidden />{t("home.routeViewPromotedPath")}</button>}
        </div>)}
      </div>}
    </div>
  </article>;
}
