import { useEffect, useState } from "react";
import type { DigitalLifeApi } from "./api";
import type { EvolutionBudgetPreset, EvolutionBudgetPresetKey, EvolutionDryRunOutcome, EvolutionDryRunReportDto, EvolutionOverviewDto, EvolutionPhase, EvolutionReason, EvolutionStatusDto } from "../shared/evolution";
import { EVOLUTION_BUDGET_PRESETS, EVOLUTION_EVIDENCE_THRESHOLD, EVOLUTION_FAILURE_THRESHOLD } from "../shared/evolution";

const labels: Record<EvolutionReason, string> = {
  collecting: "正在积累可评价的经验", disabled: "尚未启用自动进化", budget_exhausted: "今日预算已用完，下个计费日继续", evaluating: "正在评估候选策略",
  canary: "候选已通过合成评测，正在小流量生产验证", revalidation_required: "模型或评测器已变化，当前策略暂停生效并等待重新验证", revision_limit_reached: "策略历史已达上限，请先审计后再继续",
  promoted: "已启用通过评测的策略", rolled_back: "已暂停自动进化；回退后的策略用于新目标", model_changed: "模型或评测环境已变化，等待重新评估",
  insufficient_samples: "评测样本不足，保留当前策略", insufficient_gain: "改善幅度不足，保留当前策略", quality_regression: "候选质量下降，已拒绝",
  cost_regression: "候选调用成本超限，已拒绝", hard_violation: "候选违反完成约束，已拒绝", invalid_evaluation: "评测无效，保留当前策略",
  invalid_candidate: "候选缺少充分证据，保留当前策略", call_failed: "后台调用未完成，保留当前策略",
  model_response_invalid: "模型响应不符合评测要求，已暂停自动进化；请检查模型源后重新启用",
};
const presetLabels: Record<EvolutionBudgetPresetKey, string> = { off: "关", low: "低", medium: "中", high: "高" };
const presetHints: Record<EvolutionBudgetPresetKey, string> = {
  off: "只记录经验，不发起任何模型评测。",
  low: "约两周跑完一轮完整评测，最省调用；适合长期后台慢慢验证。",
  medium: "约五天跑完一轮完整评测，速度与花费均衡。",
  high: "约两天跑完一轮完整评测，最快看到结果，单日花费也最高。",
};
const presetName = (preset: EvolutionBudgetPreset) => preset.key === "off" ? "关（只记录经验）" : `${presetLabels[preset.key]}（每日 ${String(preset.limit)} 次）`;
const phaseLabels: Record<EvolutionPhase, string> = { DEVELOP: "开发", PROPOSE: "提案", VALIDATE: "候选复测", EVALUATE: "封存评测" };
const dryRunOutcomes: Record<EvolutionDryRunOutcome, string> = {
  promoted: "链路跑通：批次一路走到晋升裁决。",
  rejected: "链路跑通，但候选被门禁拒绝。",
  truncated: "链路未跑完：达到了步数或时间上限。",
  not_started: "批次没能启动，合成证据未达标。",
};
export function WorkbenchEvolutionPanel({ api, workbenchId }: { api: DigitalLifeApi; workbenchId: string }) {
  const [status, setStatus] = useState<EvolutionStatusDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dryRun, setDryRun] = useState<EvolutionDryRunReportDto | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [overview, setOverview] = useState<EvolutionOverviewDto | null>(null);
  useEffect(() => {
    let canceled = false;
    const load = () => {
      void api.evolutionOverview().then((aggregate) => { if (!canceled) setOverview(aggregate); }).catch(() => undefined);
      return api.evolutionStatus(workbenchId).then((value) => { if (!canceled) setStatus(value); }).catch(() => { if (!canceled) setNotice("没能读取进化状态，请稍后重试。"); });
    };
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
    const revisionId = status?.activeRevisionId ?? status?.globalRevisionId;
    if (revisionId == null) return;
    setSaving(true);
    try { setStatus(await api.rollbackEvolution(workbenchId, revisionId)); setNotice("已回退并暂停自动进化，运行中的目标保留原策略。"); }
    catch { setNotice("没能回退策略，请刷新状态后重试。"); } finally { setSaving(false); }
  };
  const runDryRun = async () => {
    if (dryRunning) return;
    setDryRunning(true);
    try { setDryRun(await api.dryRunEvolution(workbenchId)); setNotice(null); }
    catch { setDryRun(null); setNotice("干跑没能完成，请稍后重试。"); } finally { setDryRunning(false); }
  };
  const runNow = async () => {
    if (saving) return;
    setSaving(true);
    try { setStatus(await api.runEvolutionNow(workbenchId)); setNotice("已请求立即评测：等工作台空闲且预算可用后自动开始，无需等证据攒满。"); }
    catch { setNotice("没能发起评测：请确认自动进化未处于暂停或关闭状态。"); } finally { setSaving(false); }
  };
  const current = status === null ? null : EVOLUTION_BUDGET_PRESETS.find((preset) => preset.limit === status.dailyCallLimit) ?? null;
  return <div className="inline-settings workbench-evolution-panel">
    <p className="workbench-evolution-intro">从执行经验中改进上下文整理和完成检查。候选必须先通过独立评测和生产灰度，才会成为全局基线或本工作台覆盖层。</p>
    {notice === null ? null : <p role="status">{notice}</p>}
    {overview === null ? null : <div>
      <h3>全部工作台</h3>
      <p>已启用 {overview.enabled} / {overview.workbenches} · 评测中 {overview.evaluating} · 灰度中 {overview.canary} · 生效策略 {overview.active}</p>
      <p className="field-hint">策略相关证据池：可评价 {overview.poolEvaluable} 个，其中失败 {overview.poolVerificationFailed} 个。{overview.revalidationRequired > 0 ? `有 ${String(overview.revalidationRequired)} 个工作台需要重新验证。` : ""}</p>
      {overview.batches.length === 0 ? <p className="field-hint">尚无真实评测批次。</p> : <ul>{overview.batches.slice(0, 5).map((batch) => <li key={`${batch.workbenchId}:${batch.batchId}:${batch.finishedAt ?? "running"}`}>
        {batch.scope === "GLOBAL" ? "全局基线" : "工作台覆盖"} · {phaseLabels[batch.phase]} · {labels[batch.reason]} · {String(batch.calls)} 次调用{batch.tokens === null ? "" : ` / ${String(batch.tokens)} tokens`}
      </li>)}</ul>}
    </div>}
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
      <p>今日调用 {status.callsUsedToday} / {status.dailyCallLimit} · 本工作台已记录 {status.evidenceCount} 个目标，其中 {status.evaluableCount} 个可客观评价</p>
      <p className="field-hint">启动一轮评测需要全部工作台合计 {String(EVOLUTION_EVIDENCE_THRESHOLD)} 个可客观评价目标、其中 {String(EVOLUTION_FAILURE_THRESHOLD)} 个可归因于上下文或完成判断的验收失败；当前为 {String(status.poolEvaluable)} 个与 {String(status.poolVerificationFailed)} 个。共享证据先改进全局基线；只有本工作台自己的归因证据达到门槛时才生成覆盖层。</p>
      {status.canaryRevisionId == null ? null : <p className="field-hint" role="status">候选正在生产灰度：稳定分配一小部分新目标，至少收集 5 个候选与 5 个对照结果后才会正式生效。</p>}
      {status.revalidationRequired !== true ? null : <p className="field-hint" role="status">当前模型固定版本与策略评测版本不一致，策略已退回基线，重新评测前不会静默沿用。</p>}
      <p className="field-hint">每轮评测每天最多启动一个候选；被拒绝后需要重新积累触发证据，或用下面的按钮立即再试。</p>
      <button className="button ghost" type="button" disabled={saving} onClick={() => void runNow()}>立即评测一次</button>
      {status.runRequestedAt === null ? null : <p className="field-hint" role="status">已排入队列（{status.runRequestedAt.slice(0, 16).replace("T", " ")} 请求）：等待工作台空闲。</p>}
      {status.lastVerdict === null ? null : <p className="field-hint">上一轮裁决：{labels[status.lastVerdict.reason]} · 原策略通过 {status.lastVerdict.baselineSuccesses} 次 / 候选通过 {status.lastVerdict.candidateSuccesses} 次（共 {status.lastVerdict.evaluatedRuns} 次评测）</p>}
      {(status.batchHistory ?? []).length === 0 ? null : <><h3>真实批次历史</h3><ul>{(status.batchHistory ?? []).slice(0, 10).map((batch) => <li key={`${batch.batchId}:${batch.finishedAt ?? "running"}`}>
        {phaseLabels[batch.phase]} · {labels[batch.reason]} · {String(batch.calls)} 次调用{batch.tokens === null ? "" : ` / ${String(batch.tokens)} tokens`}
      </li>)}</ul></>}
      <h3>手工干跑</h3>
      <p className="field-hint">用确定性替身把整条评测链路走一遍，不消耗任何真实模型调用，也不会改动上面的状态和策略。用来在证据攒够之前确认链路本身是通的。</p>
      <button className="button ghost" type="button" disabled={saving || dryRunning} onClick={() => void runDryRun()}>{dryRunning ? "正在干跑…" : "干跑一次"}</button>
      {dryRun === null ? null : <div>
        <p role="status">{dryRunOutcomes[dryRun.outcome]}</p>
        <p className="field-hint">{dryRun.phases.map((entry) => `${phaseLabels[entry.phase]} ${String(entry.rollouts)} 轮 / ${String(entry.steps)} 次调用`).join(" · ")}</p>
        <p className="field-hint">合计 {String(dryRun.steps)} 次合成调用，耗时 {String(dryRun.durationMs)} 毫秒；没有发出任何真实模型调用。{dryRun.selfCheck.matched ? "" : "自检未通过：替身可能已与当前场景不匹配，请检查场景定义。"}</p>
        {dryRun.promoted || dryRun.verdict === null ? null : <p>{labels[dryRun.verdict]}</p>}
      </div>}
      <h3>策略历史</h3>
      {status.versions.length === 0 ? <p>尚无候选策略，积累足够证据后自动评估。</p> : <ul>{status.versions.map((version) => <li key={version.revisionId}>
        <strong>{version.module === "context" ? "上下文整理" : "完成检查"}</strong> · {labels[version.reason]}<br />
        <small>{version.createdAt.slice(0, 10)} · 已评测 {version.evaluatedRuns} 次 · 原策略通过 {version.baselineSuccesses} 次 / 候选通过 {version.candidateSuccesses} 次</small>
      </li>)}</ul>}
      {(status.activeRevisionId ?? status.globalRevisionId) == null ? null : <button className="button ghost" type="button" disabled={saving} onClick={() => void rollback()}>回退当前策略并暂停</button>}
    </>}
  </div>;
}
