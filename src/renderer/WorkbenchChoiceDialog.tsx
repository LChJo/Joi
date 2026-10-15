import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { JoiAcceptedMessageDto, WorkbenchDto } from "../shared/joi.js";
import type { DigitalLifeApi } from "./api.js";

export function WorkbenchChoiceForm({ api, message, workbenches, onResolved }: {
  api: DigitalLifeApi;
  message: Pick<JoiAcceptedMessageDto, "inputId" | "questionId" | "questionVersion" | "workbenchProposal">;
  workbenches: WorkbenchDto[];
  onResolved: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [name, setName] = useState(message.workbenchProposal?.name ?? "");
  const [projectLabel, setProjectLabel] = useState(message.workbenchProposal?.projectLabel ?? "");
  const [scopeSummary, setScopeSummary] = useState(message.workbenchProposal?.scopeSummary ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const question = {
    questionId: message.questionId ?? `legacy_question:${message.inputId}`,
    questionVersion: message.questionVersion ?? 1,
  };
  const run = async (operation: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await operation(); onResolved(); }
    catch { setError("工作台选择未完成，请刷新任务状态后重试。已保留填写内容。"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const create = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || !projectLabel.trim() || !scopeSummary.trim()) return;
    void run(() => api.createWorkbench({
      name: name.trim(), projectLabel: projectLabel.trim(), scopeSummary: scopeSummary.trim(),
      personaSummary: "围绕已确认的工程目标和工作范围推进，以可验证的证据记录结论。",
      bindInputId: message.inputId, ...question,
      idempotencyKey: `workbench-choice:${message.inputId}:v${String(question.questionVersion)}`,
    }));
  };
  const normalized = query.trim().toLocaleLowerCase();
  const visible = workbenches.filter((workbench) => `${workbench.name} ${workbench.scopeSummary}`.toLocaleLowerCase().includes(normalized));
  return <div className="joi-workbench-choice" aria-busy={busy}>
    <p>选一个已有工作台，或新建独立工作范围。确认后 joi 开始安排。</p>
    {creating ? <form className="joi-workbench-choice-form" onSubmit={create}>
      <label>工作台名称<input autoFocus disabled={busy} maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} /></label>
      <label>工程名称<input disabled={busy} maxLength={120} onChange={(event) => setProjectLabel(event.target.value)} required value={projectLabel} /></label>
      <label>工作范围<textarea disabled={busy} maxLength={1000} onChange={(event) => setScopeSummary(event.target.value)} required rows={4} value={scopeSummary} /></label>
      <div className="row-actions">
        <button className="button primary" disabled={busy} type="submit">{busy ? "正在创建…" : "创建并继续"}</button>
        <button className="button quiet" disabled={busy} onClick={() => { setCreating(false); setError(null); }} type="button">返回选择</button>
      </div>
    </form> : <>
      {workbenches.length > 6 ? <label className="joi-clarify-workbench-search">搜索工作台<input disabled={busy} onChange={(event) => setQuery(event.target.value)} type="search" value={query} /></label> : null}
      <div className="joi-clarify-workbench-list" role="group" aria-label="选择一个工作台继续">
        {visible.map((workbench) => <button aria-label={workbench.name} className="joi-clarify-workbench-option" disabled={busy} key={workbench.workbenchId} onClick={() => void run(() => api.clarifyJoiMessage(message.inputId, { workbenchId: workbench.workbenchId, ...question }))} type="button">
          <strong>{workbench.name}</strong><span>{workbench.scopeSummary}</span>
        </button>)}
        {visible.length === 0 ? <p>没有匹配的工作台，可以新建。</p> : null}
      </div>
      <button className="button primary" disabled={busy} onClick={() => setCreating(true)} type="button">新建工作台</button>
    </>}
    {error === null ? null : <p className="inline-notice danger" role="alert">{error}</p>}
  </div>;
}

export function WorkbenchChoiceDialog({ api, message, workbenches, onResolved, onClose }: {
  api: DigitalLifeApi; message: JoiAcceptedMessageDto; workbenches: WorkbenchDto[]; onResolved: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const isBusy = () => dialog.current?.querySelector('[aria-busy="true"]') !== null;
  return <div className="joi-workbench-choice-overlay" onClick={() => { if (!isBusy()) onClose(); }}>
    <section aria-label="选择工作台" aria-modal="true" className="joi-workbench-choice-dialog" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); if (!isBusy()) onClose(); }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])];
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? index <= 0 ? focusable.at(-1) : focusable[index - 1] : focusable[index + 1] ?? focusable[0];
      event.preventDefault(); (next ?? dialog.current)?.focus();
    }} ref={dialog} role="dialog" tabIndex={-1}>
      <header><h2>选择工作台</h2><button className="button quiet" onClick={() => { if (!isBusy()) onClose(); }} type="button">稍后选择</button></header>
      <WorkbenchChoiceForm api={api} message={message} onResolved={onResolved} workbenches={workbenches} />
    </section>
  </div>;
}
