import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { WorkbenchAgentCardDto } from "../shared/joi.js";
import type { DigitalLifeApi } from "./api.js";

const ACTIVE_REFRESH_MS = 1_500;
const IDLE_REFRESH_MS = 7_500;
const MAX_RETRY_MS = 30_000;
const NO_AGENTS: WorkbenchAgentCardDto[] = [];

type AgentPage = Awaited<ReturnType<DigitalLifeApi["listWorkbenchAgents"]>>;
type PageAction = "previous" | "next" | "refresh";

interface PageSnapshot {
  scope: string;
  history: string[];
  page: AgentPage;
}

export function useWorkbenchAgentPage(api: DigitalLifeApi, options: {
  workbenchId?: string;
  goalId?: string;
  enabled: boolean;
  goalActive?: boolean;
  onPage?: (items: WorkbenchAgentCardDto[]) => void;
}) {
  const { workbenchId, goalId, enabled } = options;
  const scope = JSON.stringify([workbenchId, goalId]);
  const [snapshot, setSnapshot] = useState<PageSnapshot>();
  const [busyScope, setBusyScope] = useState<string>();
  const [failedScope, setFailedScope] = useState<string>();
  const lastPage = useRef<PageSnapshot>(undefined);
  const activeRead = useRef<{ api: DigitalLifeApi; scope: string; cursor: string | undefined; promise: Promise<AgentPage> }>(undefined);
  const dispatch = useRef<(action: PageAction) => void>(() => undefined);
  const pageLoaded = useEffectEvent((items: WorkbenchAgentCardDto[]) => {
    options.onPage?.(items);
    return options.goalActive === true || items.some(item => item.status === "RUNNING" || item.status === "WAITING");
  });

  useEffect(() => {
    if (!enabled || workbenchId === undefined) return;
    const id = workbenchId;
    let stopped = false;
    const isStopped = () => stopped;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = lastPage.current?.scope === scope ? lastPage.current : undefined;
    let requested = current?.history ?? [];
    let pending: string[] | undefined;
    let delay = ACTIVE_REFRESH_MS;

    function schedule(milliseconds = delay) {
      clearTimeout(timer);
      if (!stopped && document.visibilityState !== "hidden") timer = setTimeout(() => void load(requested), milliseconds);
    }

    async function load(history: string[], manual = false) {
      if (stopped || document.visibilityState === "hidden") return;
      if (running) {
        if (manual) pending = history;
        return;
      }
      running = true;
      clearTimeout(timer);
      requested = history;
      if (manual || current === undefined) setBusyScope(scope);
      const cursor = history.at(-1);
      const previous = activeRead.current;
      const read = previous?.api === api && previous.scope === scope && previous.cursor === cursor ? previous : {
        api, scope, cursor, promise: api.listWorkbenchAgents(id, {
          limit: 100, ...(cursor === undefined ? {} : { cursor }), ...(goalId === undefined ? {} : { goalId }),
        }),
      };
      activeRead.current = read;
      try {
        const page = await read.promise;
        if (isStopped()) return;
        if (!Array.isArray(page.items)) throw new Error("workbench_agent_page_invalid");
        current = { scope, history, page };
        lastPage.current = current;
        setSnapshot(current);
        delay = pageLoaded(page.items) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
        setFailedScope(undefined);
      } catch {
        delay = Math.min(MAX_RETRY_MS, Math.max(IDLE_REFRESH_MS, delay * 2));
        if (!isStopped()) setFailedScope(scope);
      } finally {
        if (activeRead.current === read) activeRead.current = undefined;
        running = false;
        if (!isStopped()) setBusyScope(undefined);
        const next = pending;
        pending = undefined;
        if (next === undefined) schedule();
        else void load(next, true);
      }
    }

    dispatch.current = action => {
      if (action === "refresh") { void load(requested, true); return; }
      if (current === undefined) return;
      if (action === "previous" && current.history.length > 0) void load(current.history.slice(0, -1), true);
      if (action === "next" && current.page.nextCursor !== undefined) void load([...current.history, current.page.nextCursor], true);
    };
    const visibilityChanged = () => schedule(0);
    schedule(0);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      stopped = true;
      dispatch.current = () => undefined;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [api, enabled, goalId, scope, workbenchId]);

  const current = snapshot?.scope === scope ? snapshot : undefined;
  return {
    items: current?.page.items ?? NO_AGENTS,
    loaded: current !== undefined,
    busy: busyScope === scope,
    failed: failedScope === scope,
    hasPrevious: (current?.history.length ?? 0) > 0,
    hasNext: current?.page.nextCursor !== undefined,
    previous: () => dispatch.current("previous"),
    next: () => dispatch.current("next"),
    refresh: () => dispatch.current("refresh"),
  };
}
