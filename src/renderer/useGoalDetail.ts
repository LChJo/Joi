import { useEffect, useState } from "react";
import type { JoiGoalDetailDto } from "../shared/joi.js";
import type { DigitalLifeApi } from "./api.js";

function mapVersion(detail: JoiGoalDetailDto): string {
  const map = detail.harness;
  return map === undefined ? "" : [map.revision, map.pathCount, map.decisionCount, map.fogCount].join(":");
}

/** Only a complete successful refresh replaces the visible set of loaded pages. */
export function useGoalDetail(api: DigitalLifeApi, goalId: string) {
  const [detail, setDetail] = useState<JoiGoalDetailDto>();
  const [pageCount, setPageCount] = useState(1);
  const [retryIndex, setRetryIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const isActive = () => active;
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      setBusy(true);
      try {
        const first = await api.joiGoalDetail(goalId);
        if (!isActive()) return;
        let next = first.nextOffset;
        const merged: JoiGoalDetailDto = structuredClone(first);
        for (let page = 1; page < pageCount && next !== undefined; page++) {
          const more = await api.joiGoalDetail(goalId, { offset: next });
          if (!isActive()) return;
          if (mapVersion(more) !== mapVersion(first)) throw new Error("goal_map_changed");
          if (merged.harness !== undefined && more.harness !== undefined) {
            merged.harness.paths.push(...more.harness.paths);
            merged.harness.decisions.push(...more.harness.decisions);
            merged.harness.fog.push(...more.harness.fog);
          }
          next = more.nextOffset;
        }
        if (next === undefined) delete merged.nextOffset;
        else merged.nextOffset = next;
        if (isActive()) { setDetail(merged); setFailed(false); }
      } catch { if (isActive()) setFailed(true); }
      finally { inFlight = false; if (isActive()) setBusy(false); }
    }
    const initial = setTimeout(() => void load(), 0);
    const interval = setInterval(() => void load(), 1_500);
    return () => { active = false; clearTimeout(initial); clearInterval(interval); };
  }, [api, goalId, pageCount, retryIndex]);
  return { detail: detail?.goalId === goalId ? detail : undefined, failed, busy, retry: () => setRetryIndex((value) => value + 1), loadMore: () => setPageCount((value) => value + 1) };
}
