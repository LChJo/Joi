import { formatNumber, noticeMessage, t, useI18n, useNotice } from "./i18n";
import { useEffect, useState } from "react";
import type { DigitalLifeApi } from "./api";
import type { EvolutionBudgetPreset, EvolutionBudgetPresetKey, EvolutionLearningBlocker, EvolutionLearningDto, EvolutionLearningStage, EvolutionOverviewDto, EvolutionReason, EvolutionStatusDto } from "../shared/evolution";
import type { MessageKey } from "../shared/i18n/index";
import { EVOLUTION_BUDGET_PRESETS } from "../shared/evolution";

const labels = {
  collecting: "evolution.collectingEvaluableExperience", disabled: "evolution.automaticEvolutionIsNotEnabled",
  budget_exhausted: "evolution.todaySBudgetIsUsedUpContinuingNextBilling", evaluating: "evolution.evaluatingACandidatePolicy",
  canary: "evolution.methodInTrial", revalidation_required: "evolution.theModelOrEvaluatorChangedThePolicyIsSuspended",
  revision_limit_reached: "evolution.policyHistoryIsFullAuditItBeforeContinuing", promoted: "evolution.anEvaluatedPolicyIsActive",
  rolled_back: "evolution.automaticEvolutionPausedNewGoalsUseTheRolledBack", model_changed: "evolution.theModelOrEvaluationEnvironmentChangedAwaitingReevaluation",
  insufficient_samples: "evolution.notEnoughEvaluationSamplesKeepingTheCurrentPolicy", insufficient_gain: "evolution.insufficientImprovementKeepingTheCurrentPolicy",
  quality_regression: "evolution.candidateRejectedDueToReducedQuality", cost_regression: "evolution.candidateRejectedForExceedingTheCallCostLimit",
  hard_violation: "evolution.candidateRejectedForViolatingCompletionRequirements", invalid_evaluation: "evolution.invalidEvaluationKeepingTheCurrentPolicy",
  invalid_candidate: "evolution.insufficientCandidateEvidenceKeepingTheCurrentPolicy", call_failed: "evolution.backgroundCallDidNotCompleteKeepingTheCurrentPolicy",
  model_response_invalid: "evolution.theModelResponseDidNotMeetEvaluationRequirementsThis",
} as const satisfies Record<EvolutionReason, MessageKey>;
const presetLabels: Record<EvolutionBudgetPresetKey, string> = { get off() { return t("evolution.off"); }, get low() { return t("evolution.low"); }, get medium() { return t("evolution.medium"); }, get high() { return t("evolution.high"); } };
const presetName = (preset: EvolutionBudgetPreset) => preset.key === "off" ? t("evolution.offRecordExperienceOnly") : t("evolution.valueValuePerDay", { p0: presetLabels[preset.key], p1: String(preset.limit) });
const learningStages = {
  OBSERVING: "evolution.stageObserving", DIAGNOSING: "evolution.stageDiagnosing", PROTOCOL: "evolution.stageProtocol",
  DEVELOP: "evolution.stageDevelop", PROPOSE: "evolution.stagePropose", VALIDATE: "evolution.stageValidate",
  EVALUATE: "evolution.stageEvaluate", CANARY: "evolution.stageCanary", ACTIVE: "evolution.stageActive", PAUSED: "evolution.stagePaused",
} as const satisfies Record<EvolutionLearningStage, MessageKey>;
const learningBlockers = {
  disabled: "evolution.blockerDisabled", paused: "evolution.blockerPaused", not_idle: "evolution.blockerNotIdle",
  budget_exhausted: "evolution.blockerBudget", no_reproducible_case: "evolution.blockerNoCase",
  insufficient_samples: "evolution.blockerSamples", model_response_invalid: "evolution.blockerProtocol",
  model_changed: "evolution.blockerModel", daily_candidate_limit: "evolution.blockerCandidate",
} as const satisfies Record<EvolutionLearningBlocker, MessageKey>;

