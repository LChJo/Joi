import { ArrowUpIcon, CheckCircleIcon, CircleNotchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";

import type { JoiAcceptedMessageDto, JoiHomeFeedDto } from "../shared/joi.js";

export interface RemoteJoiConnection {
  feed(): Promise<JoiHomeFeedDto>;
  sendMessage(text: string, idempotencyKey: string): Promise<JoiAcceptedMessageDto>;
  status(): "connected" | "connecting" | "disconnected";
}

const EMPTY_FEED: JoiHomeFeedDto = { goals: [], thinking: [], unassignedActions: [] };

function statusLabel(status: RemoteJoiConnection["status"] extends () => infer T ? T : never): string {
  if (status === "connected") return "已安全连接";
  if (status === "connecting") return "正在连接 joi";
  return "连接已断开";
}

function goalStatus(status: JoiHomeFeedDto["goals"][number]["status"]): string {
  if (status === "RUNNING") return "执行中";
  if (status === "ARRANGING" || status === "ARRANGED") return "正在安排";
  if (status === "REVIEWING") return "正在评审";
  if (status === "EXTENDING") return "补充执行";
  if (status === "FINALIZING") return "正在总结";
  if (status === "COMPLETED") return "已完成";
  if (status === "NEEDS_ATTENTION") return "需要你";
  if (status === "FAILED") return "处理失败";
  return "已取消";
}

function workSummary(work: JoiHomeFeedDto["goals"][number]["work"]): string {
  const parts: string[] = [];
  if (work.active > 0) parts.push(`${String(work.active)} 项执行中`);
  if (work.completed > 0) parts.push(`${String(work.completed)} 项已完成`);
  if (work.failed > 0) parts.push(`${String(work.failed)} 项异常`);
  return parts.length === 0 ? "joi 正在梳理" : parts.join(" · ");
}

export function RemoteJoiApp({ connection }: { connection: RemoteJoiConnection }) {
  const [feed, setFeed] = useState(EMPTY_FEED);
  const [connectionStatus, setConnectionStatus] = useState(connection.status());
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setFeed(await connection.feed());
      setConnectionStatus("connected");
    } catch {
      setConnectionStatus(connection.status());
    }
  }, [connection]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { window.clearInterval(timer); window.clearTimeout(initial); };
  }, [refresh]);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    setNotice("正在交给 joi…");
    try {
      const randomId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      await connection.sendMessage(text, `remote:${randomId}`);
      setDraft("");
      setNotice("joi 已收到，正在安排。");
      await refresh();
    } catch {
      setNotice("消息没能送达，请等连接恢复后重试。");
    } finally {
      setSending(false);
    }
  };

  return <main className="remote-joi-shell">
    <header className="remote-joi-header">
      <div><span className="remote-joi-mark">joi</span><p>你的工作正在这里继续</p></div>
      <span className={`remote-connection ${connectionStatus}`}><i aria-hidden="true" />{statusLabel(connectionStatus)}</span>
    </header>
    <section aria-label="joi 任务" className="remote-goal-list">
      {feed.goals.length === 0 ? <div className="remote-empty"><CircleNotchIcon aria-hidden /><h1>还没有正在展示的任务</h1><p>在下面告诉 joi 你想做什么。</p></div> : feed.goals.map((goal) => <article className={`remote-goal-card ${goal.status.toLowerCase()}`} key={goal.goalId}>
        <div className="remote-goal-top"><span>{goal.workbench.name}</span><strong>{goalStatus(goal.status)}</strong></div>
        <h1>{goal.title}</h1>
        <p>{workSummary(goal.work)}</p>
        {goal.completionSummary === undefined ? null : <div className="remote-goal-result"><CheckCircleIcon aria-hidden /><span>{goal.completionSummary}</span></div>}
        {goal.status !== "NEEDS_ATTENTION" ? null : <div className="remote-goal-attention"><WarningCircleIcon aria-hidden /><span>{goal.clarification.prompt ?? "这个任务需要你回到桌面确认。"}</span></div>}
      </article>)}
    </section>
    <footer className="remote-composer-wrap">
      {notice === null ? null : <div className="remote-composer-notice" role="status">{notice}</div>}
      <form className="remote-composer" onSubmit={(event) => void submit(event)}>
        <textarea aria-label="给 joi 发消息" maxLength={32_000} onChange={(event) => setDraft(event.currentTarget.value)} placeholder="告诉 joi 接下来要做什么…" rows={2} value={draft} />
        <button aria-label="发送" disabled={sending || draft.trim() === "" || connectionStatus !== "connected"} type="submit"><ArrowUpIcon aria-hidden weight="bold" /></button>
      </form>
      <p>远程页面仅支持对话与任务查看</p>
    </footer>
  </main>;
}
