import { noticeMessage, t, useI18n, useNotice } from "./i18n";
import { useEffect, useState } from "react";
import type { DigitalLifeApi } from "./api";
import type { EvolutionBudgetPreset, EvolutionBudgetPresetKey, EvolutionDryRunOutcome, EvolutionDryRunReportDto, EvolutionModelFailure, EvolutionOverviewDto, EvolutionPhase, EvolutionReason, EvolutionStatusDto } from "../shared/evolution";
import { EVOLUTION_BUDGET_PRESETS, EVOLUTION_EVIDENCE_THRESHOLD, EVOLUTION_FAILURE_THRESHOLD } from "../shared/evolution";

const labels: Record<EvolutionReason, string> = {
  get collecting() { return t("evolution.collectingEvaluableExperience"); }, get disabled() { return t("evolution.automaticEvolutionIsNotEnabled"); }, get budget_exhausted() { return t("evolution.todaySBudgetIsUsedUpContinuingNextBilling"); }, get evaluating() { return t("evolution.evaluatingACandidatePolicy"); },
  get canary() { return t("evolution.theCandidatePassedSyntheticEvaluationAndIsBeingTested"); }, get revalidation_required() { return t("evolution.theModelOrEvaluatorChangedThePolicyIsSuspended"); }, get revision_limit_reached() { return t("evolution.policyHistoryIsFullAuditItBeforeContinuing"); },
  get promoted() { return t("evolution.anEvaluatedPolicyIsActive"); }, get rolled_back() { return t("evolution.automaticEvolutionPausedNewGoalsUseTheRolledBack"); }, get model_changed() { return t("evolution.theModelOrEvaluationEnvironmentChangedAwaitingReevaluation"); },
  get insufficient_samples() { return t("evolution.notEnoughEvaluationSamplesKeepingTheCurrentPolicy"); }, get insufficient_gain() { return t("evolution.insufficientImprovementKeepingTheCurrentPolicy"); }, get quality_regression() { return t("evolution.candidateRejectedDueToReducedQuality"); },
  get cost_regression() { return t("evolution.candidateRejectedForExceedingTheCallCostLimit"); }, get hard_violation() { return t("evolution.candidateRejectedForViolatingCompletionRequirements"); }, get invalid_evaluation() { return t("evolution.invalidEvaluationKeepingTheCurrentPolicy"); },
  get invalid_candidate() { return t("evolution.insufficientCandidateEvidenceKeepingTheCurrentPolicy"); }, get call_failed() { return t("evolution.backgroundCallDidNotCompleteKeepingTheCurrentPolicy"); },
  get model_response_invalid() { return t("evolution.theModelResponseDidNotMeetEvaluationRequirementsThis"); },
};
const failureLabels: Record<EvolutionModelFailure["kind"], string> = {
  get provider_error() { return t("evolution.modelConnectionCallFailed"); }, get timeout() { return t("evolution.modelConnectionCallTimedOut"); }, get aborted() { return t("evolution.evaluationCallCanceled"); },
  get response_truncated() { return t("evolution.modelOutputWasTruncated"); }, get no_tool_call() { return t("evolution.noToolCallReturned"); },
  get multiple_tool_calls() { return t("evolution.multipleToolCallsReturned"); }, get unsupported_tool() { return t("evolution.unsupportedToolCallReturned"); },
};
function statusLabel(status: EvolutionStatusDto): string {
  if (status.reason !== "model_response_invalid") return labels[status.reason];
  return status.paused === true ? t("evolution.theModelResponseDidNotMeetEvaluationRequirementsAutomatic")
    : t("evolution.theResponseDidNotMeetEvaluationRequirementsThisRound");
}
const presetLabels: Record<EvolutionBudgetPresetKey, string> = { get off() { return t("evolution.off"); }, get low() { return t("evolution.low"); }, get medium() { return t("evolution.medium"); }, get high() { return t("evolution.high"); } };
const presetHints: Record<EvolutionBudgetPresetKey, string> = {
  get off() { return t("evolution.recordExperienceWithoutMakingModelEvaluationCalls"); },
  get low() { return t("evolution.aFullEvaluationTakesAboutTwoWeeksUsesThe"); },
  get medium() { return t("evolution.aFullEvaluationTakesAboutFiveDaysBalancingSpeed"); },
  get high() { return t("evolution.aFullEvaluationTakesAboutTwoDaysFastestResults"); },
};
const presetName = (preset: EvolutionBudgetPreset) => preset.key === "off" ? t("evolution.offRecordExperienceOnly") : t("evolution.valueValuePerDay", { p0: presetLabels[preset.key], p1: String(preset.limit) });
const phaseLabels: Record<EvolutionPhase, string> = { get DEVELOP() { return t("evolution.development"); }, get PROPOSE() { return t("evolution.proposal"); }, get VALIDATE() { return t("evolution.candidateRetest"); }, get EVALUATE() { return t("evolution.heldOutEvaluation"); } };
const dryRunOutcomes: Record<EvolutionDryRunOutcome, string> = {
  get promoted() { return t("evolution.pipelineVerifiedTheBatchReachedThePromotionDecision"); },
  get rejected() { return t("evolution.pipelineVerifiedButTheCandidateWasRejectedByA"); },
  get truncated() { return t("evolution.pipelineIncompleteAStepOrTimeLimitWasReached"); },
  get not_started() { return t("evolution.theBatchCouldNotStartBecauseSyntheticEvidenceDid"); },
};
export function WorkbenchEvolutionPanel({ api, workbenchId }: { api: DigitalLifeApi; workbenchId: string }) {
  useI18n();
  const [status, setStatus] = useState<EvolutionStatusDto | null>(null);
  const [notice, setNotice] = useNotice();
  const [saving, setSaving] = useState(false);
  const [dryRun, setDryRun] = useState<EvolutionDryRunReportDto | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [overview, setOverview] = useState<EvolutionOverviewDto | null>(null);
  useEffect(() => {
    let canceled = false;
    const load = () => {
      void api.evolutionOverview().then((aggregate) => { if (!canceled) setOverview(aggregate); }).catch(() => undefined);
      return api.evolutionStatus(workbenchId).then((value) => { if (!canceled) setStatus(value); }).catch(() => { if (!canceled) setNotice(noticeMessage("evolution.couldNotLoadEvolutionStatusTryAgainLater")); });
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { canceled = true; clearInterval(timer); };
  }, [api, setNotice, workbenchId]);
  const applyPreset = async (preset: EvolutionBudgetPreset) => {
    if (saving) return;
    setSaving(true);
    try {
      setStatus(await api.configureEvolution(workbenchId, preset.limit));
      setNotice(preset.limit === 0 ? noticeMessage("evolution.evaluationBudgetDisabledExperienceWillStillBeRecorded") : noticeMessage("evolution.budgetSetToValueValuePerDayRunsAutomatically", { p0: presetLabels[preset.key], p1: String(preset.limit) }));
    } catch { setNotice(noticeMessage("evolution.couldNotSaveTheBudgetTryAgain")); } finally { setSaving(false); }
  };
  const rollback = async () => {
    const revisionId = status?.activeRevisionId ?? status?.globalRevisionId;
    if (revisionId == null) return;
    setSaving(true);
    try { setStatus(await api.rollbackEvolution(workbenchId, revisionId)); setNotice(noticeMessage("evolution.rolledBackAndPausedAutomaticEvolutionRunningGoalsKeep")); }
    catch { setNotice(noticeMessage("evolution.couldNotRollBackThePolicyRefreshStatusAnd")); } finally { setSaving(false); }
  };
  const runDryRun = async () => {
    if (dryRunning) return;
    setDryRunning(true);
    try { setDryRun(await api.dryRunEvolution(workbenchId)); setNotice(null); }
    catch { setDryRun(null); setNotice(noticeMessage("evolution.theDryRunDidNotCompleteTryAgainLater")); } finally { setDryRunning(false); }
  };
  const runNow = async () => {
    if (saving) return;
    setSaving(true);
    try { setStatus(await api.runEvolutionNow(workbenchId)); setNotice(noticeMessage("evolution.evaluationRequestedItStartsWhenTheWorkbenchIsIdle")); }
    catch { setNotice(noticeMessage("evolution.couldNotStartEvaluationMakeSureAutomaticEvolutionIs")); } finally { setSaving(false); }
  };
  const current = status === null ? null : EVOLUTION_BUDGET_PRESETS.find((preset) => preset.limit === status.dailyCallLimit) ?? null;
  return <div className="inline-settings workbench-evolution-panel">
    <p className="workbench-evolution-intro">{t("evolution.improveContextOrganizationAndCompletionChecksUsingExecutionExperience")}</p>
    {notice === null ? null : <p role="status">{notice}</p>}
    {overview === null ? null : <div>
      <h3>{t("evolution.allWorkbenches")}</h3>
      <p>{t("evolution.enabled")} {overview.enabled} / {overview.workbenches}  {t("evolution.evaluating")} {overview.evaluating}  {t("evolution.inTrial")} {overview.canary}  {t("evolution.activePolicy")} {overview.active}</p>
      <p className="field-hint">{t("evolution.policyEvidencePoolEvaluable")} {overview.poolEvaluable}  {t("evolution.itemsFailed")} {overview.poolVerificationFailed}  {t("evolution.items")}{overview.revalidationRequired > 0 ? t("evolution.valueWorkbenchesNeedRevalidation", { p0: String(overview.revalidationRequired) }) : ""}</p>
      {overview.batches.length === 0 ? <p className="field-hint">{t("evolution.noRealEvaluationBatchesYet")}</p> : <ul>{overview.batches.slice(0, 5).map((batch) => <li key={`${batch.workbenchId}:${batch.batchId}:${batch.finishedAt ?? "running"}`}>
        {batch.scope === "GLOBAL" ? t("evolution.globalBaseline") : t("evolution.workbenchOverride")} · {phaseLabels[batch.phase]} · {labels[batch.reason]} · {String(batch.calls)}  {t("evolution.calls")} {batch.tokens === null ? t("evolution.tokenUsageUnknown") : `${String(batch.tokens)} tokens`}{batch.failure === undefined ? "" : ` · ${failureLabels[batch.failure.kind]}`}
      </li>)}</ul>}
    </div>}
    {status === null ? <p>{t("evolution.loadingEvolutionStatus")}</p> : <>
      <p>{statusLabel(status)}</p>
      {status.failure === undefined ? null : <p className="field-hint">{failureLabels[status.failure.kind]}</p>}
      <fieldset className="evolution-budget-presets" disabled={saving}>
        <legend>{t("evolution.dailyModelCallLimit")}</legend>
        <div className="evolution-budget-options">
          {EVOLUTION_BUDGET_PRESETS.map((preset) => <label key={preset.key}>
            <input aria-label={presetName(preset)} checked={status.dailyCallLimit === preset.limit} name="evolution-budget" onChange={() => void applyPreset(preset)} type="radio" value={preset.limit} />
            {presetLabels[preset.key]}
          </label>)}
        </div>
      </fieldset>
      <p className="field-hint">{current === null ? t("evolution.customLimitValuePerDayChooseAPresetTo", { p0: String(status.dailyCallLimit) }) : presetHints[current.key]}</p>
      <p className="field-hint">{t("evolution.theLimitResetsDailyAtUtcMidnightAndIs")}</p>
      <p>{t("evolution.callsToday")} {status.callsUsedToday} / {status.dailyCallLimit}  {t("evolution.thisWorkbenchHasRecorded")} {status.evidenceCount}  {t("evolution.goalsIncluding")} {status.evaluableCount}  {t("evolution.objectivelyEvaluable")}</p>
      <p className="field-hint">{t("evolution.startingAnEvaluationRequiresATotalAcrossAllWorkbenches")} {String(EVOLUTION_EVIDENCE_THRESHOLD)}  {t("evolution.objectivelyEvaluableGoalsIncluding")} {String(EVOLUTION_FAILURE_THRESHOLD)}  {t("evolution.acceptanceFailuresAttributableToContextOrCompletionJudgmentCurrently")} {String(status.poolEvaluable)}  {t("evolution.and")} {String(status.poolVerificationFailed)}  {t("evolution.itemsSharedEvidenceImprovesTheGlobalBaselineFirstA")}</p>
      {status.canaryRevisionId == null ? null : <p className="field-hint" role="status">{t("evolution.theCandidateIsInAProductionTrialWithA")}</p>}
      {status.revalidationRequired !== true ? null : <p className="field-hint" role="status">{t("evolution.thePinnedModelVersionDiffersFromTheEvaluatedVersion")}</p>}
      <p className="field-hint">{t("evolution.eachEvaluationRoundStartsAtMostOneCandidatePer")}</p>
      <button className="button ghost" type="button" disabled={saving || status.paused === true} onClick={() => void runNow()}>{t("evolution.evaluateNow")}</button>
      {status.runRequestedAt === null ? null : <p className="field-hint" role="status">{t("evolution.queued")}{status.runRequestedAt.slice(0, 16).replace("T", " ")}  {t("evolution.requestWaitingForTheWorkbenchToBecomeIdle")}</p>}
      {status.lastVerdict === null ? null : <p className="field-hint">{t("evolution.previousDecision")}{labels[status.lastVerdict.reason]}  {t("evolution.originalPolicyPassed")} {status.lastVerdict.baselineSuccesses}  {t("evolution.candidatePassed")} {status.lastVerdict.candidateSuccesses}  {t("evolution.outOf")} {status.lastVerdict.evaluatedRuns}  {t("evolution.evaluations")}</p>}
      {(status.batchHistory ?? []).length === 0 ? null : <><h3>{t("evolution.realBatchHistory")}</h3><ul>{(status.batchHistory ?? []).slice(0, 10).map((batch) => <li key={`${batch.batchId}:${batch.finishedAt ?? "running"}`}>
        {phaseLabels[batch.phase]} · {labels[batch.reason]} · {String(batch.calls)}  {t("evolution.calls")} {batch.tokens === null ? t("evolution.tokenUsageUnknown") : `${String(batch.tokens)} tokens`}{batch.failure === undefined ? "" : ` · ${failureLabels[batch.failure.kind]}`}
      </li>)}</ul></>}
      <h3>{t("evolution.manualDryRun")}</h3>
      <p className="field-hint">{t("evolution.runTheFullEvaluationPipelineWithDeterministicFakesWithout")}</p>
      <button className="button ghost" type="button" disabled={saving || dryRunning} onClick={() => void runDryRun()}>{dryRunning ? t("evolution.runningDryRun") : t("evolution.runADryRun")}</button>
      {dryRun === null ? null : <div>
        <p role="status">{dryRunOutcomes[dryRun.outcome]}</p>
        <p className="field-hint">{dryRun.phases.map((entry) => t("evolution.valueValueRoundsValueCalls", { p0: phaseLabels[entry.phase], p1: String(entry.rollouts), p2: String(entry.steps) })).join(" · ")}</p>
        <p className="field-hint">{t("evolution.total")} {String(dryRun.steps)}  {t("evolution.syntheticCallsElapsed")} {String(dryRun.durationMs)}  {t("evolution.msNoRealModelCallsWereMade")}{dryRun.selfCheck.matched ? "" : t("evolution.selfCheckFailedTheFakeMayNoLongerMatch")}</p>
        {dryRun.promoted || dryRun.verdict === null ? null : <p>{labels[dryRun.verdict]}</p>}
      </div>}
      <h3>{t("evolution.policyHistory")}</h3>
      {status.versions.length === 0 ? <p>{t("evolution.noCandidatePoliciesYetEvaluationStartsAutomaticallyWhenEnough")}</p> : <ul>{status.versions.map((version) => <li key={version.revisionId}>
        <strong>{version.module === "context" ? t("evolution.contextOrganization") : t("evolution.completionChecks")}</strong> · {labels[version.reason]}<br />
        <small>{version.createdAt.slice(0, 10)}  {t("evolution.evaluated")} {version.evaluatedRuns}  {t("evolution.timesOriginalPolicyPassed")} {version.baselineSuccesses}  {t("evolution.candidatePassed")} {version.candidateSuccesses}  {t("evolution.times")}</small>
      </li>)}</ul>}
      {(status.activeRevisionId ?? status.globalRevisionId) == null ? null : <button className="button ghost" type="button" disabled={saving} onClick={() => void rollback()}>{t("evolution.rollBackCurrentPolicyAndPause")}</button>}
    </>}
  </div>;
}
