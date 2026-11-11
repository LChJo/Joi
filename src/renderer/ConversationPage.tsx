import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowUpIcon, FolderIcon, GearSixIcon, ListIcon, LockSimpleIcon, NetworkIcon, PaperclipIcon, PlusIcon, RobotIcon, SidebarSimpleIcon, SparkleIcon, StopIcon, XIcon, QuestionIcon, CopyIcon, CheckIcon } from "@phosphor-icons/react";
import { ApiError, type DigitalLifeApi } from "./api";
import { t, useI18n } from "./i18n";
import { randomUuid } from "./random-uuid";
import { SafeMarkdown } from "./SafeMarkdown";
import { ConversationWorkspace } from "./ConversationWorkspace";
import { ConversationOutput } from "./ConversationOutput";
import { ConversationContext } from "./ConversationContext";
import { ConversationHistoryRow } from "./ConversationHistoryRow";
import { DeleteConversationDialog } from "./ConversationDialogs";
import type { ConversationDto, ConversationInheritanceDto, ConversationSummaryDto, ConversationTurnStatus, SendConversationInput } from "../shared/conversations";
import type { JoiAttachmentDto, ModelSourceDto, PartnerDto, WorkbenchDto } from "../shared/joi";
import "./conversations.css";

type Picker = "workbench" | "network" | "partner" | "skills" | "attachments" | "inheritance" | "help" | null;
interface Draft { id: string; workbenchId: string; text: string; partnerId: string; networkId: string; skills: string[]; attachments: JoiAttachmentDto[]; started?: boolean;subagentsEnabled?: boolean; }
const drafts = new WeakMap<DigitalLifeApi, Map<string,Draft>>();
function statusText(status: ConversationTurnStatus) {
  return status === "QUEUED" ? t("chat.queued") : status === "RUNNING" ? t("chat.running") : status === "FAILED" ? t("chat.failed") : status === "STOPPED" ? t("chat.stopped") : status === "INTERRUPTED" ? t("chat.interrupted") : t("chat.completed");
}
function PickerButton({ name,label,children,icon,open,onToggle,disabled = false }: {
  name: string;label: ReactNode;children: ReactNode;icon: ReactNode;open: boolean;onToggle: () => void;disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (event: PointerEvent) => { if (event.target instanceof Node && !ref.current?.contains(event.target)) onToggle(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { onToggle(); ref.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown",click); document.addEventListener("keydown",key);
    return () => { document.removeEventListener("pointerdown",click); document.removeEventListener("keydown",key); };
  },[open,onToggle]);
  return <div className="chat-picker" ref={ref}><button aria-label={name} aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={onToggle} type="button">{icon}<span>{label}</span></button>
    {open ? <div aria-label={name} className="chat-popover" role="dialog"><strong>{name}</strong>{children}</div> : null}</div>;
}

function WorkspaceResizeHandle({ layout,historyOpen,enabled }: { layout: RefObject<HTMLDivElement | null>;historyOpen: boolean;enabled: boolean }) {
  const [size,setSize] = useState({ width: 322,min: 280,max: 720 });
  const width = useRef(322);
  const gesture = useRef<{ pointerId: number;x: number;width: number } | null>(null);
  useEffect(() => {
    const root = layout.current;if (root === null) return;
    const update = () => {
      const room = root.getBoundingClientRect().width;
      const desktop = window.innerWidth > 1180;
      const history = desktop && historyOpen ? root.querySelector(".conversation-history")?.getBoundingClientRect().width ?? 0 : 0;
      const max = Math.max(180,Math.min(720,room - (desktop ? history + 360 : 32)));
      const min = Math.min(280,max),next = Math.max(min,Math.min(max,width.current));
      width.current = next;root.style.setProperty("--chat-workspace-width",`${String(next)}px`);
      setSize(current => current.width === next && current.min === min && current.max === max ? current : { width: next,min,max });
    };
    update();window.addEventListener("resize",update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);observer?.observe(root);
    return () => { observer?.disconnect();window.removeEventListener("resize",update);root.classList.remove("is-resizing"); };
  },[layout,historyOpen]);
  useEffect(() => { if (!enabled) { gesture.current = null;layout.current?.classList.remove("is-resizing"); } },[enabled,layout]);
  const applyWidth = (value: number) => {
    const next = Math.max(size.min,Math.min(size.max,Math.round(value)));width.current = next;
    layout.current?.style.setProperty("--chat-workspace-width",`${String(next)}px`);
    setSize(current => ({ ...current,width: next }));
  };
  return <div aria-controls="conversation-workspace" aria-label={t("chat.resizeWorkspace")} aria-orientation="vertical" aria-valuemax={size.max} aria-valuemin={size.min} aria-valuenow={size.width} className="chat-workspace-resizer" hidden={!enabled} role="separator" tabIndex={enabled ? 0 : -1}
    onDoubleClick={() => applyWidth(322)}
    onKeyDown={event => { const next = event.key === "ArrowLeft" ? size.width + 20 : event.key === "ArrowRight" ? size.width - 20 : event.key === "Home" ? size.min : event.key === "End" ? size.max : null;if (next !== null) { event.preventDefault();applyWidth(next); } }}
    onPointerDown={event => { if (event.button !== 0) return;event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);gesture.current = { pointerId: event.pointerId,x: event.clientX,width: width.current };layout.current?.classList.add("is-resizing"); }}
    onPointerMove={event => { const active = gesture.current;if (active?.pointerId === event.pointerId) applyWidth(active.width + active.x - event.clientX); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);gesture.current = null;layout.current?.classList.remove("is-resizing"); }}
    onPointerCancel={() => { gesture.current = null;layout.current?.classList.remove("is-resizing"); }}
    onLostPointerCapture={() => { gesture.current = null;layout.current?.classList.remove("is-resizing"); }} />;
}

