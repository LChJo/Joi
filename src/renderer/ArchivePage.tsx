import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveIcon, ArrowCounterClockwiseIcon, ChatsCircleIcon, FolderIcon, TrashIcon } from "@phosphor-icons/react";
import { ApiError, type DigitalLifeApi } from "./api";
import { ArchivedGoals } from "./JoiHome";
import { ConversationDialog, DeleteConversationDialog } from "./ConversationDialogs";
import { ConversationOutput } from "./ConversationOutput";
import { currentLocale, t, useI18n } from "./i18n";
import type { ConversationDto, ConversationSummaryDto } from "../shared/conversations";
import type { WorkbenchDto } from "../shared/joi";
import "./conversations.css";

function ArchivedConversations({ api }: { api: DigitalLifeApi }) {
  const [items,setItems] = useState<ConversationSummaryDto[]>([]);
  const [workbenches,setWorkbenches] = useState<WorkbenchDto[]>([]);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState<string | null>(null);
  const [search,setSearch] = useState("");
  const [opened,setOpened] = useState<ConversationDto | null>(null);
  const [deleting,setDeleting] = useState<ConversationSummaryDto | null>(null);
  const [busy,setBusy] = useState(false);
  const [loadingEarlier,setLoadingEarlier] = useState(false);
  const sequence = useRef(0);
  const showError = useCallback((reason: unknown) => setError(reason instanceof ApiError ? reason.displayMessage : t("chat.error")),[]);
  const load = useCallback(async () => {
    setLoading(true);
    try { const [chats,wbs] = await Promise.all([api.listConversations(true),api.listWorkbenches()]);setItems(chats.items);setWorkbenches(wbs.items);setError(null); }
    catch (reason) { showError(reason); } finally { setLoading(false); }
  },[api,showError]);
  useEffect(() => { const timer = setTimeout(() => void load(),0);return () => clearTimeout(timer); },[load]);
  const workbenchName = (item: ConversationSummaryDto) => workbenches.find(wb => wb.workbenchId === item.workbenchId)?.name ?? item.workbenchId;
  const change = async (item: ConversationSummaryDto,remove: boolean) => {
    if (busy) return;
    setBusy(true);setError(null);sequence.current++;
    try {
      if (remove) await api.deleteConversation(item.conversationId);else await api.restoreConversation(item.conversationId);
      setItems(values => values.filter(value => value.conversationId !== item.conversationId));setDeleting(null);
      setOpened(value => value?.conversationId === item.conversationId ? null : value);
    } catch (reason) { showError(reason); } finally { setBusy(false); }
  };
  const open = async (item: ConversationSummaryDto) => {
    const request = ++sequence.current;
    try { const value = await api.getConversation(item.conversationId);if (request === sequence.current) { setOpened(value);setError(null); } }
    catch (reason) { if (request === sequence.current) showError(reason); }
  };
  const visible = items.filter(item => `${item.title} ${workbenchName(item)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const loadEarlier = async () => {
    const current = opened;if (current?.historyCursor === undefined || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await api.conversationHistory(current.conversationId,current.historyCursor);
      setOpened(value => {
        if (value?.conversationId !== current.conversationId) return value;
        const next = { ...value,turns: [...page.items,...value.turns] };delete next.historyCursor;
        return { ...next,...(page.nextCursor === null ? {} : { historyCursor: page.nextCursor }) };
      });
    } catch (reason) { showError(reason); } finally { setLoadingEarlier(false); }
  };
  return <section aria-label={t("chat.archivedConversations")} className="chat-archive">
    <p className="chat-archive-hint">{t("chat.archiveHint")}</p>
    <input aria-label={t("chat.archiveSearch")} onChange={event => setSearch(event.target.value)} placeholder={t("chat.archiveSearch")} type="search" value={search} />
    {error === null || deleting !== null ? null : <div role="alert"><p>{error}</p><button className="button quiet" onClick={() => void load()} type="button">{t("common.retry")}</button></div>}
    {loading ? <p role="status">{t("chat.archiveLoading")}</p> : visible.length === 0 ? <div className="chat-archive-empty"><ChatsCircleIcon /><p>{t(items.length === 0 ? "chat.archiveEmpty" : "chat.noSearchResults")}</p></div> : <div className="chat-archive-list">{visible.map(item => <article key={item.conversationId}>
      <button aria-label={item.title} className="chat-archive-open" disabled={busy} onClick={() => void open(item)} type="button"><strong>{item.title}</strong><span><FolderIcon />{workbenchName(item)}<time dateTime={item.archivedAt ?? item.updatedAt}>{new Date(item.archivedAt ?? item.updatedAt).toLocaleString(currentLocale())}</time></span></button>
      <div className="chat-archive-actions"><button className="button quiet" disabled={busy} onClick={() => void change(item,false)} type="button"><ArrowCounterClockwiseIcon />{t("common.resume")}</button><button className="button quiet" disabled={busy} onClick={() => { setError(null);setDeleting(item); }} type="button"><TrashIcon />{t("common.delete")}</button></div>
    </article>)}</div>}
    {deleting === null ? null : <DeleteConversationDialog busy={busy} error={error} onCancel={() => { setDeleting(null);setError(null); }} onDelete={() => void change(deleting,true)} title={deleting.title} />}
    {opened === null ? null : <ConversationDialog onClose={() => { sequence.current++;setOpened(null); }} title={opened.title}><p className="chat-archive-hint">{workbenchName(opened)}</p><div className="chat-archive-transcript">
      {opened.historyCursor === undefined ? null : <button disabled={loadingEarlier} onClick={() => void loadEarlier()} type="button">{t("chat.loadEarlier")}</button>}
        {opened.turns.map(turn => <article className="chat-turn" key={turn.turnId}><div className="chat-user"><p>{turn.text}</p></div><div className="chat-output"><ConversationOutput entries={turn.entries.filter(entry => entry.kind === "MARKDOWN" || entry.kind === "ERROR" || entry.kind === "ACTIVITY")} status={turn.status} /></div></article>)}</div></ConversationDialog>}
  </section>;
}

export function ArchivePage({ api,onContinued }: { api: DigitalLifeApi;onContinued?: (goalId: string) => void }) {
  useI18n();
  const [tab,setTab] = useState<"tasks" | "conversations">("tasks");
  return <section className="archive-page"><header className="archive-page-header"><ArchiveIcon /><h1>{t("common.archived")}</h1></header><div aria-label={t("common.archived")} className="archive-tabs" role="tablist" onKeyDown={event => {
    if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
    event.preventDefault();const next = event.key === "Home" ? "tasks" : event.key === "End" ? "conversations" : tab === "tasks" ? "conversations" : "tasks";
    setTab(next);event.currentTarget.querySelector<HTMLButtonElement>(`#archive-tab-${next}`)?.focus();
  }}>{(["tasks","conversations"] as const).map(value => <button aria-controls={`archive-panel-${value}`} aria-selected={tab === value} id={`archive-tab-${value}`} key={value} onClick={() => setTab(value)} role="tab" tabIndex={tab === value ? 0 : -1} type="button">{t(value === "tasks" ? "chat.tasksTab" : "chat.title")}</button>)}</div>
    <div aria-labelledby={`archive-tab-${tab}`} id={`archive-panel-${tab}`} role="tabpanel">{tab === "tasks" ? <ArchivedGoals api={api} {...(onContinued === undefined ? {} : { onContinued })} /> : <ArchivedConversations api={api} />}</div>
  </section>;
}
