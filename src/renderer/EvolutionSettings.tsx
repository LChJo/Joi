import { useEffect, useState } from "react";
import type { DigitalLifeApi } from "./api";
import type { EvolutionBudgetPreset, EvolutionBudgetPresetKey, EvolutionReason, EvolutionStatusDto } from "../shared/evolution";
import { EVOLUTION_BUDGET_PRESETS } from "../shared/evolution";

const labels: Record<EvolutionReason, string> = {
  collecting: "正在积累可评价的经验", disabled: "尚未启用自动进化", budget_exhausted: "今日预算已用完，下个计费日继续", evaluating: "正在评估候选策略",
  promoted: "已启用通过评测的策略", rolled_back: "已暂停自动进化；回退后的策略用于新目标", model_changed: "模型或评测环境已变化，等待重新评估",
  insufficient_samples: "评测样本不足，保留当前策略", insufficient_gain: "改善幅度不足，保留当前策略", quality_regression: "候选质量下降，已拒绝",
  cost_regression: "候选调用成本超限，已拒绝", hard_violation: "候选违反完成约束，已拒绝", invalid_evaluation: "评测无效，保留当前策略",
  invalid_candidate: "候选缺少充分证据，保留当前策略", call_failed: "后台调用未完成，保留当前策略",
};
const presetLabels: Record<EvolutionBudgetPresetKey, string> = { off: "关", low: "低", medium: "中", high: "高" };
const presetHints: Record<EvolutionBudgetPresetKey, string> = {
  off: "只记录经验，不发起任何模型评测。",
  low: "约两周跑完一轮完整评测，最省调用；适合长期后台慢慢验证。",
  medium: "约五天跑完一轮完整评测，速度与花费均衡。",
  high: "约两天跑完一轮完整评测，最快看到结果，单日花费也最高。",
};
const presetName = (preset: EvolutionBudgetPreset) => preset.key === "off" ? "关（只记录经验）" : `${presetLabels[preset.key]}（每日 ${String(preset.limit)} 次）`;
export function WorkbenchEvolutionPanel({ api, workbenchId }: { api: DigitalLifeApi; workbenchId: string }) {
  const [status, setStatus] = useState<EvolutionStatusDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let canceled = false;
    const load = () => api.evolutionStatus(workbenchId).then((value) => { if (!canceled) setStatus(value); }).catch(() => { if (!canceled) setNotice("没能读取进化状态，请稍后重试。"); });
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { canceled = true; clearInterval(timer); };
  }, [api, workbenchId]);
  const applyPreset = async (preset: EvolutionBudgetPreset) => {
    if (saving) return;
    setSaving(true);
    try {
      setStatus(await api.configureEvolution(workbenchId, preset.limit));
      setNotice(preset.limit === 0 ? "已关闭评测预算，只记录经验。" : `预算已设为「${presetLabels[preset.key]}」（每日 ${String(preset.limit)} 次），空闲时自动运行。`);
    } catch { setNotice("没能保存预算，请重试。"); } finally { setSaving(false); }
  };
  const rollback = async () => {
    if (status?.activeRevisionId == null) return;
    setSaving(true);
    try { setStatus(await api.rollbackEvolution(workbenchId, status.activeRevisionId)); setNotice("已回退并暂停自动进化，运行中的目标保留原策略。"); }
    catch { setNotice("没能回退策略，请刷新状态后重试。"); } finally { setSaving(false); }
  };
  const current = status === null ? null : EVOLUTION_BUDGET_PRESETS.find((preset) => preset.limit === status.dailyCallLimit) ?? null;
  return <div className="inline-settings workbench-evolution-panel">
    <p className="workbench-evolution-intro">从执行经验中改进本工作台的上下文整理和完成检查。只有独立评测确认改善后，新目标才会使用新策略。</p>
    {notice === null ? null : <p role="status">{notice}</p>}
    {status === null ? <p>正在读取进化状态…</p> : <>
      <p>{labels[status.reason]}</p>
      <fieldset className="evolution-budget-presets" disabled={saving}>
        <legend>每日模型调用上限</legend>
        <div className="evolution-budget-options">
          {EVOLUTION_BUDGET_PRESETS.map((preset) => <label key={preset.key}>
            <input aria-label={presetName(preset)} checked={status.dailyCallLimit === preset.limit} name="evolution-budget" onChange={() => void applyPreset(preset)} type="radio" value={preset.limit} />
            {presetLabels[preset.key]}
          </label>)}
        </div>
      </fieldset>
      <p className="field-hint">{current === null ? `当前为自定义额度：每日 ${String(status.dailyCallLimit)} 次；选择预设可覆盖。` : presetHints[current.key]}</p>
      <p className="field-hint">额度按 UTC 日重置，只在工作台空闲时使用，日常任务永远优先；一轮完整评测约需 700–1450 次调用，可跨多天完成，不影响日常任务预算。</p>
      <p>今日调用 {status.callsUsedToday} / {status.dailyCallLimit} · 已记录 {status.evidenceCount} 个目标，其中 {status.evaluableCount} 个可客观评价</p>
      <h3>策略历史</h3>
      {status.versions.length === 0 ? <p>尚无候选策略，积累足够证据后自动评估。</p> : <ul>{status.versions.map((version) => <li key={version.revisionId}>
        <strong>{version.module === "context" ? "上下文整理" : "完成检查"}</strong> · {labels[version.reason]}<br />
        <small>{version.createdAt.slice(0, 10)} · 已评测 {version.evaluatedRuns} 次 · 原策略通过 {version.baselineSuccesses} 次 / 候选通过 {version.candidateSuccesses} 次</small>
      </li>)}</ul>}
      {status.activeRevisionId === null ? null : <button className="button ghost" type="button" disabled={saving} onClick={() => void rollback()}>回退当前策略并暂停</button>}
    </>}
  </div>;
}