function LearningEvolutionPanel({ api, status, learning, overview, updateStatus, updateOverview, loadingNotice }: {
  api: DigitalLifeApi; status: EvolutionStatusDto; learning: EvolutionLearningDto; overview: EvolutionOverviewDto | null;
  updateStatus: (value: EvolutionStatusDto) => void; updateOverview: (value: EvolutionOverviewDto) => void; loadingNotice: string | null;
}) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useNotice();
  const global = overview?.learning?.globalBudget ?? learning.globalBudget;
  const methods = learning.methods.filter((method) => method.status === "ACTIVE" || method.status === "CANARY");
  const act = async <T,>(operation: () => Promise<T>, success?: (value: T) => MessageKey) => {
    if (saving) return;
    setSaving(true);
    try { const value = await operation(); setNotice(noticeMessage(success?.(value) ?? "evolution.learningUpdated")); }
    catch { setNotice(noticeMessage("evolution.learningSaveFailed")); }
    finally { setSaving(false); }
  };
  const globalSettings = async (enabled: boolean, limit: number) => { updateOverview(await api.configureGlobalEvolution(enabled, limit)); };
  const canEvaluate = global.enabled && !global.paused && learning.participation.enabled && !learning.participation.paused && global.dailyCallLimit > 0;
  const running = learning.experiment?.reason === "evaluating" && ["PROTOCOL", "DEVELOP", "PROPOSE", "VALIDATE", "EVALUATE"].includes(learning.stage);
  const paused = global.paused || learning.participation.paused || learning.stage === "PAUSED";
  const disabled = !global.enabled || !learning.participation.enabled || global.dailyCallLimit === 0;
  const headline: MessageKey = disabled ? "evolution.blockerDisabled" : paused ? "evolution.stagePaused"
    : learning.blockers.includes("budget_exhausted") ? "evolution.blockerBudget"
      : learning.blockers.includes("not_idle") ? "evolution.waitingForIdle" : learningStages[learning.stage];
  const tokens = (value: number | null) => value === null ? t("evolution.tokenUsageUnknown") : `${formatNumber(value)} tokens`;
  return <div className="inline-settings workbench-evolution-panel">
    <p className="workbench-evolution-intro">{t("evolution.learningPageIntro")}</p>
    {loadingNotice === null ? null : <p className="evolution-notice" role="status">{loadingNotice}</p>}
    {notice === null ? null : <p className="evolution-notice" role="status">{notice}</p>}

    <section className="evolution-progress" aria-labelledby="evolution-progress-heading">
      <header className="evolution-section-header">
        <h3 id="evolution-progress-heading">{t("evolution.currentProgress")}</h3>
        <span className={`evolution-state ${disabled ? "disabled" : paused ? "paused" : ""}`}>{t(disabled ? "evolution.learningOffBadge" : paused ? "evolution.learningPausedBadge" : running ? "evolution.learningRunningBadge" : "evolution.learningEnabledBadge")}</span>
      </header>
      <p className="evolution-headline" role="status">{t(headline)}</p>
      {learning.blockers.length === 0 ? <p className="evolution-description">{t("evolution.automaticLearningHint")}</p>
        : <div className="evolution-next"><span>{t("evolution.nextStep")}</span><ul>{learning.blockers.map((blocker) => <li key={blocker}>{t(learningBlockers[blocker])}</li>)}</ul></div>}
      {learning.experiment === null ? null : <div className="evolution-result">
        <span>{t(running ? "evolution.runningEvaluation" : "evolution.latestEvaluation")}</span>
        <p>{t(labels[learning.experiment.reason])}</p>
        <small>{t("evolution.evaluationCalls", { p0: formatNumber(learning.experiment.calls) })} · {tokens(learning.experiment.tokens)}</small>
      </div>}
      <dl className="evolution-case-metrics">
        <div><dt>{t("evolution.developmentCases")}</dt><dd>{formatNumber(learning.cases.development)}</dd></div>
        <div><dt>{t("evolution.independentCases")}</dt><dd>{formatNumber(learning.cases.sealed)}</dd></div>
        <div><dt>{t("evolution.reproducibleProblems")}</dt><dd>{formatNumber(learning.cases.defects)}</dd></div>
      </dl>
      <p className="evolution-description">{t(learning.cases.sealed === 0 ? "evolution.noIndependentCasesHint" : "evolution.independentCasesHint")}</p>
      <div className="evolution-evaluate-action"><button className="button primary" type="button" disabled={saving || !canEvaluate}
        onClick={() => void act(async () => {
          const value = await api.runEvolutionNow(status.workbenchId);
          updateStatus(value);
          return value;
        }, (value) => value.runRequestedAt === null ? "evolution.blockerNoCase" : "evolution.evaluationRequestedItStartsWhenTheWorkbenchIsIdle")}>{t("evolution.evaluateNow")}</button>
        <span>{t("evolution.manualEvaluationHint")}</span></div>
    </section>

    <section className="evolution-methods" aria-labelledby="evolution-methods-heading">
      <header className="evolution-section-header"><h3 id="evolution-methods-heading">{t("evolution.adoptedMethods")}</h3>
        <span className="evolution-description">{t("evolution.appliedMethodGoals", { p0: formatNumber(learning.appliedGoals) })}</span></header>
      {methods.length === 0 ? <div className="evolution-method-empty"><p>{t("evolution.noMethodsYet")}</p><p>{t("evolution.noAdoptedMethodsHint")}</p></div>
        : <ul className="evolution-method-list">{methods.map((method) => <li key={method.revisionId}>
          <div className="evolution-method-header"><div><strong>{method.module === "context" ? t("evolution.contextOrganization") : method.module === "planning" ? t("evolution.planningMethods") : t("evolution.completionChecks")}</strong>
            <span>{method.scope === "GLOBAL" ? t("evolution.allWorkbenchesScope") : t("evolution.thisWorkbenchScope")}</span></div>
            <span className="evolution-state">{t(method.status === "CANARY" ? "evolution.methodInTrial" : "evolution.methodActive")}</span></div>
          <p className="evolution-description">{method.benefit === "quality" ? t("evolution.qualityBenefit") : method.benefit === "efficiency" ? t("evolution.efficiencyBenefit") : t("evolution.benefitUnverified")}</p>
          <div className="evolution-method-actions"><details><summary>{t("evolution.evaluationEvidence")}</summary>
            <p>{t("evolution.methodEvaluation", { p0: formatNumber(method.baselineSuccesses), p1: formatNumber(method.candidateSuccesses), p2: formatNumber(method.evaluatedRuns) })}</p>
            <p>{t("evolution.methodExposure", { p0: formatNumber(method.candidateGoals), p1: formatNumber(method.controlGoals) })}</p>
          </details><button className="button ghost" type="button" disabled={saving}
            onClick={() => void act(async () => { updateStatus(await api.rollbackEvolution(status.workbenchId, method.revisionId)); })}>{t("evolution.rollBackCurrentPolicyAndPause")}</button></div>
        </li>)}</ul>}
    </section>

    <section className="evolution-settings" aria-labelledby="evolution-settings-heading">
      <h3 id="evolution-settings-heading">{t("evolution.learningSettings")}</h3>
      <div className="evolution-budget-setting">
        <div className="evolution-section-header"><h4>{t("evolution.sharedGlobalBudget")}</h4>
          <label className="switch"><input type="checkbox" checked={global.enabled} disabled={saving}
            onChange={(event) => void act(() => globalSettings(event.target.checked, global.dailyCallLimit || 150))} />{t("evolution.enableGlobalLearning")}</label></div>
        <div className="evolution-budget-usage"><p><strong>{formatNumber(global.callsUsedToday)} <span>/ {formatNumber(global.dailyCallLimit)}</span></strong><span>{t("evolution.callsUsedToday")}</span></p><span>{tokens(global.tokensToday)}</span></div>
        {global.dailyCallLimit === 0 ? null : <progress className="evolution-budget-progress" aria-label={t("evolution.dailyBudgetUsage")} max={global.dailyCallLimit} value={Math.min(global.callsUsedToday, global.dailyCallLimit)} />}
        <fieldset className="evolution-budget-presets" disabled={saving}>
          <legend>{t("evolution.dailyModelCallLimit")}</legend>
          <div className="evolution-budget-options">{EVOLUTION_BUDGET_PRESETS.map((preset) => <label key={preset.key}>
            <input aria-label={presetName(preset)} checked={global.dailyCallLimit === preset.limit} name="global-evolution-budget"
              onChange={() => void act(() => globalSettings(preset.limit > 0 && global.enabled, preset.limit))} type="radio" value={preset.limit} />
            <span>{presetLabels[preset.key]}</span>{preset.limit === 0 ? null : <strong>{formatNumber(preset.limit)}</strong>}
          </label>)}</div>
        </fieldset>
        <p className="evolution-description">{t("evolution.sharedBudgetHint")}</p>
        {global.paused ? <button type="button" className="button ghost" disabled={saving}
          onClick={() => void act(async () => { updateOverview(await api.resumeGlobalEvolution()); })}>{t("evolution.resumeGlobalLearning")}</button> : null}
      </div>
      <div className="evolution-participation-setting"><div className="evolution-section-header"><label className="switch"><input type="checkbox" checked={learning.participation.enabled} disabled={saving}
        onChange={(event) => void act(async () => { updateStatus(await api.setEvolutionParticipation(status.workbenchId, event.target.checked)); })} />{t("evolution.participateInLearning")}</label>
        {learning.participation.paused ? <button type="button" className="button ghost" disabled={saving}
          onClick={() => void act(async () => { updateStatus(await api.resumeEvolution(status.workbenchId)); })}>{t("evolution.resumeWorkbenchLearning")}</button> : null}</div>
        <p className="evolution-description">{t("evolution.participationHint")}</p></div>
    </section>
  </div>;
}

