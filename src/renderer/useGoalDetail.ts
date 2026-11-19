import { useEffect, useRef, useState } from "react";
import type { JoiGoalDetailDto } from "../shared/joi.js";
import type { DigitalLifeApi } from "./api.js";

const SUMMARY_REFRESH_MS = 1_500;
const HISTORY_REFRESH_MS = 7_500;

function mapVersion(detail: JoiGoalDetailDto, orderOnly = false): string {
  const map = detail.harness;
  if (map === undefined) return "";
  const revision = orderOnly ? map.pathOrderRevision : map.detailRevision;
  return [map.revision, revision, map.pathCount, map.decisionCount, map.fogCount].join(":");
}

function appendMapPages(detail: JoiGoalDetailDto, pages: NonNullable<JoiGoalDetailDto["harness"]>[], nextOffset: number | undefined): JoiGoalDetailDto {
  if (detail.harness === undefined || pages.length === 0) return detail;
  const merged = {
    ...detail,
    harness: {
      ...detail.harness,
      paths: [...detail.harness.paths, ...pages.flatMap(page => page.paths)],
      decisions: [...detail.harness.decisions, ...pages.flatMap(page => page.decisions)],
      fog: [...detail.harness.fog, ...pages.flatMap(page => page.fog)],
    },
  };
  if (nextOffset === undefined) delete merged.nextOffset;
  else merged.nextOffset = nextOffset;
  return merged;
}

function sameMapPage(detail: JoiGoalDetailDto, more: JoiGoalDetailDto) {
  if (detail.harness === undefined || more.harness === undefined || mapVersion(more, true) !== mapVersion(detail, true)) throw new Error("goal_map_changed");
  return more.harness;
}

type DetailAction = "poll" | "more" | "retry";

export function useGoalDetail(api: DigitalLifeApi, goalId: string) {
  const [detail, setDetail] = useState<JoiGoalDetailDto>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const action = useRef<(value: DetailAction) => void>(() => undefined);
  useEffect(() => {
    let stopped = false;
    const isStopped = () => stopped;
    let running = false;
    let pending: DetailAction | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: JoiGoalDetailDto | undefined;
    let loadedPages = 0;
    let requestedPages = 1;
    let lastMapRead = 0;
    let refreshDelay = SUMMARY_REFRESH_MS;
    const publish = (next: JoiGoalDetailDto) => { if (!stopped) { current = next; setDetail(next); } };

    async function readMap() {
      setBusy(true);
      lastMapRead = Date.now();
      const first = await api.joiGoalDetail(goalId);
      const pages = [];
      let offset = first.nextOffset;
      while (!stopped && pages.length + 1 < requestedPages && offset !== undefined) {
        const next = await api.joiGoalDetail(goalId, { offset, view: "map" });
        pages.push(sameMapPage(first, next));
        offset = next.nextOffset;
      }
      loadedPages = pages.length + 1;
      requestedPages = loadedPages;
      publish(appendMapPages(first, pages, offset));
    }

    const schedule = (delay = refreshDelay) => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState !== "hidden") timer = setTimeout(() => void run("poll"), delay);
    };

    async function run(reason: DetailAction) {
      if (stopped || document.visibilityState === "hidden") return;
      if (running) {
        if (reason !== "poll") pending = reason;
        return;
      }
      clearTimeout(timer);
      running = true;
      try {
        if (current === undefined || reason === "retry") {
          await readMap();
        } else if (reason === "more") {
          if (current.nextOffset === undefined) return;
          requestedPages = loadedPages + 1;
          setBusy(true);
          const next = await api.joiGoalDetail(goalId, { offset: current.nextOffset, view: "map" });
          if (isStopped()) return;
          if (mapVersion(current, true) !== mapVersion(next, true)) await readMap();
          else {
            publish(appendMapPages(current, [sameMapPage(current, next)], next.nextOffset));
            loadedPages = requestedPages;
          }
        } else {
          const summary = await api.joiGoalDetail(goalId, { view: "summary" });
          if (isStopped()) return;
          const staleMap = mapVersion(summary) !== mapVersion(current) || requestedPages > loadedPages;
          refreshDelay = SUMMARY_REFRESH_MS;
          if (staleMap && (loadedPages <= 1 || Date.now() - lastMapRead >= HISTORY_REFRESH_MS)) {
            await readMap();
          } else {
            if (current.harness !== undefined && summary.harness?.progress !== undefined) {
              publish({ ...current, fullTitle: summary.fullTitle, harness: { ...current.harness, progress: summary.harness.progress } });
            } else if (summary.fullTitle !== current.fullTitle) {
              publish({ ...current, fullTitle: summary.fullTitle });
            }
            if (staleMap) return;
          }
        }
        refreshDelay = SUMMARY_REFRESH_MS;
        if (!isStopped()) setFailed(requestedPages > loadedPages);
      } catch {
        refreshDelay = Math.min(HISTORY_REFRESH_MS, refreshDelay * 2);
        if (!isStopped()) setFailed(true);
      } finally {
        running = false;
        if (!isStopped()) setBusy(false);
        const next = pending;
        pending = undefined;
        if (next === undefined) schedule();
        else void run(next);
      }
    }

    const visibilityChanged = () => schedule(0);
    action.current = value => { void run(value); };
    schedule(0);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      stopped = true;
      action.current = () => undefined;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [api, goalId]);
  return { detail: detail?.goalId === goalId ? detail : undefined, failed, busy, retry: () => action.current("retry"), loadMore: () => action.current("more") };
}