export function ConversationPage({ api,onSettings }: { api: DigitalLifeApi; onSettings: () => void }) {
  useI18n();
  const [workbenches,setWorkbenches] = useState<WorkbenchDto[]>([]);
  const [networks,setNetworks] = useState<ModelSourceDto[]>([]);
  const [partners,setPartners] = useState<PartnerDto[]>([]);
  const [history,setHistory] = useState<ConversationSummaryDto[]>([]);
  const [conversation,setConversation] = useState<ConversationDto | null>(null);
  const [draft,setDraft] = useState<Draft>(() => {
    const saved = drafts.get(api)?.get("active");
    return saved ?? { id: randomUuid(),workbenchId: "",text: "",partnerId: "joi-chat",networkId: "",skills: [],attachments: [] };
  });
  const [picker,setPicker] = useState<Picker>(null);
  const [restoring,setRestoring] = useState(draft.started === true);
  const [skillOptions,setSkillOptions] = useState<{ id: string; displayName: string }[]>([]);
  const [inheritance,setInheritance] = useState<ConversationInheritanceDto | null>(null);
  const [search,setSearch] = useState("");
  const [deleting,setDeleting] = useState<ConversationSummaryDto | null>(null);
  const [changing,setChanging] = useState(false);
  const [deleteError,setDeleteError] = useState<string | null>(null);
  const [notice,setNotice] = useState<string | null>(null);
  const [submitting,setSubmitting] = useState(false);
  const [uploading,setUploading] = useState(false);
  const [loadingHistory,setLoadingHistory] = useState(false);
  const [workspaceOpen,setWorkspaceOpen] = useState(false);
  const [historyOpen,setHistoryOpen] = useState(() => window.innerWidth > 720);
  const [copied,setCopied] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const pendingRequest = useRef<SendConversationInput | null>(null);
  const activeId = useRef(draft.id);
  const selection = useRef(0);
  const updateCursor = useRef<{ id: string;cursor: string } | null>(null);
  const selectedPartner = partners.find(p => p.partnerId === draft.partnerId);
  const engine = selectedPartner?.engine ?? "pi-core";
  const native = engine !== "pi-core";
  const selectedWorkbench = workbenches.find(w => w.workbenchId === draft.workbenchId);
  const selectedNetwork = networks.find(n => n.sourceId === draft.networkId);
  const busy = conversation?.turns.some(turn => turn.status === "QUEUED" || turn.status === "RUNNING") === true;
  const workspaceVisible = workspaceOpen && conversation !== null;
  const conversationId = conversation?.conversationId;
  const showError = useCallback((error: unknown) => setNotice(error instanceof ApiError ? error.displayMessage : t("chat.error")),[]);
  const patchDraft = (patch: Partial<Draft>) => { pendingRequest.current = null; setDraft(value => ({ ...value,...patch })); };
  const toggle = (value: Picker) => setPicker(current => current === value ? null : value);
  const loadHistory = useCallback(async () => setHistory((await api.listConversations()).items),[api]);
  useEffect(() => {
    let current = true;
    const remembered = drafts.get(api)?.get("active");
    void Promise.all([api.listWorkbenches(),api.listModelSources(),api.listPartners(),api.listConversations()]).then(([w,n,p,h]) => {
      if (!current) return;
      setWorkbenches(w.items);setNetworks(n.items);setPartners(p.items.filter(item => item.kind === "local-pi" && item.status === "ACTIVE" && item.partnerId !== "joi-chat"));setHistory(h.items);
      setDraft(d => ({ ...d,workbenchId: d.workbenchId === "" ? w.items[0]?.workbenchId ?? "" : d.workbenchId,networkId: d.networkId === "" ? n.items.find(item => item.status === "READY")?.sourceId ?? "" : d.networkId }));
      if (remembered?.started === true) {
        const discardRemembered = () => {
          if (!current || activeId.current !== remembered.id) return;
          const id = randomUuid();drafts.get(api)?.delete(remembered.id);activeId.current = id;
          setDraft(d => ({ ...d,id,text: "",attachments: [],started: false }));
        };
        return api.getConversation(remembered.id).then(value => {
          if (value.archivedAt !== undefined) discardRemembered();
          else if (current && activeId.current === value.conversationId) setConversation(value);
        }).catch((error: unknown) => { if (error instanceof ApiError && error.code === "conversation_not_found") discardRemembered();else throw error; });
      }
      return undefined;
    }).catch(showError).finally(() => { if (current) setRestoring(false); });
    return () => { current = false; };
  },[api,showError]);
  useEffect(() => {
    let cache = drafts.get(api);
    if (cache === undefined) { cache = new Map(); drafts.set(api,cache); }
    cache.set(draft.id,draft); cache.set("active",draft); activeId.current = draft.id;
  },[api,draft]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); onSettings(); } };
    window.addEventListener("keydown",key);return () => window.removeEventListener("keydown",key);
  },[onSettings]);
  useEffect(() => {
    let current = true;
    void api.request<{ items: { id: string;displayName: string }[] }>(`/api/v1/engines/${encodeURIComponent(engine)}/skills`).then(page => { if (current) setSkillOptions(page.items); }).catch(showError);
    return () => { current = false; };
  },[api,engine,showError]);
  useEffect(() => {
    if (draft.workbenchId === "") return;
    let current = true;
    void api.conversationInheritance(draft.workbenchId,draft.partnerId,native ? "native" : draft.networkId).then(value => { if (current) setInheritance(value); }).catch(() => { if (current) setInheritance(null); });
    return () => { current = false; };
  },[api,draft.workbenchId,draft.partnerId,draft.networkId,native,conversation?.turns.length]);
  useEffect(() => {
    if (conversationId === undefined || !busy) return;
    let current = true,fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      const refresh = async () => {
        const cursor = updateCursor.current?.id === conversationId ? updateCursor.current.cursor : conversation.eventCursor;
        if (cursor !== undefined && typeof api.conversationEvents === "function") {
          const events = await api.conversationEvents(conversationId,cursor);
          if (events.items.length === 0) { if (current) updateCursor.current = { id: conversationId,cursor: events.cursor };return null; }
        }
        const next = await api.getConversation(conversationId);
        if (current && next.eventCursor !== undefined) updateCursor.current = { id: conversationId,cursor: next.eventCursor };
        return next;
      };
      void refresh().then(next => {
        if (next !== null && current && activeId.current === next.conversationId) {
          setConversation(previous => {
            if (previous?.conversationId !== next.conversationId) return next;
            const value = { ...next };delete value.historyCursor;
            return { ...value,...(previous.historyCursor === undefined ? {} : { historyCursor: previous.historyCursor }),
              turns: [...previous.turns.filter(turn => !next.turns.some(value => value.turnId === turn.turnId)),...next.turns] };
          });
          if (!next.turns.some(turn => turn.status === "QUEUED" || turn.status === "RUNNING")) void loadHistory().catch(showError);
        }
      }).catch(showError).finally(() => { fetching = false; });
    },700);
    return () => { current = false;clearInterval(timer); };
  },[api,conversationId,busy,conversation?.eventCursor,loadHistory,showError]);
  useEffect(() => { if (nearBottom.current && stream.current !== null) stream.current.scrollTop = stream.current.scrollHeight; },[conversation]);
  const selectConversation = async (id: string) => {
    const request = ++selection.current;
    try {
      const next = await api.getConversation(id);
      if (request !== selection.current) return;
      const latest = next.turns.at(-1);
      const saved = drafts.get(api)?.get(id);
      activeId.current = id;setConversation(next);setPicker(null);setNotice(null);nearBottom.current = true;
      setDraft(saved ?? { id,workbenchId: next.workbenchId,text: "",partnerId: latest?.config.partnerId ?? "joi-chat",networkId: latest?.config.networkId ?? draft.networkId,skills: latest?.config.skills ?? [],attachments: [],started: true,subagentsEnabled: latest?.config.subagentsEnabled ?? true });
    } catch (error) { showError(error); }
  };
  const newChat = () => {
    selection.current++;
    const id = randomUuid();activeId.current = id;setConversation(null);setWorkspaceOpen(false);setPicker(null);setNotice(null);pendingRequest.current = null;
    setDraft({ ...draft,id,text: "",attachments: [],started: false });setRestoring(false);nearBottom.current = true;
  };
  const changeConversation = async (item: ConversationSummaryDto,remove: boolean) => {
    if (changing) return;
    setChanging(true);setDeleteError(null);
    try {
      if (remove) await api.deleteConversation(item.conversationId);else await api.archiveConversation(item.conversationId);
      selection.current++;
      drafts.get(api)?.delete(item.conversationId);
      if (activeId.current === item.conversationId) newChat();
      setHistory(items => items.filter(value => value.conversationId !== item.conversationId));setDeleting(null);
      await loadHistory();
    } catch (error) { if (remove) setDeleteError(error instanceof ApiError ? error.displayMessage : t("chat.error"));else showError(error); }
    finally { setChanging(false); }
  };
  const quickWorkbench = async () => {
    try { const wb = await api.quickConversationWorkbench();setWorkbenches(items => [...items,wb]);patchDraft({ workbenchId: wb.workbenchId });setPicker(null); }
    catch (error) { if (!(error instanceof ApiError && error.code === "workbench_workspace_selection_canceled")) showError(error); }
  };
  const upload = async (files: FileList | null) => {
    if (files === null) return;
    const id = draft.id; setUploading(true);
    try { const next: JoiAttachmentDto[] = [];for (const file of Array.from(files).slice(0,16 - draft.attachments.length)) next.push(await api.uploadJoiAttachment(file));
      if (activeId.current === id) setDraft(d => ({ ...d,attachments: [...d.attachments,...next] }));
    } catch (error) { showError(error); } finally { setUploading(false);if (fileInput.current !== null) fileInput.current.value = ""; }
  };
  const send = async () => {
    if (busy || submitting || uploading || restoring || draft.text.trim() === "" || draft.workbenchId === "") return;
    setSubmitting(true);setNotice(null);setPicker(null);
    pendingRequest.current ??= { conversationId: draft.id,workbenchId: draft.workbenchId,text: draft.text,partnerId: draft.partnerId,networkId: native ? "native" : draft.networkId,
      subagentsEnabled: draft.subagentsEnabled ?? true,skills: draft.skills,attachmentIds: draft.attachments.map(a => a.attachmentId),requestId: randomUuid() };
    try { const next = await api.sendConversation(pendingRequest.current);if (activeId.current === next.conversationId) { setConversation(next);setDraft(d => ({ ...d,text: "",attachments: [],started: true }));nearBottom.current = true; } pendingRequest.current = null;await loadHistory(); }
    catch (error) { showError(error); } finally { setSubmitting(false); }
  };
  const loadEarlier = async () => {
    const id = conversation?.conversationId,cursor = conversation?.historyCursor;
    if (id === undefined || cursor === undefined || loadingHistory) return;
    nearBottom.current = false;
    setLoadingHistory(true);
    try {
      const page = await api.conversationHistory(id,cursor);
      if (activeId.current === id) setConversation(previous => {
        if (previous === null) return previous;
        const value = { ...previous };delete value.historyCursor;
        return { ...value,turns: [...page.items.filter(turn => !previous.turns.some(value => value.turnId === turn.turnId)),...previous.turns],
          ...(page.nextCursor === null ? {} : { historyCursor: page.nextCursor }) };
      });
    } catch (error) { showError(error); } finally { setLoadingHistory(false); }
  };
  return <div className={`conversation-layout ${workspaceVisible ? "" : "workspace-hidden"} ${historyOpen ? "" : "history-hidden"}`} ref={layout}>
    {deleting === null ? null : <DeleteConversationDialog busy={changing} error={deleteError} onCancel={() => setDeleting(null)} onDelete={() => void changeConversation(deleting,true)} title={deleting.title} />}
    <aside className="conversation-history"><header><h1>{t("chat.title")}</h1></header>
      <button className="chat-new" onClick={newChat} type="button"><PlusIcon />{t("chat.newChat")}</button>
      <input aria-label={t("chat.search")} className="chat-search" onChange={e => setSearch(e.target.value)} placeholder={t("chat.search")} value={search} />
      <div className="chat-history-groups">{workbenches.map(wb => {
        const items = history.filter(item => item.workbenchId === wb.workbenchId && item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
        return items.length === 0 ? null : <details key={wb.workbenchId} open><summary><FolderIcon /><span>{wb.name}</span><small>{items.length}</small></summary>{items.map(item => <ConversationHistoryRow disabled={changing || submitting} item={{ ...item,...(item.conversationId === conversationId && busy ? { canArchive: false } : {}) }} key={item.conversationId} onArchive={() => void changeConversation(item,false)} onDelete={() => { setDeleteError(null);setDeleting(item); }} onSelect={() => void selectConversation(item.conversationId)} selected={draft.id === item.conversationId} workbench={wb.name} />)}</details>;
      })}{history.length === 0 ? <p className="chat-empty-note">{t("chat.emptyHistory")}</p> : null}</div>
      <footer><LockSimpleIcon />{t("chat.locked")}</footer>
    </aside>
    <section className="conversation-center"><header className="conversation-topbar"><button aria-label={t("chat.showHistory")} className="icon-button" onClick={() => setHistoryOpen(v => !v)} type="button"><ListIcon /></button>
      <div><strong>{conversation?.title ?? t("chat.newChat")}</strong><small>{selectedWorkbench?.name ?? t("chat.chooseWorkbench")} · {t("chat.title")}</small></div>
      <div className="chat-top-actions"><PickerButton name={t("chat.help")} label="" icon={<QuestionIcon />} open={picker === "help"} onToggle={() => toggle("help")}><p>{t("chat.helpText")}</p></PickerButton>
        {conversation === null ? null : <button aria-controls="conversation-workspace" aria-expanded={workspaceVisible} aria-label={t("chat.showWorkspace")} className="icon-button" onClick={() => setWorkspaceOpen(v => !v)} type="button"><SidebarSimpleIcon /></button>}</div></header>
      <div className={`conversation-stream ${conversation === null ? "is-empty" : ""}`} onScroll={e => { const el = e.currentTarget;nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }} ref={stream}>
        {conversation === null ? <div className="chat-welcome"><div className="chat-welcome-mark"><SparkleIcon weight="duotone" /></div><h2>{t("chat.emptyTitle")}</h2><p>{t("chat.emptyHint")}</p></div> : <div className="chat-transcript">
          {conversation.historyCursor === undefined ? null : <button disabled={loadingHistory} onClick={() => void loadEarlier()} type="button">{t("chat.loadEarlier")}</button>}
          {conversation.turns.map(turn => <article className="chat-turn" key={turn.turnId}>
          <div className="chat-user"><SafeMarkdown>{turn.text}</SafeMarkdown>{turn.config.attachmentIds.length === 0 ? null : <small><PaperclipIcon />{turn.config.attachmentIds.length}</small>}</div>
          <div className="chat-agent-heading"><span className="chat-agent-mark">j</span><strong>{turn.config.partnerName}</strong><small>{turn.config.modelName}</small></div>
          <div className="chat-output"><ConversationOutput entries={turn.entries} status={turn.status} /></div>
          <footer className={`chat-turn-footer status-${turn.status.toLowerCase()}`}><span>{statusText(turn.status)}</span>{turn.config.skills.length > 0 ? <small>Skills · {turn.config.skills.length}</small> : null}
            <button aria-label={t("chat.copy")} className="icon-button" onClick={() => { void navigator.clipboard.writeText(turn.entries.filter(e => e.role === "AGENT" && e.kind === "MARKDOWN").map(e => e.text ?? "").join("\n\n")).then(() => setCopied(turn.turnId)).catch(showError); }} type="button">{copied === turn.turnId ? <CheckIcon /> : <CopyIcon />}</button></footer>
        </article>)}</div>}
      </div>
      <div className="chat-compose-area">{notice === null ? null : <div className="chat-notice" role="alert">{notice}<button aria-label={t("chat.remove")} onClick={() => setNotice(null)} type="button"><XIcon /></button></div>}
        {conversation === null && !draft.started ? <div className="chat-context-strip"><PickerButton name={t("chat.workbench")} label={selectedWorkbench?.name ?? t("chat.chooseWorkbench")} icon={<FolderIcon />} disabled={submitting || restoring} open={picker === "workbench"} onToggle={() => toggle("workbench")}>
          <div role="listbox" aria-label={t("chat.workbench")}>{workbenches.map(w => <button aria-selected={draft.workbenchId === w.workbenchId} key={w.workbenchId} onClick={() => { patchDraft({ workbenchId: w.workbenchId });setPicker(null); }} role="option" type="button"><FolderIcon />{w.name}</button>)}</div>
          {api.desktop ? <><button className="chat-quick-workbench" onClick={() => void quickWorkbench()} type="button"><PlusIcon />{t("chat.quickWorkbench")}</button><p>{t("chat.quickHint")}</p></> : null}</PickerButton>
          <PickerButton name={t("chat.inherited")} label={t("chat.inherited")} icon={<SparkleIcon />} open={picker === "inheritance"} onToggle={() => toggle("inheritance")}><p>{t("chat.inheritHint")}</p><p>{inheritance?.memoryCount ? `${t("chat.memory")} · ${String(inheritance.memoryCount)}` : t("chat.noMemory")}</p><p>{inheritance?.evolutionRevisionId ? `${t("chat.evolution")} · ${inheritance.evolutionRevisionId}` : t("chat.noEvolution")}</p></PickerButton>
        </div> : null}
        {conversation === null ? null : <ConversationContext conversation={conversation} onCancel={childId => void api.cancelConversationChild(conversation.conversationId,childId).catch(showError)} />}
        <form className="chat-composer" onSubmit={e => { e.preventDefault();void send(); }}>
          {draft.attachments.length === 0 ? null : <div className="chat-attachment-chips">{draft.attachments.map(a => <span key={a.attachmentId}><PaperclipIcon />{a.filename}<button aria-label={`${t("chat.remove")} ${a.filename}`} onClick={() => patchDraft({ attachments: draft.attachments.filter(f => f.attachmentId !== a.attachmentId) })} type="button"><XIcon /></button></span>)}</div>}
          <textarea aria-label={t("chat.message")} disabled={submitting} maxLength={64000} onChange={e => patchDraft({ text: e.target.value })} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault();void send(); } }} placeholder={t("chat.placeholder")} rows={3} value={draft.text} />
          <div className="chat-composer-toolbar"><PickerButton name={t("chat.attachments")} label="" icon={<PlusIcon />} open={picker === "attachments"} onToggle={() => toggle("attachments")}><button disabled={uploading || draft.attachments.length >= 16} onClick={() => fileInput.current?.click()} type="button"><PaperclipIcon />{t("chat.addFiles")}</button>{draft.attachments.map(a => <small key={a.attachmentId}>{a.filename}</small>)}</PickerButton>
            <PickerButton name={t("chat.network")} label={native ? engine : selectedNetwork?.displayName ?? t("chat.chooseNetwork")} icon={<NetworkIcon />} disabled={native} open={picker === "network"} onToggle={() => toggle("network")}><div role="listbox" aria-label={t("chat.network")}>{networks.map(n => <button aria-selected={draft.networkId === n.sourceId} disabled={n.status !== "READY"} key={n.sourceId} onClick={() => { patchDraft({ networkId: n.sourceId });setPicker(null); }} role="option" type="button"><span>{n.displayName}<small>{n.activeModel.id} · {n.status}</small></span></button>)}</div><p>{t("chat.networkHint")}</p><button onClick={onSettings} type="button"><GearSixIcon />{t("chat.settings")}</button></PickerButton>
            <PickerButton name={t("chat.partner")} label={selectedPartner?.displayName ?? "joi"} icon={<RobotIcon />} open={picker === "partner"} onToggle={() => toggle("partner")}><div role="listbox" aria-label={t("chat.partner")}><button aria-selected={draft.partnerId === "joi-chat"} onClick={() => { patchDraft({ partnerId: "joi-chat",skills: [] });setPicker(null); }} role="option" type="button">joi<small>Pi</small></button>{partners.map(p => <button aria-selected={draft.partnerId === p.partnerId} key={p.partnerId} onClick={() => { patchDraft({ partnerId: p.partnerId,skills: p.skills });setPicker(null); }} role="option" type="button">{p.displayName}<small>{p.engine}</small></button>)}</div></PickerButton>
            <PickerButton name={t("chat.skills")} label={<>{t("chat.skills")}{draft.skills.length > 0 ? ` · ${String(draft.skills.length)}` : ""}</>} icon={<SparkleIcon />} open={picker === "skills"} onToggle={() => toggle("skills")}>
              {skillOptions.length === 0 ? <p>{t("chat.noSkills")}</p> : skillOptions.map(s => <label key={s.id}><input checked={draft.skills.includes(s.id)} onChange={() => patchDraft({ skills: draft.skills.includes(s.id) ? draft.skills.filter(id => id !== s.id) : [...draft.skills,s.id] })} type="checkbox" />{s.displayName}</label>)}</PickerButton>
            <button aria-label={t("chat.settings")} className="chat-settings-button" onClick={onSettings} title="Ctrl / ⌘ + ," type="button"><GearSixIcon /></button>
            {native ? null : <label className="chat-subagent-switch"><input checked={draft.subagentsEnabled ?? true} onChange={event => patchDraft({ subagentsEnabled: event.target.checked })} type="checkbox" />{t("chat.subagents")}</label>}
            {busy ? <button aria-label={t("chat.stop")} className="chat-send is-stop" onClick={() => void api.stopConversation(draft.id).then(() => api.getConversation(draft.id)).then(setConversation).catch(showError)} type="button"><StopIcon weight="fill" /></button>
              : <button aria-label={t("chat.send")} className="chat-send" disabled={submitting || restoring || uploading || draft.text.trim() === "" || draft.workbenchId === "" || (!native && selectedNetwork?.status !== "READY")} type="submit"><ArrowUpIcon weight="bold" /></button>}
          </div></form><input hidden multiple onChange={e => void upload(e.target.files)} ref={fileInput} type="file" />
        <div className="chat-composer-footnote"><span>{t("chat.shortcut")}</span><span>{native ? t("chat.nativeNetwork") : networks.length === 0 ? t("chat.noNetwork") : t("chat.locked")}</span></div>
      </div>
    </section>
    <WorkspaceResizeHandle enabled={workspaceVisible} historyOpen={historyOpen} layout={layout} />
    {conversation === null ? null : <ConversationWorkspace api={api} conversation={conversation} workbenchId={draft.workbenchId} workbenchName={selectedWorkbench?.name ?? ""} />}
  </div>;
}
