import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummaryDto } from "../shared/conversations";
import type { WorkbenchDto } from "../shared/joi";
import type { DigitalLifeApi } from "./api";

interface Lists {
  workbenches?: WorkbenchDto[];
  history?: ConversationSummaryDto[];
}

const emptyLists: Lists = {};
const cachedLists = new WeakMap<DigitalLifeApi, Lists>();

export function useConversationLists(api: DigitalLifeApi) {
  const [loaded, setLoaded] = useState(() => ({ api, lists: cachedLists.get(api) ?? emptyLists }));
  const [historyFailed, setHistoryFailed] = useState(false);
  const [workbenchesFailed, setWorkbenchesFailed] = useState(false);
  const revisions = useRef({ history: 0, workbenches: 0 });
  const addedWorkbenches = useRef<WorkbenchDto[]>([]);
  const publish = useCallback((update: (lists: Lists) => Lists) => {
    const lists = update(cachedLists.get(api) ?? emptyLists);
    cachedLists.set(api, lists);
    setLoaded({ api, lists });
  }, [api]);
  const loadHistory = useCallback(() => {
    const request = ++revisions.current.history;
    return api.listConversations().then(({ items }) => {
      if (request !== revisions.current.history) return;
      publish(lists => ({ ...lists, history: items }));
      setHistoryFailed(false);
    }, () => {
      if (request === revisions.current.history) setHistoryFailed(true);
    });
  }, [api, publish]);
  const loadWorkbenches = useCallback(() => {
    const request = ++revisions.current.workbenches;
    return api.listWorkbenches().then(({ items }) => {
      if (request !== revisions.current.workbenches) return;
      const listed = new Set(items.map(item => item.workbenchId));
      const addedDuringRead = addedWorkbenches.current.filter(item => !listed.has(item.workbenchId));
      addedWorkbenches.current = [];
      publish(lists => ({ ...lists, workbenches: [...items, ...addedDuringRead] }));
      setWorkbenchesFailed(false);
    }, () => {
      if (request === revisions.current.workbenches) setWorkbenchesFailed(true);
    });
  }, [api, publish]);
  useEffect(() => {
    const requests = revisions.current;
    void loadHistory();
    void loadWorkbenches();
    return () => { requests.history++; requests.workbenches++; };
  }, [loadHistory, loadWorkbenches]);

  const updateHistory = (update: (items: ConversationSummaryDto[]) => ConversationSummaryDto[]) => {
    revisions.current.history++;
    publish(lists => ({ ...lists, history: update(lists.history ?? []) }));
  };
  const addWorkbench = (workbench: WorkbenchDto) => {
    addedWorkbenches.current = [...addedWorkbenches.current.filter(item => item.workbenchId !== workbench.workbenchId), workbench];
    publish(lists => ({ ...lists, workbenches: [...(lists.workbenches ?? []).filter(item => item.workbenchId !== workbench.workbenchId), workbench] }));
  };
  const retryLists = () => {
    if (historyFailed) { setHistoryFailed(false); void loadHistory(); }
    if (workbenchesFailed) { setWorkbenchesFailed(false); void loadWorkbenches(); }
  };
  return {
    ...(loaded.api === api ? loaded.lists : cachedLists.get(api)),
    listsFailed: historyFailed || workbenchesFailed, retryLists, loadHistory, updateHistory, addWorkbench,
  };
}