export function WorkbenchEvolutionPanel({ api, workbenchId }: { api: DigitalLifeApi; workbenchId: string }) {
  useI18n();
  const [status, setStatus] = useState<EvolutionStatusDto | null>(null);
  const [notice, setNotice] = useNotice();
  const [overview, setOverview] = useState<EvolutionOverviewDto | null>(null);
  useEffect(() => {
    let canceled = false;
    const load = () => {
      void api.evolutionOverview().then((aggregate) => { if (!canceled) setOverview(aggregate); }).catch(() => undefined);
      return api.evolutionStatus(workbenchId).then((value) => { if (!canceled) { setStatus(value); setNotice(null); } }).catch(() => { if (!canceled) setNotice(noticeMessage("evolution.couldNotLoadEvolutionStatusTryAgainLater")); });
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { canceled = true; clearInterval(timer); };
  }, [api, setNotice, workbenchId]);
  if (status?.workbenchId !== workbenchId) return <div className="inline-settings workbench-evolution-panel evolution-loading" aria-busy={notice === null}>
    <p role="status">{notice ?? t("evolution.loadingEvolutionStatus")}</p>
    {notice === null ? <div className="evolution-loading-lines" aria-hidden="true"><span /><span /><span /></div> : null}
  </div>;
  if (status.learning === undefined) return <div className="inline-settings workbench-evolution-panel"><p role="status">{t("evolution.upgradeRequired")}</p></div>;
  return <LearningEvolutionPanel key={workbenchId} api={api} status={status} learning={status.learning}
    overview={overview} updateStatus={setStatus} updateOverview={setOverview} loadingNotice={notice} />;
}
