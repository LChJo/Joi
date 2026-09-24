import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

import type { AutomationDto, AutomationFrequency, CreateAutomationInput, UpdateAutomationInput } from "../shared/automation";
import type { JoiGoalCardDto, PartnerDto, WorkbenchDto } from "../shared/joi";
import { ApiError, type DigitalLifeApi } from "./api";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// Recent runs are history, not the Routine's current state: keep them folded so
// the list stays scannable, and let the summary carry the latest outcome.
function AutomationRuns({ item, onOpenJoi }: { item: AutomationDto; onOpenJoi: (() => void) | undefined }) {
  const recent = item.runs.slice(-10);
  const latest = recent.at(-1);
  if (latest === undefined) return null;
  return <details className="automation-runs">
    <summary><span>运行记录</span><small>{String(recent.length)} 次 · 最近 {latest.status}</small></summary>
    {recent.map((run) => <small key={run.runId}>{run.status} · {new Date(run.occurrenceAt).toLocaleString()} · 合并 {run.mergeCount}{run.reasonCode === undefined ? "" : ` · ${run.reasonCode}`}{run.inputId === undefined || onOpenJoi === undefined ? null : <button className="button quiet automation-goal-link" onClick={onOpenJoi} type="button">查看 Joi 目标</button>}</small>)}
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
  const [notice, setNotice] = useState<string | null>(null);
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
    const timer = setTimeout(() => void load().catch(() => setNotice("没能读取定时任务。")), 0);
    return () => clearTimeout(timer);
  }, [load]);

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
        ? { goalId: formText(form, "targetGoalId"), kind: "GOAL_CONTINUATION" as const }
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
      setNotice("定时任务已保存。");
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "定时任务未保存。");
    }
  };

  const toggle = async (item: AutomationDto) => {
    try { await api.updateAutomation(item.routineId, { enabled: !item.enabled }); await load(); }
    catch { setNotice("定时任务状态未更新。"); }
  };
  const runNow = async (item: AutomationDto) => {
    try { await api.runAutomationNow(item.routineId); await load(); setNotice(item.target.kind === "GOAL_CONTINUATION" ? "已触发；原任务未收官时会自动等待。" : "已加入 Joi 目标流。"); }
    catch { setNotice("定时任务未执行。"); }
  };
  const remove = async (item: AutomationDto) => {
    if (!window.confirm("删除后不会取消已经进入 Joi 目标流的输入。继续吗？")) return;
    try { await api.deleteAutomation(item.routineId); await load(); }
    catch { setNotice("定时任务未删除。"); }
  };

  return <section className="page-section automation-page">
    <header className="page-title-row"><div><p className="eyebrow">按节奏推进</p><h1>定时任务</h1><p>到点创建新任务，或在已有任务收官后继续同一张卡片。</p></div><button className="button primary" onClick={openNewEditor} type="button">新建定时任务</button></header>
    {notice === null ? null : <div className="inline-notice info" role="status">{notice}</div>}
    {formOpen ? <form className="automation-editor" key={selected ?? "new"} onSubmit={(event) => void save(event)}>
      <label>任务类型<select disabled={selectedBusy} name="targetKind" onChange={(event) => setTargetKind(event.target.value as "NEW_GOAL" | "GOAL_CONTINUATION")} value={targetKind}><option value="NEW_GOAL">创建新任务</option><option value="GOAL_CONTINUATION">继续已有任务</option></select></label>
      {targetKind === "GOAL_CONTINUATION" ? <>
        <label>关联任务<select disabled={selectedBusy} name="targetGoalId" onChange={(event) => setTargetGoalId(event.target.value)} required value={targetGoalId}><option value="">请选择任务卡片</option>{goals.map((goal) => <option key={goal.goalId} value={goal.goalId}>{goal.title}</option>)}</select></label>
        <p className="field-hint">运行中的任务会等到收官后再继续，错过的触发会合并一次。</p>
      </> : null}
      <label>名称<input defaultValue={selectedItem?.name ?? ""} name="name" required /></label>
      <label>{targetKind === "GOAL_CONTINUATION" ? "续聊指令" : "提示词"}<textarea defaultValue={selected === null ? "" : prompt[selected] ?? ""} name="prompt" placeholder={selected === null ? (targetKind === "GOAL_CONTINUATION" ? "到点后，让 joi 接着这条任务做什么？" : "这条定时任务到点执行什么？") : "保持空白不会改动已保存的提示词"} required={selected === null} /></label>
      {targetKind === "NEW_GOAL" ? <>
        <label>Workbench<select defaultValue={selectedItem?.workbenchId ?? workbenches[0]?.workbenchId} name="workbenchId" required>{workbenches.map((workbench) => <option key={workbench.workbenchId} value={workbench.workbenchId}>{workbench.name}</option>)}</select></label>
        <label>偏好搭档<select defaultValue={selectedItem?.preferredPartnerId ?? ""} name="preferredPartnerId"><option value="">遵循 Joi 当前策略</option>{partners.map((partner) => <option key={partner.partnerId} value={partner.partnerId}>{partner.displayName}</option>)}</select></label>
      </> : null}
      <label>频率<select onChange={(event) => setFrequencyKind(event.target.value as AutomationFrequency["kind"])} value={frequencyKind} name="kind"><option value="cycle">周期</option><option value="interval">间隔</option><option value="once">一次</option><option value="rrule">RRULE</option></select></label>
      {frequencyKind === "cycle" ? <>
        <label>周期单位<select onChange={(event) => setCycleUnit(event.target.value as "day" | "week" | "month")} value={cycleUnit} name="unit"><option value="day">每天</option><option value="week">每周</option><option value="month">每月</option></select></label>
        <label>本地时间<input defaultValue={selectedFrequency?.kind === "cycle" ? selectedFrequency.localTime : "09:00"} name="localTime" pattern="[0-9]{2}:[0-9]{2}" required type="time" /></label>
        {cycleUnit === "week" ? <fieldset className="automation-weekdays"><legend>星期（周一为 0）</legend>{WEEKDAYS.map((label, index) => <label key={label}><input defaultChecked={selectedFrequency?.kind === "cycle" && selectedFrequency.daysOfWeek?.includes(index)} name="daysOfWeek" type="checkbox" value={index} />{label}</label>)}</fieldset> : null}
        {cycleUnit === "month" ? <label>月日<input defaultValue={selectedFrequency?.kind === "cycle" ? selectedFrequency.daysOfMonth?.join(",") : ""} inputMode="numeric" name="daysOfMonth" placeholder="1,15,31" required /></label> : null}
      </> : null}
      {frequencyKind === "interval" ? <label>间隔小时<input defaultValue={selectedFrequency?.kind === "interval" ? selectedFrequency.hours : 1} min="0.083334" name="hours" required step="any" type="number" /></label> : null}
      {frequencyKind === "once" ? <label>一次时间<input defaultValue={selectedFrequency?.kind === "once" ? datetimeLocal(selectedFrequency.at) : ""} name="at" required type="datetime-local" /></label> : null}
      {frequencyKind === "rrule" ? <>
        <label>RRULE<input defaultValue={selectedFrequency?.kind === "rrule" ? selectedFrequency.rule : ""} name="rule" placeholder="FREQ=DAILY;BYHOUR=9;BYMINUTE=0" required /></label>
        <label>RRULE 起点<input defaultValue={selectedFrequency?.kind === "rrule" ? datetimeLocal(selectedFrequency.dtStart) : ""} name="dtStart" type="datetime-local" /></label>
      </> : null}
      <label>开始日期<input defaultValue={selectedItem?.from ?? ""} name="from" type="date" /></label><label>结束日期<input defaultValue={selectedItem?.to ?? ""} name="to" type="date" /></label>
      <output aria-label="下次执行预览" className="automation-preview">{selectedItem?.nextRunAt === undefined ? "保存后显示下次执行时间" : `下次执行：${new Date(selectedItem.nextRunAt).toLocaleString()}`}</output>
      <div className="row-actions"><button className="button primary" type="submit">保存</button><button className="button ghost" onClick={closeEditor} type="button">取消</button></div>
    </form> : null}
    <div className="automation-list">{items.length === 0 ? <p className="empty-line">还没有定时任务。</p> : items.map((item) => <article className="automation-row" key={item.routineId}><div><strong>{item.name}</strong><small>{item.target.kind === "NEW_GOAL" ? "创建新任务" : `继续：${goals.find((goal) => goal.goalId === continuationGoalId(item))?.title ?? "已移除的任务"}`} · {item.lifecycle} · {item.nextRunAt === undefined ? "没有下次执行" : `下次 ${new Date(item.nextRunAt).toLocaleString()}`}</small><span>{item.promptConfigured ? "提示词已配置" : "缺少提示词"}</span><AutomationRuns item={item} onOpenJoi={onOpenJoi} /></div><div className="row-actions"><button className="button quiet" onClick={() => void (async () => { try { const value = await api.revealAutomationPrompt(item.routineId); setPrompt((current) => ({ ...current, [item.routineId]: value.prompt })); setFrequencyKind(item.frequency.kind); setCycleUnit(item.frequency.kind === "cycle" ? item.frequency.unit : "day"); setTargetKind(item.target.kind); setTargetGoalId(continuationGoalId(item)); setSelected(item.routineId); setFormOpen(true); setNotice("提示词已显示在编辑器中。"); } catch { setNotice("提示词未读取。"); } })()} type="button">查看提示词</button><button className="button quiet" onClick={() => { setFrequencyKind(item.frequency.kind); setCycleUnit(item.frequency.kind === "cycle" ? item.frequency.unit : "day"); setTargetKind(item.target.kind); setTargetGoalId(continuationGoalId(item)); setSelected(item.routineId); setFormOpen(true); }} type="button">编辑</button><button className="button quiet" onClick={() => void toggle(item)} type="button">{item.enabled ? "暂停" : "恢复"}</button><button className="button quiet" onClick={() => void runNow(item)} type="button">立即执行</button><button className="button danger" onClick={() => void remove(item)} type="button">删除</button></div></article>)}</div>
  </section>;
}
