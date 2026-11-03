import { noticeMessage, t, useI18n, useNotice } from "./i18n";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { JoiAcceptedMessageDto, WorkbenchDto } from "../shared/joi.js";
import { workbenchCreationSuggestions, type WorkbenchSuggestion } from "../shared/workbench-suggestions.js";
import type { DigitalLifeApi } from "./api.js";

export function WorkbenchChoiceForm({ api, message, workbenches, onResolved }: {
  api: DigitalLifeApi;
  message: Pick<JoiAcceptedMessageDto, "inputId" | "questionId" | "questionVersion" | "workbenchProposal" | "textPreview">;
  workbenches: WorkbenchDto[];
  onResolved: () => void;
}) {
  useI18n();
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState(false);
  const [name, setName] = useState("");
  const [projectLabel, setProjectLabel] = useState("");
  const [scopeSummary, setScopeSummary] = useState("");
  const [choices] = useState(() => workbenchCreationSuggestions({ seed: message.textPreview ?? "", ...(message.workbenchProposal === undefined ? {} : { proposal: message.workbenchProposal }) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useNotice();
  const inFlight = useRef(false);
  const question = {
    questionId: message.questionId ?? `legacy_question:${message.inputId}`,
    questionVersion: message.questionVersion ?? 1,
  };
  const run = async (operation: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await operation(); onResolved(); }
    catch { setError(noticeMessage("workbenches.workbenchSelectionDidNotCompleteRefreshTaskStatusAnd")); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const create = (choice: WorkbenchSuggestion, index: number) => {
    void run(() => api.createWorkbench({
      name: choice.name, projectLabel: choice.projectLabel, scopeSummary: choice.scopeSummary,
      personaSummary: choice.personaSummary,
      bindInputId: message.inputId, ...question,
      idempotencyKey: `workbench-choice:${message.inputId}:v${String(question.questionVersion)}:option:${String(index)}`,
    }));
  };
  const createManual = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || !projectLabel.trim() || !scopeSummary.trim()) return;
    void run(() => api.createWorkbench({
      name: name.trim(), projectLabel: projectLabel.trim(), scopeSummary: scopeSummary.trim(),
      personaSummary: "围绕已确认的工程目标和工作范围推进，以可验证的证据记录结论。",
      bindInputId: message.inputId, ...question,
      idempotencyKey: `workbench-choice:${message.inputId}:v${String(question.questionVersion)}:manual`,
    }));
  };
  const normalized = query.trim().toLocaleLowerCase();
  const visible = workbenches.filter((workbench) => `${workbench.name} ${workbench.scopeSummary}`.toLocaleLowerCase().includes(normalized));
  return <div className="joi-workbench-choice" aria-busy={busy}>
    <p>{t("workbenches.chooseAnExistingWorkbenchOrCreateASeparateScope")}</p>
    {manual ? <form className="joi-workbench-choice-form" onSubmit={createManual}>
      <label>{t("workbenches.workbenchName")}<input autoFocus disabled={busy} maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} /></label>
      <label>{t("home.projectName")}<input disabled={busy} maxLength={120} onChange={(event) => setProjectLabel(event.target.value)} required value={projectLabel} /></label>
      <label>{t("workbenches.workScope")}<textarea disabled={busy} maxLength={1000} onChange={(event) => setScopeSummary(event.target.value)} required rows={3} value={scopeSummary} /></label>
      <div className="row-actions">
        <button className="button primary" disabled={busy} type="submit">{busy ? t("workbenches.creating") : t("workbenches.createAndContinue")}</button>
        <button className="button quiet" disabled={busy} onClick={() => { setManual(false); setError(null); }} type="button">{t("workbenches.backToSelection")}</button>
      </div>
    </form> : <>
      {workbenches.length > 6 ? <label className="joi-clarify-workbench-search">{t("home.searchWorkbenches")}<input disabled={busy} onChange={(event) => setQuery(event.target.value)} type="search" value={query} /></label> : null}
      <div className="joi-clarify-workbench-list" role="group" aria-label={t("workbenches.chooseAWorkbenchToContinue")}>
        {visible.map((workbench) => <button aria-label={workbench.name} className="joi-clarify-workbench-option" disabled={busy} key={workbench.workbenchId} onClick={() => void run(() => api.clarifyJoiMessage(message.inputId, { workbenchId: workbench.workbenchId, ...question }))} type="button">
          <strong>{workbench.name}</strong><span>{workbench.scopeSummary}</span>
        </button>)}
        {visible.length === 0 ? <p>{t("workbenches.noMatchingWorkbenchesYouCanCreateOne")}</p> : null}
      </div>
    <div className="joi-workbench-prepared" role="group" aria-label={t("workbenches.preparedChoices")}>
      <h3>{t("workbenches.preparedChoices")}</h3>
      <div className="joi-workbench-prepared-options">
        {choices.map((choice, index) => <button aria-label={t("workbenches.createSuggestion", { name: choice.name })} className="joi-clarify-workbench-option" disabled={busy} key={choice.name} onClick={() => create(choice, index)} type="button">
          <strong>{choice.name}</strong><span>{choice.scopeSummary}</span><small>{t("workbenches.autoGenerated")} · {t("workbenches.createAndContinue")}</small>
        </button>)}
        <button aria-label={t("workbenches.manualCreate")} className="joi-clarify-workbench-option" disabled={busy} onClick={() => { setManual(true); setError(null); }} type="button">
          <strong>{t("workbenches.manualCreate")}</strong><span>{t("workbenches.manualCreateDescription")}</span>
        </button>
      </div>
    </div>
    </>}
    {error === null ? null : <p className="inline-notice danger" role="alert">{error}</p>}
  </div>;
}

export function WorkbenchChoiceDialog({ api, message, workbenches, onResolved, onClose }: {
  api: DigitalLifeApi; message: JoiAcceptedMessageDto; workbenches: WorkbenchDto[]; onResolved: () => void; onClose: () => void;
}) {
  useI18n();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const isBusy = () => dialog.current?.querySelector('[aria-busy="true"]') !== null;
  return <div className="joi-workbench-choice-overlay" onClick={() => { if (!isBusy()) onClose(); }}>
    <section aria-label={t("home.chooseWorkbench")} aria-modal="true" className="joi-workbench-choice-dialog" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); if (!isBusy()) onClose(); }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])];
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? index <= 0 ? focusable.at(-1) : focusable[index - 1] : focusable[index + 1] ?? focusable[0];
      event.preventDefault(); (next ?? dialog.current)?.focus();
    }} ref={dialog} role="dialog" tabIndex={-1}>
      <header><h2>{t("home.chooseWorkbench")}</h2><button className="button quiet" onClick={() => { if (!isBusy()) onClose(); }} type="button">{t("workbenches.chooseLater")}</button></header>
      <WorkbenchChoiceForm api={api} message={message} onResolved={onResolved} workbenches={workbenches} />
    </section>
  </div>;
}
