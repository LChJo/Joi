import { currentLocale, noticeMessage, t, useI18n, useNotice } from "./i18n";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

import type { AutomationDto, AutomationFrequency, CreateAutomationInput, UpdateAutomationInput } from "../shared/automation";
import type { JoiGoalCardDto, PartnerDto, WorkbenchDto } from "../shared/joi";
import { ApiError, type DigitalLifeApi } from "./api";

const WEEKDAYS = () => [t("common.weekdayMonday"), t("common.weekdayTuesday"), t("common.weekdayWednesday"), t("common.weekdayThursday"), t("common.weekdayFriday"), t("common.weekdaySaturday"), t("common.weekdaySunday")];

// Recent runs are history, not the Routine's current state: keep them folded so
// the list stays scannable, and let the summary carry the latest outcome.
function AutomationRuns({ item, onOpenJoi }: { item: AutomationDto; onOpenJoi: (() => void) | undefined }) {
  useI18n();
  const recent = item.runs.slice(-10);
  const latest = recent.at(-1);
  if (latest === undefined) return null;
  return <details className="automation-runs">
    <summary><span>{t("automation.activity")}</span><small>{String(recent.length)}  {t("automation.runsLast")} {latest.status}</small></summary>
    {recent.map((run) => <small key={run.runId}>{run.status} · {new Date(run.occurrenceAt).toLocaleString(currentLocale())}  {t("automation.merged")} {run.mergeCount}{run.reasonCode === undefined ? "" : ` · ${run.reasonCode}`}{run.inputId === undefined || onOpenJoi === undefined ? null : <button className="button quiet automation-goal-link" onClick={onOpenJoi} type="button">{t("automation.viewJoiGoal")}</button>}</small>)}
  </details>;
}

function formText(form: FormData, key: string, fallback = ""): string {
  const value = form.get(key);
  return typeof value === "string" ? value : fallback;
}

