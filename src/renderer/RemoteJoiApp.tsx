import { noticeMessage, t, useI18n, useNotice } from "./i18n";
import { ArrowUpIcon, CheckCircleIcon, CircleNotchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { type SyntheticEvent, useCallback, useEffect, useMemo, useState } from "react";

import type { JoiAcceptedMessageDto, JoiHomeFeedDto } from "../shared/joi.js";
import { LanguageSelector } from "./LanguageSelector";
import { randomUuid } from "./random-uuid.js";
import { ConversationPage } from "./ConversationPage";
import { RemoteConversationApi, type RemoteConversationTransport } from "./RemoteConversationApi";
import { ArchivedConversations } from "./ArchivePage";

export interface RemoteJoiConnection {
  command?: RemoteConversationTransport["command"];
  feed(): Promise<JoiHomeFeedDto>;
  sendMessage(text: string, idempotencyKey: string): Promise<JoiAcceptedMessageDto>;
  status(): "connected" | "connecting" | "disconnected";
}

const EMPTY_FEED: JoiHomeFeedDto = { goals: [], thinking: [], unassignedActions: [] };

function statusLabel(status: RemoteJoiConnection["status"] extends () => infer T ? T : never): string {
  if (status === "connected") return t("remote.securelyConnected");
  if (status === "connecting") return t("remote.connectingToJoi");
  return t("remote.disconnected");
}

function goalStatus(status: JoiHomeFeedDto["goals"][number]["status"]): string {
  if (status === "RUNNING") return t("home.executing");
  if (status === "ARRANGING") return t("home.planning");
  if (status === "ARRANGED") return t("home.queued");
  if (status === "REVIEWING") return t("home.reviewing");
  if (status === "EXTENDING") return t("remote.extending");
  if (status === "FINALIZING") return t("home.summarizing");
  if (status === "COMPLETED") return t("status.completed");
  if (status === "COMPLETED_WITH_GAPS") return t("home.completedWithGaps");
  if (status === "NEEDS_ATTENTION") return t("home.needsYou");
  if (status === "FAILED") return t("home.failed763284");
  return t("status.canceled");
}

function workSummary(work: JoiHomeFeedDto["goals"][number]["work"]): string {
  const parts: string[] = [];
  if (work.active > 0) parts.push(t("remote.valueExecuting", { p0: String(work.active) }));
  if (work.completed > 0) parts.push(t("remote.valueCompleted", { p0: String(work.completed) }));
  if (work.failed > 0) parts.push(t("remote.valueIssues", { p0: String(work.failed) }));
  return parts.length === 0 ? t("remote.joiIsOrganizingTheWork") : parts.join(" · ");
}

export function RemoteJoiApp({ connection }: { connection: RemoteJoiConnection }) {
  useI18n();
  const [feed, setFeed] = useState(EMPTY_FEED);
  const [connectionStatus, setConnectionStatus] = useState(connection.status());
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useNotice();
  const [sending, setSending] = useState(false);
  const [section,setSection] = useState<"tasks" | "conversations" | "archived">("tasks");
  const conversationApi = useMemo(() => new RemoteConversationApi({ command: (command,signal) => {
    if (connection.command === undefined) return Promise.reject(new Error("remote_upgrade_required"));
    return connection.command(command,signal);
  } }),[connection]);

  const refresh = useCallback(async () => {
    try {
      setFeed(await connection.feed());
      setConnectionStatus("connected");
    } catch {
      setConnectionStatus(connection.status());
    }
  }, [connection]);

  useEffect(() => {
    if (section !== "tasks") return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { window.clearInterval(timer); window.clearTimeout(initial); };
  }, [refresh,section]);
  useEffect(() => {
    const timer = window.setInterval(() => setConnectionStatus(connection.status()),1_000);
    return () => window.clearInterval(timer);
  },[connection]);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    setNotice(noticeMessage("home.sendingToJoi"));
    try {
      await connection.sendMessage(text, `remote:${randomUuid()}`);
      setDraft("");
      setNotice(noticeMessage("remote.joiReceivedItAndIsPlanning"));
      await refresh();
    } catch {
      setNotice(noticeMessage("remote.theMessageCouldNotBeDeliveredRetryWhenThe"));
    } finally {
      setSending(false);
    }
  };

  return <main className={`remote-joi-shell ${section !== "tasks" ? "remote-conversations" : ""}`}>
    <header className="remote-joi-header">
      <LanguageSelector />
      <div><span className="remote-joi-mark">joi</span><p>{t("remote.yourWorkContinuesHere")}</p></div>
      <span className={`remote-connection ${connectionStatus}`}><i aria-hidden="true" />{statusLabel(connectionStatus)}</span>
    </header>
    <nav aria-label={t("settings.mainNavigation")} className="remote-section-nav">
      <button aria-current={section === "tasks" ? "page" : undefined} onClick={() => setSection("tasks")} type="button">joi</button>
      <button aria-current={section === "conversations" ? "page" : undefined} onClick={() => setSection("conversations")} type="button">{t("chat.title")}</button>
      <button aria-current={section === "archived" ? "page" : undefined} onClick={() => setSection("archived")} type="button">{t("chat.archivedConversations")}</button>
    </nav>
    {section === "conversations" ? <ConversationPage api={conversationApi} /> : section === "archived" ? <ArchivedConversations api={conversationApi} /> : <>
    <section aria-label={t("remote.joiTasks")} className="remote-goal-list">
      {feed.goals.length === 0 ? <div className="remote-empty"><CircleNotchIcon aria-hidden /><h1>{t("remote.noTasksToShowYet")}</h1><p>{t("remote.tellJoiWhatYouWantToDoBelow")}</p></div> : feed.goals.map((goal) => <article className={`remote-goal-card ${goal.status.toLowerCase()}`} key={goal.goalId}>
        <div className="remote-goal-top"><span>{goal.workbench.name}</span><strong>{goalStatus(goal.status)}</strong></div>
        <h1>{goal.title}</h1>
        <p>{workSummary(goal.work)}</p>
        {goal.completionSummary === undefined ? null : <div className="remote-goal-result"><CheckCircleIcon aria-hidden /><span>{goal.completionSummary}</span></div>}
        {goal.status !== "NEEDS_ATTENTION" ? null : <div className="remote-goal-attention"><WarningCircleIcon aria-hidden /><span>{goal.clarification.prompt ?? t("remote.returnToTheDesktopToConfirmThisTask")}</span></div>}
      </article>)}
    </section>
    <footer className="remote-composer-wrap">
      {notice === null ? null : <div className="remote-composer-notice" role="status">{notice}</div>}
      <form className="remote-composer" onSubmit={(event) => void submit(event)}>
        <textarea aria-label={t("remote.messageJoi")} maxLength={32_000} onChange={(event) => setDraft(event.currentTarget.value)} placeholder={t("remote.tellJoiWhatToDoNext")} rows={2} value={draft} />
        <button aria-label={t("remote.send")} disabled={sending || draft.trim() === "" || connectionStatus !== "connected"} type="submit"><ArrowUpIcon aria-hidden weight="bold" /></button>
      </form>
      <p>{t("remote.remoteAccessSupportsConversationsAndTaskViewingOnly")}</p>
    </footer>
    </>}
  </main>;
}
