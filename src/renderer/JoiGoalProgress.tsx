import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClockIcon, PulseIcon, XIcon } from "@phosphor-icons/react";
import type { JoiGoalProgressDto, JoiGoalTurnProgressDto } from "../shared/joi.js";
import { t, useI18n } from "./i18n.js";

const STATE_KEYS = {
  QUEUED: "home.joiProgressQueued", RUNNING: "home.joiProgressRunning", WAITING_PARTNERS: "home.joiProgressPartners",
  WAITING_USER: "home.joiProgressUser", RECOVERING: "home.joiProgressRecovering", IDLE: "home.joiProgressIdle",
  COMPLETED: "home.joiProgressCompleted", FAILED: "home.joiProgressFailed", CANCELED: "home.joiProgressCanceled",
} as const;
const HINT_KEYS = {
  QUEUED: "home.joiProgressQueuedHint", RUNNING: "home.joiProgressRunningHint", WAITING_PARTNERS: "home.joiProgressPartnersHint",
  WAITING_USER: "home.joiProgressUserHint", RECOVERING: "home.joiProgressRecoveringHint", IDLE: "home.joiProgressIdleHint",
  COMPLETED: "home.joiProgressCompletedHint", FAILED: "home.joiProgressFailedHint", CANCELED: "home.joiProgressCanceledHint",
} as const;
const STAGE_KEYS = {
  PLANNING: "home.joiProgressPlanning", FINALIZING: "home.joiProgressFinalizing",
  REVIEWING: "home.joiProgressReviewing", RECOVERING: "home.joiProgressRecovery",
} as const;
const TURN_KEYS = {
  PENDING: "home.joiProgressQueued", RUNNING: "home.joiProgressRunning", WAITING: "home.joiProgressTurnWaiting",
  COMPLETED: "home.joiProgressTurnCompleted", FAILED: "home.joiProgressTurnFailed", ABORTED: "home.joiProgressTurnAborted",
} as const;

function duration(start: string, end: number): string {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1_000));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return t("home.joiProgressSeconds", { value: String(seconds) });
  if (seconds < 3_600) return t("home.joiProgressMinutes", { value: String(Math.floor(seconds / 60)) });
  return t("home.joiProgressHours", { value: String(Math.floor(seconds / 3_600)), minutes: String(Math.floor(seconds / 60) % 60) });
}

export function JoiGoalProgress({ progress, failed, busy, onRetry }: {
  progress?: JoiGoalProgressDto; failed: boolean; busy: boolean; onRetry?: (() => void) | undefined;
}) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const opener = trigger.current;
    close.current?.focus();
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) close.current?.focus();
    };
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("focusin", focus);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);
  const time = (value: string) => Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "—";
  return <>
    <button ref={trigger} className="button ghost joi-progress-open" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <PulseIcon aria-hidden size={16} />{t("home.joiProgressOpen")}
    </button>
    {open ? createPortal(<div className="joi-progress-backdrop" onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) setOpen(false); }}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className="joi-progress-dialog" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        if (event.key === "Tab") {
          const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),[tabindex='0']") ?? []);
          const first = focusable[0]; const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <header className="joi-progress-header"><h2 id={titleId}><PulseIcon aria-hidden size={20} />{t("home.joiProgressTitle")}</h2>
          <button ref={close} className="icon-button" type="button" aria-label={t("home.joiProgressClose")} onClick={() => setOpen(false)}><XIcon aria-hidden size={18} /></button>
        </header>
        <div className="joi-progress-body" tabIndex={0} role="region" aria-label={t("home.joiProgressTitle")}>
          {progress === undefined ? <p className="plain-empty">{t("home.joiProgressUnavailable")}</p> : <ProgressFacts progress={progress} time={time} />}
          {failed ? <p className="joi-detail-load-notice" role="alert">{t("home.joiProgressRefreshFailed")} <button className="button ghost" type="button" disabled={busy} onClick={onRetry}>{t("common.retry")}</button></p> : null}
        </div>
      </section>
    </div>, document.body) : null}
  </>;
}

function ProgressFacts({ progress, time }: { progress: JoiGoalProgressDto; time: (value: string) => string }) {
  useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  const live = progress.recentTurns.find((turn) => ["RUNNING", "WAITING", "PENDING"].includes(turn.status));
  const terminal = ["COMPLETED", "FAILED", "CANCELED"].includes(progress.state);
  const end = terminal ? Date.parse(progress.updatedAt) : now;
  return <>
    <div className={`joi-progress-current ${progress.state.toLowerCase()}`}>
      <span className="joi-progress-state">{t(STATE_KEYS[progress.state])}</span>
      {progress.stage === undefined ? null : <h3>{t(STAGE_KEYS[progress.stage])}</h3>}
      <p>{t(HINT_KEYS[progress.state])}</p>
      <small><ClockIcon aria-hidden size={14} />{live !== undefined && !terminal
        ? t("home.joiProgressCurrentElapsed", { duration: duration(live.startedAt, now) })
        : t("home.joiProgressElapsed", { duration: duration(progress.startedAt, end) })}</small>
    </div>
    <dl className="joi-progress-times">
      <div><dt>{t("home.joiProgressUpdated")}</dt><dd><time dateTime={progress.updatedAt}>{time(progress.updatedAt)}</time></dd></div>
      <div><dt>{t("home.joiProgressStarted")}</dt><dd><time dateTime={progress.startedAt}>{time(progress.startedAt)}</time></dd></div>
    </dl>
    {!terminal && now - Date.parse(progress.updatedAt) >= 60_000 ? <p className="joi-progress-quiet">{t("home.joiProgressQuiet", { duration: duration(progress.updatedAt, now) })}</p> : null}
    <div className="joi-progress-counts"><p>{t("home.joiProgressCounts", { turns: String(progress.turnCount), reviews: String(progress.reviewCount) })}</p>
      <p>{t("home.joiProgressWork", { completed: String(progress.work.completed), active: String(progress.work.active), failed: String(progress.work.failed), total: String(progress.work.total) })}</p></div>
    <section className="joi-progress-history" aria-label={t("home.joiProgressRecent")}>
      <h3>{t("home.joiProgressRecent")}</h3><p>{t("home.joiProgressRecentLimit")}</p>
      {progress.recentTurns.length === 0 ? <p className="plain-empty">{t("home.joiProgressNoTurns")}</p> : <ol>
        {progress.recentTurns.map((turn) => <ProgressTurn key={turn.turnId} turn={turn} now={now} time={time} />)}
      </ol>}
    </section>
  </>;
}

function ProgressTurn({ turn, now, time }: { turn: JoiGoalTurnProgressDto; now: number; time: (value: string) => string }) {
  const active = ["PENDING", "RUNNING", "WAITING"].includes(turn.status);
  return <li className={`joi-progress-turn ${turn.status.toLowerCase()}`}>
    <div><strong>{t(STAGE_KEYS[turn.stage])}</strong><span>{t(TURN_KEYS[turn.status])}</span></div>
    <small><time dateTime={turn.startedAt}>{time(turn.startedAt)}</time><span>{duration(turn.startedAt, active ? now : Date.parse(turn.updatedAt))}</span></small>
  </li>;
}