function datetimeLocal(value: string | undefined): string {
  if (value === undefined) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function frequencyFromForm(form: FormData): AutomationFrequency {
  const kind = formText(form, "kind", "cycle");
  if (kind === "interval") return { kind, hours: Number(formText(form, "hours", "1")) };
  if (kind === "once") return { kind, at: new Date(formText(form, "at")).toISOString() };
  if (kind === "rrule") return {
    kind,
    rule: formText(form, "rule"),
    ...(formText(form, "dtStart") === "" ? {} : { dtStart: new Date(formText(form, "dtStart")).toISOString() }),
  };
  const unit = formText(form, "unit", "day") as "day" | "week" | "month";
  const daysOfWeek = form.getAll("daysOfWeek").map(Number);
  const daysOfMonth = formText(form, "daysOfMonth").split(",").filter((value) => value.trim() !== "").map((value) => Number(value.trim()));
  return {
    kind: "cycle",
    localTime: formText(form, "localTime", "09:00"),
    unit,
    ...(unit === "week" && daysOfWeek.length > 0 ? { daysOfWeek } : {}),
    ...(unit === "month" && daysOfMonth.length > 0 ? { daysOfMonth } : {}),
  };
}

function continuationGoalId(item: AutomationDto): string {
  return item.target.kind === "GOAL_CONTINUATION" ? item.target.goalId : "";
}

export function AutomationPanel({ api, initialGoalId, onOpenJoi }: { api: DigitalLifeApi; initialGoalId?: string; onOpenJoi?: () => void }) {
  useI18n();
  const [items, setItems] = useState<AutomationDto[]>([]);
  const [workbenches, setWorkbenches] = useState<WorkbenchDto[]>([]);
  const [partners, setPartners] = useState<PartnerDto[]>([]);
  const [goals, setGoals] = useState<JoiGoalCardDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<"NEW_GOAL" | "GOAL_CONTINUATION">("NEW_GOAL");
  const [targetGoalId, setTargetGoalId] = useState("");
  const [frequencyKind, setFrequencyKind] = useState<AutomationFrequency["kind"]>("cycle");
  const [cycleUnit, setCycleUnit] = useState<"day" | "week" | "month">("day");
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useNotice();
  const [prompt, setPrompt] = useState<Record<string, string>>({});
  const consumedInitialGoal = useRef<string | undefined>(undefined);
  const selectedItem = items.find((item) => item.routineId === selected);
  const selectedFrequency = selectedItem?.frequency;
  const selectedBusy = selectedItem?.runs.some((run) => run.status === "PENDING" || run.status === "RUNNING" || run.status === "BLOCKED") ?? false;

  const openNewEditor = () => {
    setSelected(null);
    setTargetKind("NEW_GOAL");
    setTargetGoalId("");
    setFrequencyKind("cycle");
    setCycleUnit("day");
    setFormOpen(true);
  };

  const closeEditor = () => {
    setFormOpen(false);
    setSelected(null);
  };

  const load = useCallback(async () => {
    const [routines, contexts, availablePartners, feed] = await Promise.all([api.listAutomations(), api.listWorkbenches(), api.listPartners(), api.joiHomeFeed()]);
    setItems(routines.items);
    setWorkbenches(contexts.items);
    setPartners(availablePartners.items.filter((partner) => partner.status === "ACTIVE"));
    setGoals(feed.goals);
  }, [api]);

  useEffect(() => {
    const timer = setTimeout(() => void load().catch(() => setNotice(noticeMessage("automation.couldNotLoadScheduledTasks"))), 0);
    return () => clearTimeout(timer);
  }, [load, setNotice]);

  useEffect(() => {
    if (initialGoalId === undefined || consumedInitialGoal.current === initialGoalId || !goals.some((goal) => goal.goalId === initialGoalId)) return;
    consumedInitialGoal.current = initialGoalId;
    setSelected(null);
    setTargetKind("GOAL_CONTINUATION");
    setTargetGoalId(initialGoalId);
    setFrequencyKind("cycle");
    setCycleUnit("day");
    setFormOpen(true);
  }, [goals, initialGoalId]);

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const promptValue = formText(form, "prompt");
    const partnerId = formText(form, "preferredPartnerId");
    try {
      const common = {
        frequency: frequencyFromForm(form),
        name: formText(form, "name"),
        ...(formText(form, "from") === "" ? {} : { from: formText(form, "from") }),
        ...(formText(form, "to") === "" ? {} : { to: formText(form, "to") }),
      };
      const target = targetKind === "GOAL_CONTINUATION"
        ? { goalId: targetGoalId, kind: "GOAL_CONTINUATION" as const }
        : { kind: "NEW_GOAL" as const };
      if (selected === null) {
        const create: CreateAutomationInput = target.kind === "GOAL_CONTINUATION"
          ? { ...common, prompt: promptValue, target }
          : { ...common, prompt: promptValue, target, workbenchId: formText(form, "workbenchId"), ...(partnerId === "" ? {} : { preferredPartnerId: partnerId }) };
        await api.createAutomation(create);
      }
      else {
        const update: UpdateAutomationInput = {
          ...common,
          target,
          ...(promptValue === "" ? {} : { prompt: promptValue }),
          ...(target.kind === "GOAL_CONTINUATION" ? {} : {
            preferredPartnerId: partnerId === "" ? null : partnerId,
            workbenchId: formText(form, "workbenchId"),
          }),
        };
        await api.updateAutomation(selected, update);
      }
      setFormOpen(false);
      setSelected(null);
      await load();
      setNotice(noticeMessage("automation.scheduledTaskSaved"));
    } catch (error) {
      setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("automation.scheduledTaskCouldNotBeSaved"));
    }
  };

  const toggle = async (item: AutomationDto) => {
    try { await api.updateAutomation(item.routineId, { enabled: !item.enabled }); await load(); }
    catch { setNotice(noticeMessage("automation.scheduledTaskStatusCouldNotBeUpdated")); }
  };
  const runNow = async (item: AutomationDto) => {
    try { await api.runAutomationNow(item.routineId); await load(); setNotice(item.target.kind === "GOAL_CONTINUATION" ? noticeMessage("automation.triggeredItWillWaitUntilTheCurrentTaskFinishes") : noticeMessage("automation.addedToTheJoiGoalQueue")); }
    catch { setNotice(noticeMessage("automation.scheduledTaskCouldNotBeStarted")); }
  };
  const remove = async (item: AutomationDto) => {
    if (!window.confirm(t("automation.deletingWillNotCancelInputsAlreadyInTheJoi"))) return;
    try { await api.deleteAutomation(item.routineId); await load(); }
    catch { setNotice(noticeMessage("automation.scheduledTaskCouldNotBeDeleted")); }
  };

  return <section className="page-section automation-page">
    <header className="page-title-row"><div><p className="eyebrow">{t("automation.keepWorkMoving")}</p><h1>{t("common.scheduledTasks")}</h1><p>{t("automation.startANewTaskOnScheduleOrContinueAn")}</p></div><button className="button primary" onClick={openNewEditor} type="button">{t("automation.newScheduledTask")}</button></header>
    {notice === null ? null : <div className="inline-notice info" role="status">{notice}</div>}
    {formOpen ? <form className="automation-editor" key={selected ?? "new"} onSubmit={(event) => void save(event)}>
      <label>{t("automation.taskType")}<select disabled={selectedBusy} name="targetKind" onChange={(event) => setTargetKind(event.target.value as "NEW_GOAL" | "GOAL_CONTINUATION")} value={targetKind}><option value="NEW_GOAL">{t("automation.createANewTask")}</option><option value="GOAL_CONTINUATION">{t("automation.continueAnExistingTask")}</option></select></label>
      {targetKind === "GOAL_CONTINUATION" ? <>
        <label>{t("automation.linkedTask")}<select disabled={selectedBusy} name="targetGoalId" onChange={(event) => setTargetGoalId(event.target.value)} required value={targetGoalId}><option value="">{t("automation.chooseATaskCard")}</option>{goals.map((goal) => <option key={goal.goalId} value={goal.goalId}>{goal.title}</option>)}</select></label>
        <p className="field-hint">{t("automation.runningTasksContinueAfterTheyFinishMissedTriggersAre")}</p>
      </> : null}
      <label>{t("automation.name")}<input defaultValue={selectedItem?.name ?? ""} name="name" required /></label>
      <label>{targetKind === "GOAL_CONTINUATION" ? t("automation.continuationInstructions") : t("automation.prompt")}<textarea defaultValue={selected === null ? "" : prompt[selected] ?? ""} name="prompt" placeholder={selected === null ? (targetKind === "GOAL_CONTINUATION" ? t("automation.whatShouldJoiDoNextWithThisTaskWhen") : t("automation.whatShouldThisTaskDoWhenTheTimeComes")) : t("automation.leaveBlankToKeepTheSavedPrompt")} required={selected === null} /></label>
      {targetKind === "NEW_GOAL" ? <>
        <label>Workbench<select defaultValue={selectedItem?.workbenchId ?? workbenches[0]?.workbenchId} name="workbenchId" required>{workbenches.map((workbench) => <option key={workbench.workbenchId} value={workbench.workbenchId}>{workbench.name}</option>)}</select></label>
        <label>{t("automation.preferredPartner")}<select defaultValue={selectedItem?.preferredPartnerId ?? ""} name="preferredPartnerId"><option value="">{t("automation.useTheCurrentJoiPolicy")}</option>{partners.map((partner) => <option key={partner.partnerId} value={partner.partnerId}>{partner.displayName}</option>)}</select></label>
      </> : null}
      <label>{t("automation.frequency")}<select onChange={(event) => setFrequencyKind(event.target.value as AutomationFrequency["kind"])} value={frequencyKind} name="kind"><option value="cycle">{t("automation.recurring")}</option><option value="interval">{t("automation.interval")}</option><option value="once">{t("automation.once")}</option><option value="rrule">RRULE</option></select></label>
      {frequencyKind === "cycle" ? <>
        <label>{t("automation.recurrenceUnit")}<select onChange={(event) => setCycleUnit(event.target.value as "day" | "week" | "month")} value={cycleUnit} name="unit"><option value="day">{t("automation.daily")}</option><option value="week">{t("automation.weekly")}</option><option value="month">{t("automation.monthly")}</option></select></label>
        <label>{t("automation.localTime")}<input defaultValue={selectedFrequency?.kind === "cycle" ? selectedFrequency.localTime : "09:00"} name="localTime" pattern="[0-9]{2}:[0-9]{2}" required type="time" /></label>
        {cycleUnit === "week" ? <fieldset className="automation-weekdays"><legend>{t("automation.weekdayMondayIs0")}</legend>{WEEKDAYS().map((label, index) => <label key={label}><input defaultChecked={selectedFrequency?.kind === "cycle" && selectedFrequency.daysOfWeek?.includes(index)} name="daysOfWeek" type="checkbox" value={index} />{label}</label>)}</fieldset> : null}
        {cycleUnit === "month" ? <label>{t("automation.dayOfMonth")}<input defaultValue={selectedFrequency?.kind === "cycle" ? selectedFrequency.daysOfMonth?.join(",") : ""} inputMode="numeric" name="daysOfMonth" placeholder="1,15,31" required /></label> : null}
      </> : null}
      {frequencyKind === "interval" ? <label>{t("automation.intervalInHours")}<input defaultValue={selectedFrequency?.kind === "interval" ? selectedFrequency.hours : 1} min="0.083334" name="hours" required step="any" type="number" /></label> : null}
      {frequencyKind === "once" ? <label>{t("automation.runAt")}<input defaultValue={selectedFrequency?.kind === "once" ? datetimeLocal(selectedFrequency.at) : ""} name="at" required type="datetime-local" /></label> : null}
      {frequencyKind === "rrule" ? <>
        <label>RRULE<input defaultValue={selectedFrequency?.kind === "rrule" ? selectedFrequency.rule : ""} name="rule" placeholder="FREQ=DAILY;BYHOUR=9;BYMINUTE=0" required /></label>
        <label>{t("automation.rruleStart")}<input defaultValue={selectedFrequency?.kind === "rrule" ? datetimeLocal(selectedFrequency.dtStart) : ""} name="dtStart" type="datetime-local" /></label>
      </> : null}
      <label>{t("automation.startDate")}<input defaultValue={selectedItem?.from ?? ""} name="from" type="date" /></label><label>{t("automation.endDate")}<input defaultValue={selectedItem?.to ?? ""} name="to" type="date" /></label>
      <output aria-label={t("automation.nextRunPreview")} className="automation-preview">{selectedItem?.nextRunAt === undefined ? t("automation.theNextRunAppearsAfterSaving") : t("automation.nextRunValue", { p0: new Date(selectedItem.nextRunAt).toLocaleString(currentLocale()) })}</output>
      <div className="row-actions"><button className="button primary" type="submit">{t("common.save")}</button><button className="button ghost" onClick={closeEditor} type="button">{t("common.cancel")}</button></div>
    </form> : null}
    <div className="automation-list">{items.length === 0 ? <p className="empty-line">{t("automation.noScheduledTasksYet")}</p> : items.map((item) => <article className="automation-row" key={item.routineId}><div><strong>{item.name}</strong><small>{item.target.kind === "NEW_GOAL" ? t("automation.createANewTask") : t("automation.continueValue", { p0: (goals.find((goal) => goal.goalId === continuationGoalId(item))?.title ?? t("automation.removedTask")) })} · {item.lifecycle} · {item.nextRunAt === undefined ? t("automation.noNextRun") : t("automation.nextValue", { p0: new Date(item.nextRunAt).toLocaleString(currentLocale()) })}</small><span>{item.promptConfigured ? t("automation.promptConfigured") : t("automation.promptMissing")}</span><AutomationRuns item={item} onOpenJoi={onOpenJoi} /></div><div className="row-actions"><button className="button quiet" onClick={() => void (async () => { try { const value = await api.revealAutomationPrompt(item.routineId); setPrompt((current) => ({ ...current, [item.routineId]: value.prompt })); setFrequencyKind(item.frequency.kind); setCycleUnit(item.frequency.kind === "cycle" ? item.frequency.unit : "day"); setTargetKind(item.target.kind); setTargetGoalId(continuationGoalId(item)); setSelected(item.routineId); setFormOpen(true); setNotice(noticeMessage("automation.thePromptIsNowVisibleInTheEditor")); } catch { setNotice(noticeMessage("automation.thePromptCouldNotBeLoaded")); } })()} type="button">{t("automation.viewPrompt")}</button><button className="button quiet" onClick={() => { setFrequencyKind(item.frequency.kind); setCycleUnit(item.frequency.kind === "cycle" ? item.frequency.unit : "day"); setTargetKind(item.target.kind); setTargetGoalId(continuationGoalId(item)); setSelected(item.routineId); setFormOpen(true); }} type="button">{t("common.edit")}</button><button className="button quiet" onClick={() => void toggle(item)} type="button">{item.enabled ? t("common.pause") : t("common.resume")}</button><button className="button quiet" onClick={() => void runNow(item)} type="button">{t("common.runNow")}</button><button className="button danger" onClick={() => void remove(item)} type="button">{t("common.delete")}</button></div></article>)}</div>
  </section>;
}
