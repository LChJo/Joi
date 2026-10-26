import { localizeProductText, currentLocale, noticeMessage, t, useI18n, useNotice } from "./i18n";
import { WorkbenchChoiceDialog, WorkbenchChoiceForm } from "./WorkbenchChoiceDialog.js";
import { needsWorkbenchChoice } from "../shared/workbench-choice.js";
import { ResultExportMenu } from './ResultExportMenu';
import { GoalTitle, GoalMap } from "./GoalDetailPresentation.js";
import { useGoalDetail } from "./useGoalDetail.js";
import { WorkbenchEvolutionPanel } from './EvolutionSettings';
import { memo, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpIcon, ArrowUpRightIcon, ClockIcon, DotsThreeIcon, PaperclipIcon, XIcon } from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { REVIEW_RETRY_TEXT, MODEL_SOURCE_CHOICES, THINKING_EFFORTS, type AgentConversationEntryDto, type AgentConversationPageDto, type ThinkingEffort, type WorkbenchAgentCardDto, type WorkbenchAgentStatusDto, type WorkbenchArtifactDto, type WorkbenchDetailDto, type WorkbenchDto, type WorkbenchToolTraceDto, type JoiAcceptedMessageDto, type JoiAttachmentDto, type JoiGoalCardDto, type JoiHomeFeedDto, type JoiSnapshotDto, type JoiThinkingItemDto, type ModelSourceAccessModeDto, type ModelSourceKindDto, type ModelSourceProtocolDto, type PartnerDto } from "../shared/joi";
import { artifactGroupLabel, groupArtifactsForDisplay } from "../shared/artifact-presentation";
import { ApiError, type DigitalLifeApi } from "./api";
import { thinkingEffortLabel } from "./copy";

const SAFE_MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => href !== undefined && /^https?:\/\//iu.test(href) ? <a href={href} rel="noreferrer" target="_blank">{children}</a> : <span>{children}</span>,
  img: ({ alt }) => <span className="agent-remote-image">{t("home.image")}{alt === undefined ? "" : `：${alt}`}]</span>,
};

// A fresh array on every render defeats react-markdown's own memoization, and this stream
// re-renders on a poll timer, so the plugin list has to be module-scoped.
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

/**
 * Parsing a document is the expensive part of displaying it. Memoizing here means a poll that
 * returns identical text costs a prop comparison instead of a full reparse.
 */
const Markdown = memo(function Markdown({ children }: { children: string }) {
  useI18n();
  return <ReactMarkdown components={SAFE_MARKDOWN_COMPONENTS} remarkPlugins={MARKDOWN_REMARK_PLUGINS} skipHtml>{children}</ReactMarkdown>;
});

export function ModelSourceSetup({ api, changed }: { api: DigitalLifeApi; changed: () => Promise<void> }) {
  useI18n();
  const [selected, setSelected] = useState<ModelSourceKindDto | null>(null);
  const [selectedAccessMode, setSelectedAccessMode] = useState<ModelSourceAccessModeDto | null>(null);
  const [selectedProtocol, setSelectedProtocol] = useState<ModelSourceProtocolDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNotice();
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null || selectedAccessMode === null || selectedProtocol === null) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string) => {
      const field = form.get(key);
      return typeof field === "string" ? field : "";
    };
    // An empty choice means "use the recommended value": the field is left out entirely rather than
    // sent as 0, so the provider preset keeps applying.
    const numeric = (key: string): number | undefined => {
      const raw = value(key).trim();
      if (raw === "") return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const compactionThresholdPercent = numeric("compactionThresholdPercent");
    const contextWindow = numeric("contextWindow");
    const maxOutputTokens = numeric("maxOutputTokens");
    const thinkingEffort = value("thinkingEffort");
    setBusy(true); setNotice(noticeMessage("home.checkingTheConnectionThisMayIncurASmallModel"));
    try {
      const source = await api.createModelSource({
        accessMode: selectedAccessMode,
        apiKey: value("apiKey"),
        kind: selected,
        protocol: selectedProtocol,
        ...(compactionThresholdPercent === undefined ? {} : { compactionThresholdPercent }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(thinkingEffort === "" ? {} : { thinkingEffort: thinkingEffort as ThinkingEffort }),
        ...(selected === "generic-openai" ? {
          baseUrl: value("baseUrl"), displayName: value("displayName"), modelId: value("modelId"),
        } : value("modelId").trim() === "" ? {} : { modelId: value("modelId") }),
      });
      const validated = await api.validateModelSource(source.sourceId);
      setNotice(validated.status === "READY" ? noticeMessage("home.connectedJoiIsReadyToThink") : modelSourceReasonText(validated.reasonCode));
      await changed();
      if (validated.status === "READY") { setSelected(null); setSelectedAccessMode(null); setSelectedProtocol(null); }
    } catch (error) {
      setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.connectionCheckFailedYourDraftIsSavedForAnother"));
    } finally {
      setBusy(false);
    }
  };
  const selectedChoice = MODEL_SOURCE_CHOICES.find((choice) => choice.kind === selected);
  const selectedOption = selectedChoice?.options.find((option) => option.accessMode === selectedAccessMode);
  const chooseProvider = (kind: ModelSourceKindDto) => {
    const choice = MODEL_SOURCE_CHOICES.find((candidate) => candidate.kind === kind);
    const defaultAccessMode = choice?.options.length === 1 ? choice.options[0].accessMode : null;
    const defaultProtocol = choice?.options.length === 1 && choice.options[0].protocols.length === 1
      ? choice.options[0].protocols[0].protocol
      : null;
    setSelected(kind);
    setSelectedAccessMode(defaultAccessMode);
    setSelectedProtocol(defaultProtocol);
    setNotice(null);
  };
  const chooseAccessMode = (accessMode: ModelSourceAccessModeDto) => {
    const option = selectedChoice?.options.find((candidate) => candidate.accessMode === accessMode);
    setSelectedAccessMode(accessMode);
    setSelectedProtocol(option?.protocols.length === 1 ? option.protocols[0].protocol : null);
  };
  const cancel = () => { setSelected(null); setSelectedAccessMode(null); setSelectedProtocol(null); setNotice(null); };
  return <section className="joi-network-gate" aria-labelledby="joi-network-title">
    <p className="eyebrow">{t("home.niceToMeetYou")}</p>
    <h1 id="joi-network-title">{t("home.joiNeedsAModelConnection")}</h1>
    <p>{t("home.chooseAModelProviderYouAlreadyUseCredentialsAre")}</p>
    <div className="model-source-choices">{MODEL_SOURCE_CHOICES.map((choice) => <button className={selected === choice.kind ? "selected" : ""} key={choice.kind} onClick={() => chooseProvider(choice.kind)} type="button">{t("home.connect")} {localizeProductText(choice.label)}</button>)}</div>
    {selectedChoice !== undefined && selectedAccessMode === null ? <section className="model-source-access-picker" aria-label={t("home.valueAccessPlan", { p0: localizeProductText(selectedChoice.label) })}>
      <h2>{localizeProductText(selectedChoice.label)}  {t("home.accessPlan")}</h2>
      <div className="model-source-access-choices">{selectedChoice.options.map((option) => <button aria-label={localizeProductText(option.label)} key={option.accessMode} onClick={() => chooseAccessMode(option.accessMode)} type="button"><strong>{localizeProductText(option.label)}</strong><span>{localizeProductText(option.description)}</span></button>)}</div>
      <button className="button ghost" onClick={cancel} type="button">{t("common.cancel")}</button>
    </section> : null}
    {selectedOption !== undefined && selectedProtocol === null ? <section className="model-source-protocol-picker" aria-label={t("home.valueApiProtocol", { p0: localizeProductText(selectedOption.label) })}>
      <h2>{localizeProductText(selectedOption.label)}  {t("home.apiProtocol")}</h2>
      <div className="model-source-protocol-choices">{selectedOption.protocols.map((option) => <button aria-label={localizeProductText(option.label)} key={option.protocol} onClick={() => setSelectedProtocol(option.protocol)} type="button"><strong>{localizeProductText(option.label)}</strong><span>{localizeProductText(option.description)}</span></button>)}</div>
      <button className="button ghost" onClick={cancel} type="button">{t("common.cancel")}</button>
    </section> : null}
    {selected !== null && selectedAccessMode !== null && selectedProtocol !== null ? <form className="model-source-form" onSubmit={(event) => void submit(event)}>
      <h2>{selectedOption?.label ?? selectedChoice?.label} · {protocolLabel(selectedProtocol)}</h2>
      {selectedAccessMode === "coding-plan" || selectedAccessMode === "token-plan" ? <p className="inline-notice warning">{t("home.subscriptionPlansAreIntendedForPersonalInteractiveUseCheck")}</p> : null}
      {selected === "kimi" && selectedAccessMode === "coding-plan" ? <p className="model-source-hint">{t("home.theK3ModelIdIsK3NotKimiK3")}</p> : null}
      {selected === "generic-openai" ? <>
        <label>{t("home.displayName")}<input name="displayName" required /></label>
        <label>Base URL<input name="baseUrl" placeholder="https://api.example.com/v1" required type="url" /></label>
        <label>Model ID<input name="modelId" required /></label>
      </> : <label>{t("home.modelIdOptionalAdvanced")}<input name="modelId" placeholder={t("home.leaveBlankForTheRecommendedModel")} /></label>}
      <label>API Key{selected === "generic-openai" ? t("home.optionalForLocalLocalhost") : ""}<input autoComplete="off" name="apiKey" required={selected !== "generic-openai"} type="password" /></label>
      <details className="model-source-advanced">
        <summary>{t("home.advancedSettingsOptional")}</summary>
        <p className="model-source-hint">{t("home.leaveBlankForRecommendedValuesChooseContextAndOutput")}</p>
        <label>{t("home.contextWindowTokens")}<select defaultValue="" name="contextWindow">{limitOptions(CONTEXT_WINDOW_TIERS)}</select></label>
        <label>{t("home.maximumOutputTokens")}<select defaultValue="" name="maxOutputTokens">{limitOptions(MAX_OUTPUT_TIERS)}</select></label>
        <label>{t("home.contextWindowUsagePercentageThatTriggersCompaction")}<select defaultValue="" name="compactionThresholdPercent">{limitOptions(COMPACTION_TIERS, undefined, "%")}</select></label>
        <label>{t("home.thinkingEffort")}<select defaultValue="" name="thinkingEffort">
            <option value="">{t("home.defaultChosenByJoi")}</option>
            {thinkingEffortOptions()}
          </select>
        </label>
        <p className="model-source-hint">{t("home.forModelsThatAlwaysThinkAndCannotDisableThinking")}</p>
      </details>
      <div className="row-actions"><button className="button primary" disabled={busy} type="submit">{busy ? t("home.checking") : t("home.saveAndValidate")}</button><button className="button ghost" onClick={cancel} type="button">{t("common.cancel")}</button></div>
    </form> : null}
    {notice === null ? null : <p className="inline-notice info" role="status">{notice}</p>}
  </section>;
}

function modelSourceReasonText(reasonCode: string | undefined): string {
  if (reasonCode === "auth_failed") return t("home.theApiKeyDoesNotMatchThisAccessPlan");
  if (reasonCode === "rate_limited") return t("home.theApiIsRateLimitedOrOverloadedTryLater");
  if (reasonCode === "model_unavailable") return t("home.thisModelIdWasNotFoundLeaveBlankFor");
  if (reasonCode === "server_error") return t("home.theApiReturnedAServerError5xxTheService");
  if (reasonCode === "not_found") return t("home.apiAddressOrResourceNotFound404CheckThat");
  if (reasonCode === "bad_request") return t("home.theApiRejectedRequestParameters400CheckTheModel");
  if (reasonCode === "connection_error") return t("home.couldNotReachTheApiDnsConnectionOrTls");
  if (reasonCode === "timeout") return t("home.theApiConnectionTimedOutCheckYourNetworkOr");
  if (reasonCode === "empty_response") return t("home.theApiRespondedWithoutUsableContentValidateAgainLater");
  if (reasonCode === "response_truncated") return t("home.theValidationResponseHitTheOutputLimitPossiblyDue");
  if (reasonCode === "http_error") return t("home.theApiReturnedAnErrorExpandToViewThe");
  return t("home.joiCannotAccessThisApiCheckYourNetworkService");
}

/**
 * What requests on this route are really sized to. A provider that refused an oversized request
 * stated its true limit, and joi holds the route to that figure for the rest of the process — so a
 * configured value can be out of effect without anything on this page saying so.
 */
function modelLimitNote(model: JoiSnapshotDto["modelSources"][number]["activeModel"]) {
  const effective = model.effective;
  if (effective === undefined) return null;
  const configured = model.contextWindow;
  const overruled = configured !== undefined && effective.contextWindow < configured;
  return <small>{t("home.effectiveContextValueOutputValueValue", { p0: effective.contextWindow.toLocaleString(currentLocale()), p1: effective.maxOutputTokens.toLocaleString(currentLocale()), p2: (overruled ? t("home.providerLimitReducedFromValue", { p0: configured.toLocaleString(currentLocale()) }) : "") })}</small>;
}

function accessModeLabel(accessMode: ModelSourceAccessModeDto): string {
  if (accessMode === "coding-plan") return "Coding Plan";
  if (accessMode === "token-plan") return "Token Plan";
  if (accessMode === "custom") return t("home.customApi");
  return "API";
}

function modelSourceStatusLabel(status: JoiSnapshotDto["modelSources"][number]["status"]): string {
  if (status === "DRAFT") return t("home.draft");
  if (status === "VALIDATING") return t("home.validating");
  if (status === "READY") return t("status.ready");
  if (status === "DEGRADED") return t("home.temporarilyUnavailable");
  if (status === "NEEDS_AUTH") return t("home.reconnectNeeded");
  return t("status.disabled");
}

function protocolLabel(protocol: ModelSourceProtocolDto): string {
  return protocol === "anthropic" ? "Anthropic-compatible" : "OpenAI-compatible";
}

function thinkingEffortOptions() {
  return THINKING_EFFORTS.map((value) => <option key={value} value={value}>{thinkingEffortLabel(value)}</option>);
}

interface LimitTier {
  label: string;
  value: number;
}

/**
 * The tiers the token fields offer. A hand-typed figure is unchecked until a real run is refused,
 * and a refused run is what the user gets instead of an answer — so the sizes joi already reasons
 * about (its own reserve, the direct and gateway output caps, the windows vendors document) are
 * offered as choices rather than as a box that invites an arbitrary number.
 *
 * The window ladder is decimal and the output ladder binary because that is how each is documented
 * in practice. Decimal is also safe by construction: a decimal figure is never above the
 * same-labelled power of two, so picking "128K" here cannot exceed a route that accepts 128 Ki.
 */
const CONTEXT_WINDOW_TIERS: readonly LimitTier[] = [
  { label: "1M", value: 1_000_000 },
  { label: "500K", value: 500_000 },
  { label: "200K", value: 200_000 },
  { label: "128K", value: 128_000 },
  { label: "100K", value: 100_000 },
  { label: "64K", value: 64_000 },
  { label: "32K", value: 32_000 },
];

const MAX_OUTPUT_TIERS: readonly LimitTier[] = [
  { label: "128K", value: 131_072 },
  { label: "64K", value: 65_536 },
  { label: "32K", value: 32_768 },
  { label: "16K", value: 16_384 },
  { label: "8K", value: 8_192 },
  { label: "4K", value: 4_096 },
];

const COMPACTION_TIERS: readonly LimitTier[] = [
  { label: "50%", value: 50 },
  { label: "60%", value: 60 },
  { label: "70%", value: 70 },
  { label: "75%", value: 75 },
  { label: "80%", value: 80 },
  { get label() { return t("home.message85Recommended"); }, value: 85 },
  { label: "90%", value: 90 },
  { label: "95%", value: 95 },
];

/**
 * A tier list as options, preceded by the source's own figure whenever the tiers do not name it.
 * Without that entry a select can only submit one of its own options, so merely opening the form
 * and saving would rewrite a limit the user never touched.
 */
function limitOptions(tiers: readonly LimitTier[], current?: number, unit = "") {
  const kept = current === undefined || tiers.some((tier) => tier.value === current)
    ? []
    : [{ label: t("home.valueValueCurrentValue", { p0: String(current), p1: unit }), value: current }];
  return <>
    <option value="">{t("home.leaveBlankForTheRecommendedValue")}</option>
    {[...kept, ...tiers].map((tier) => <option key={tier.value} value={tier.value}>{localizeProductText(tier.label)}</option>)}
  </>;
}

export function ModelSourceManager({ api }: { api: DigitalLifeApi }) {
  useI18n();
  const [sources, setSources] = useState<JoiSnapshotDto["modelSources"]>([]);
  const [partners, setPartners] = useState<PartnerDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useNotice();
  const [noticeWarns, setNoticeWarns] = useState(false);
  const tell = useCallback((text: string, warn = false) => { setNotice(text); setNoticeWarns(warn); }, [setNotice]);
  const load = useCallback(async () => {
    try { setSources((await api.listModelSources()).items); }
    catch { tell(t("home.couldNotLoadModelConnectionSettings")); return; }
    // Partners come along because editing a source resets it to DRAFT, which strands every partner
    // pinned to it; the save has to be able to say how many that is. Advisory only, so a partner
    // list that will not load must not keep the sources off the screen.
    try { setPartners((await api.listPartners()).items); }
    catch { /* the warning is best-effort; the sources themselves are not */ }
  }, [api, tell]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  const reorder = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= sources.length) return;
    const ids = sources.map((source) => source.sourceId);
    const current = ids[index]; const replacement = ids[target];
    if (current === undefined || replacement === undefined) return;
    ids[index] = replacement; ids[target] = current;
    setSources((await api.orderModelSources(ids)).items);
  };
  const removeSource = async (sourceId: string) => {
    setNotice(null);
    try {
      await api.deleteModelSource(sourceId);
      setEditing((current) => current === sourceId ? null : current);
      tell(t("home.modelConnectionDeleted"));
      await load();
    } catch {
      tell(t("home.couldNotDeleteTheModelConnectionTryAgain"));
    }
  };
  const saveEdit = async (event: SyntheticEvent<HTMLFormElement>, source: JoiSnapshotDto["modelSources"][number]) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    // "Leave blank" must be sent as an explicit null. The revision table is append-only and the
    // service carries unchanged values forward, so merely omitting the field would keep the old
    // value and there would be no way back to the provider default.
    const numericPatch = (name: string, key: string) => {
      const raw = field(name);
      if (raw === "") return { [key]: null };
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? { [key]: parsed } : {};
    };
    const apiKey = field("apiKey");
    const thinkingEffort = field("thinkingEffort");
    const body = {
      ...(apiKey === "" ? {} : { apiKey }),
      modelId: field("modelId"),
      ...numericPatch("compactionThresholdPercent", "compactionThresholdPercent"),
      ...numericPatch("contextWindow", "contextWindow"),
      ...numericPatch("maxOutputTokens", "maxOutputTokens"),
      // Same explicit-clear shape as the numeric fields: the revision is append-only, so an
      // emptied select has to reach the service as null to mean "back to joi's own judgement".
      ...(thinkingEffort === "" ? { thinkingEffort: null } : { thinkingEffort }),
      ...(source.kind === "generic-openai" ? {
        baseUrl: field("baseUrl"), displayName: field("displayName"),
      } : {}),
    };
    try {
      await api.updateModelSource(source.sourceId, body);
      setEditing(null);
      const pinned = partners.filter((partner) => partner.status !== "DELETED" && partner.modelSourceId === source.sourceId);
      const named = pinned.slice(0, 3).map((partner) => partner.displayName).join("、");
      tell(pinned.length === 0
        ? t("home.changesSavedAsADraftRevisionValidateBeforeEnabling")
        : t("home.changesSavedAsADraftRevisionValidateBeforeEnablinga5ebda", { p0: String(pinned.length), p1: named, p2: (pinned.length > 3 ? t("home.andOthers") : "") }),
      pinned.length > 0);
      await load();
    } catch (error) {
      tell(error instanceof ApiError ? error.displayMessage : t("home.modelConnectionChangesCouldNotBeSaved"));
    }
  };
  return <section className="model-source-manager">
    <header><div><h2>{t("home.modelConnections")}</h2><p>{t("home.primaryAndBackupConnectionsAreUsedInThisOrder")}</p></div><button className="button quiet" onClick={() => setAdding((value) => !value)} type="button">{adding ? t("home.collapse") : t("home.addConnection")}</button></header>
    {adding ? <ModelSourceSetup api={api} changed={async () => { await load(); setAdding(false); }} /> : null}
    <div className="model-source-list">{sources.map((source, index) => <article className="model-source-item" key={source.sourceId}>
      <div className="model-source-summary"><div className="model-source-heading"><strong>{source.displayName}</strong><span className={`model-source-status ${source.status.toLowerCase()}`}>{modelSourceStatusLabel(source.status)}</span></div><span className="model-source-meta">{source.primary ? t("home.primary") : t("home.backupValue", { p0: String(index) })} · {accessModeLabel(source.accessMode)} · {protocolLabel(source.protocol)}</span><small>{t("home.model")}{source.activeModel.id}</small>{source.protocol === "anthropic" && source.anthropicAuthMode === "bearer" ? <small>{t("home.authenticationBearerAuthTokenDetectedAutomatically")}</small> : null}{source.activeModel.thinkingEffort === undefined ? null : <small>{t("home.thinkingEffort767f05")}{thinkingEffortLabel(source.activeModel.thinkingEffort)}</small>}{modelLimitNote(source.activeModel)}{source.baseUrl === undefined ? null : <small>{source.baseUrl}</small>}{source.status === "DEGRADED" || source.status === "NEEDS_AUTH" ? <><span className="model-source-reason">⚠ {modelSourceReasonText(source.reasonCode)}</span>{source.lastValidatedAt === undefined ? null : <small>{t("home.lastValidated")}{new Date(source.lastValidatedAt).toLocaleString(currentLocale())}</small>}{source.lastError === undefined ? null : <details className="model-source-error"><summary>{t("home.viewOriginalError")}</summary><pre>{source.lastError}</pre></details>}</> : null}</div>
      <div aria-label={t("home.valueActions", { p0: source.displayName })} className="row-actions model-source-actions" role="group"><button aria-label={t("home.editValue", { p0: source.displayName })} className="button ghost" onClick={() => setEditing(source.sourceId)} type="button">{t("common.edit")}</button><button className="button ghost" disabled={index === 0} onClick={() => void reorder(index, -1)} type="button">{t("home.moveUp")}</button><button className="button ghost" disabled={index === sources.length - 1} onClick={() => void reorder(index, 1)} type="button">{t("home.moveDown")}</button><button className="button quiet" onClick={() => void api.validateModelSource(source.sourceId).then(load).catch(() => setNotice(noticeMessage("home.validationFailed")))} type="button">{t("home.validate")}</button><button className="button ghost" onClick={() => void api.updateModelSource(source.sourceId, { disabled: true }).then(load)} type="button">{t("home.disable")}</button><button className="button danger-text" onClick={() => void removeSource(source.sourceId)} type="button">{t("common.delete")}</button></div>
      {editing === source.sourceId ? <form className="model-source-form" onSubmit={(event) => void saveEdit(event, source)}>
        {source.kind === "generic-openai" ? <><label>{t("home.editDisplayName")}<input defaultValue={source.displayName} name="displayName" required /></label><label>{t("home.editBaseUrl")}<input defaultValue={source.baseUrl} name="baseUrl" required type="url" /></label></> : null}
        <label>{t("home.editModelId")}<input defaultValue={source.activeModel.id} name="modelId" required /></label>
        <label>{t("home.replaceApiKeyLeaveBlankToKeep")}<input autoComplete="off" name="apiKey" type="password" /></label>
        <details className="model-source-advanced">
          <summary>{t("home.advancedSettings")}</summary>
          <p className="model-source-hint">{t("home.chooseTheRecommendedDefaultToResetThisValueCompaction")}</p>
          <label>{t("home.contextWindowTokens")}<select defaultValue={source.activeModel.contextWindow ?? ""} name="contextWindow">{limitOptions(CONTEXT_WINDOW_TIERS, source.activeModel.contextWindow)}</select></label>
          <label>{t("home.maximumOutputTokens")}<select defaultValue={source.activeModel.maxOutputTokens ?? ""} name="maxOutputTokens">{limitOptions(MAX_OUTPUT_TIERS, source.activeModel.maxOutputTokens)}</select></label>
          <label>{t("home.compactionThresholdWindowPercentage")}<select defaultValue={source.activeModel.compactionThresholdPercent ?? ""} name="compactionThresholdPercent">{limitOptions(COMPACTION_TIERS, source.activeModel.compactionThresholdPercent, "%")}</select></label>
          <label>{t("home.thinkingEffort")}<select defaultValue={source.activeModel.thinkingEffort ?? ""} name="thinkingEffort">
              <option value="">{t("home.defaultChosenByJoi")}</option>
              {thinkingEffortOptions()}
            </select>
          </label>
        </details>
        <div className="row-actions"><button className="button primary" type="submit">{t("home.saveChanges")}</button><button className="button ghost" onClick={() => setEditing(null)} type="button">{t("common.cancel")}</button></div>
      </form> : null}
    </article>)}</div>
    {notice === null ? null : <p className={noticeWarns ? "inline-notice warning" : "inline-notice info"} {...(noticeWarns ? { role: "alert" as const } : {})}>{notice}</p>}
  </section>;
}

function ArtifactCard({ api, artifact, source, sourceId, workbenchId }: {
  api: DigitalLifeApi;
  artifact: WorkbenchArtifactDto;
  source: "AGENT" | "GOAL";
  sourceId: string;
  workbenchId: string;
}) {
  useI18n();
  const [notice, setNotice] = useNotice();
  const available = api.desktop && artifact.artifactId !== undefined;
  const activate = async (mode: "OPEN" | "REVEAL") => {
    if (artifact.artifactId === undefined) return;
    setNotice(mode === "OPEN" ? noticeMessage("home.opening") : noticeMessage("home.locating"));
    try {
      await api.openWorkbenchArtifact(workbenchId, { artifactId: artifact.artifactId, mode, source, sourceId });
      setNotice(mode === "OPEN" ? noticeMessage("home.sentToTheSystemToOpen") : noticeMessage("home.revealedInTheFolder"));
    } catch (error) {
      setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.thisArtifactCannotBeOpenedRightNow"));
    }
  };
  return <div className={`agent-artifact ${available ? "actionable" : ""}`}>
    <span className="agent-artifact-copy"><strong>{artifact.name}</strong><span>{artifact.kind === "DIRECTORY" ? t("home.folder") : artifact.mimeType} · {String(artifact.size)} B</span></span>
    {available ? <button
      aria-label={t("home.openArtifactValue", { p0: artifact.name })}
      className="button ghost agent-artifact-open"
      onClick={() => void activate("OPEN")}
      onContextMenu={(event) => { event.preventDefault(); void activate("REVEAL"); }}
      title={t("home.clickToOpenRightClickToRevealInFolder")}
      type="button"
    >{artifact.kind === "DIRECTORY" ? t("home.openFolder") : t("common.open")}</button> : null}
    {notice === null ? null : <small className="agent-artifact-notice" role="status">{notice}</small>}
  </div>;
}

function ArtifactFolder({ api, directory, items, source, sourceId, timestamp, workbenchId }: {
  api: DigitalLifeApi;
  directory: string | undefined;
  items: WorkbenchArtifactDto[];
  source: "AGENT" | "GOAL";
  sourceId: string;
  timestamp?: string;
  workbenchId: string;
}) {
  useI18n();
  return <details className="agent-artifact-group">
    <summary><span>{t("home.file")}</span><code>{artifactGroupLabel(directory, t("catalog.workspaceRoot"))} · {String(items.length)}  {t("home.files")}</code>{timestamp === undefined ? null : <time dateTime={timestamp}>{new Date(timestamp).toLocaleString(currentLocale())}</time>}</summary>
    {items.map((artifact) => <ArtifactCard
      api={api} artifact={artifact} key={artifact.artifactId ?? `${artifact.name}:${String(artifact.size)}`}
      source={source} sourceId={sourceId} workbenchId={workbenchId}
    />)}
  </details>;
}

function groupAgentEntries(items: AgentConversationEntryDto[]) {
  const groups: { entry: AgentConversationEntryDto; entries: AgentConversationEntryDto[] }[] = [];
  for (const entry of items) {
    const previous = groups.at(-1);
    const isTool = entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT";
    if (isTool && entry.toolName !== undefined && previous?.entry.toolName === entry.toolName
      && (previous.entry.kind === "TOOL_CALL" || previous.entry.kind === "TOOL_RESULT")) {
      previous.entries.push(entry);
    } else { groups.push({ entry, entries: [entry] }); }
  }
  return groups;
}

type ToolTraceView =
  | { status: "loading" }
  | { status: "ready"; trace: WorkbenchToolTraceDto }
  | { status: "error"; message: string };

/** The newest call in a group is the one worth surfacing: it is what is running now. */
function newestCallSummary(entries: AgentConversationEntryDto[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index];
    if (item?.kind === "TOOL_CALL" && item.text !== undefined && item.text !== "") return item.text;
  }
  return undefined;
}

/**
 * The call whose full body the group can reveal. Only a call that already produced a result
 * qualifies, which also means its private body is committed — the engine writes the status
 * frame before the trace.
 */
function lastRevealableCall(entries: AgentConversationEntryDto[]): { toolCallId: string; toolName: string } | undefined {
  const completed = new Set(entries
    .filter((item) => item.kind === "TOOL_RESULT" && item.toolCallId !== undefined)
    .map((item) => item.toolCallId));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index];
    if (item?.kind === "TOOL_CALL" && item.toolCallId !== undefined && completed.has(item.toolCallId)) {
      return { toolCallId: item.toolCallId, toolName: item.toolName ?? "tool" };
    }
  }
  return undefined;
}

function ToolTraceBody({ view, onReveal }: { view: ToolTraceView | undefined; onReveal: () => void }) {
  useI18n();
  if (view?.status === "ready") {
    return <div className="agent-tool-trace">
      <p className="agent-tool-trace-label">{t("home.command")}</p>
      <pre>{view.trace.command === "" ? t("home.noCommandText") : view.trace.command}</pre>
      <p className="agent-tool-trace-label">{t("home.output")}{view.trace.isError ? t("home.failed") : ""}</p>
      <pre>{view.trace.result === "" ? t("home.noOutput") : view.trace.result}</pre>
      {view.trace.truncated ? <p className="agent-tool-trace-note">{t("home.contentExceeded8KbAndWasTruncated")}</p> : null}
      <button className="button ghost agent-tool-trace-open" onClick={onReveal} type="button">{t("home.reload")}</button>
    </div>;
  }
  return <div className="agent-tool-trace">
    {view?.status === "error" ? <p className="agent-tool-trace-error" role="alert">{view.message}</p> : null}
    <button className="button quiet agent-tool-trace-open" disabled={view?.status === "loading"} onClick={onReveal} type="button">
      {view?.status === "loading" ? t("home.loading") : view?.status === "error" ? t("common.retry") : t("home.viewFullOutput")}
    </button>
  </div>;
}

function ToolEntry({ entry, entries, running, traces, onReveal, desktop }: {
  entry: AgentConversationEntryDto;
  entries: AgentConversationEntryDto[];
  running: boolean;
  traces: Record<string, ToolTraceView>;
  onReveal: (toolCallId: string) => void;
  desktop: boolean;
}) {
  useI18n();
  const grouped = entries.length > 1;
  const calls = entries.filter((item) => item.kind === "TOOL_CALL").length;
  const results = entries.length - calls;
  const label = grouped ? t("home.tool") : entry.kind === "TOOL_CALL" ? t("home.toolCall") : t("home.toolResult");
  const summary = newestCallSummary(entries);
  const target = desktop ? lastRevealableCall(entries) : undefined;
  return <article className={grouped ? "agent-message tool" : `agent-message tool ${entry.kind.toLowerCase()}`}>
    <details className={`agent-tool-compact ${entry.kind === "TOOL_RESULT" ? "result" : ""}`}>
      <summary>
        <span>{label}</span>
        {/* The tool name stays its own element so a group still reads as `bash ×3`. */}
        <span className="agent-tool-line">
          <code>{grouped ? `${entry.toolName ?? "tool"} ×${String(Math.max(calls, results))}` : entry.toolName ?? (entry.kind === "TOOL_CALL" ? "tool" : "")}</code>
          {running ? <span className="agent-tool-running">{t("home.running")}</span> : null}
          {summary === undefined ? null : <span className="agent-tool-summary">{summary}</span>}
        </span>
        <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString(currentLocale())}</time>
      </summary>
      {grouped
        ? entries.map((item) => <div key={item.entryId}><small>{item.kind === "TOOL_CALL" ? t("home.toolCall") : t("home.toolResult")} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(currentLocale())}</time></small>{item.text ? <pre>{item.text}</pre> : null}</div>)
        : entry.text === undefined || entry.text === "" ? null : <pre>{entry.text}</pre>}
      {target === undefined ? null : <ToolTraceBody onReveal={() => { onReveal(target.toolCallId); }} view={traces[target.toolCallId]} />}
    </details>
  </article>;
}

function GoalArtifacts({ api, goal }: { api: DigitalLifeApi; goal: JoiGoalCardDto }) {
  useI18n();
  if (goal.artifacts === undefined || goal.artifacts.length === 0) return null;
  return <section aria-label={t("home.resultArtifact")} className="joi-goal-artifacts">
    <h3>{t("home.artifacts")}</h3>
    {groupArtifactsForDisplay(goal.artifacts, (artifact) => artifact).map((row, index) => row.kind === "FOLDER"
      ? <ArtifactFolder
        api={api} directory={row.directory} items={row.items} key={`folder:${row.directory ?? ""}:${String(index)}`}
        source="GOAL" sourceId={goal.goalId} workbenchId={goal.workbench.workbenchId}
      />
      : <ArtifactCard
        api={api} artifact={row.item} key={row.item.artifactId ?? `${row.item.name}:${String(row.item.size)}`}
        source="GOAL" sourceId={goal.goalId} workbenchId={goal.workbench.workbenchId}
      />)}
  </section>;
}

function mergeConversationItems(older: AgentConversationEntryDto[], newer: AgentConversationEntryDto[]) {
  return [...new Map([...older, ...newer].map(entry => [entry.entryId, entry])).values()]
    .sort((a, b) => a.sequence - b.sequence || a.entryId.localeCompare(b.entryId));
}

export function AgentMessageStream({ agent, api, workbenchId, goalId, live = false }: {
  agent: WorkbenchAgentCardDto;
  api: DigitalLifeApi;
  workbenchId: string;
  goalId?: string;
  live?: boolean;
}) {
  useI18n();
  const [page, setPage] = useState<AgentConversationPageDto | null>(null);
  const [following, setFollowing] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [notice, setNotice] = useNotice();
  // Revealed bodies live here rather than in ToolEntry so the 750 ms poll cannot drop an
  // expanded view, and so ToolEntry stays stateless.
  const [toolTraces, setToolTraces] = useState<Record<string, ToolTraceView>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const currentPage = useRef<AgentConversationPageDto | null>(null);
  const followLatest = useRef(true);
  const positioned = useRef(false);
  const historyBusy = useRef(false);
  const historyAnchor = useRef<{ height: number; top: number } | null>(null);
  const generation = useRef(0);
  const publish = useCallback((next: AgentConversationPageDto) => { currentPage.current = next; setPage(next); }, []);
  const read = useCallback((cursor?: string) => api.agentConversation(workbenchId, agent.agentId, {
    limit: 50, latest: true, ...(goalId === undefined ? {} : { goalId }), ...(cursor === undefined ? {} : { cursor }),
  }), [agent.agentId, api, goalId, workbenchId]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const previous = currentPage.current;
        let next = await read();
        // Catch up after a slow/background tab without leaving a hole between pages.
        const known = new Set(previous?.items.map(item => item.entryId));
        const cursors = new Set<string>();
        while (!cancelled && known.size > 0 && next.nextCursor !== undefined
          && !next.items.some(item => known.has(item.entryId)) && !cursors.has(next.nextCursor)) {
          cursors.add(next.nextCursor);
          const older = await read(next.nextCursor);
          next = { ...older, agent: next.agent, items: mergeConversationItems(older.items, next.items) };
        }
        if (cancelled) return;
        const current = currentPage.current;
        publish(current === null || current.items.length === 0 ? next : {
          ...current, agent: next.agent, items: mergeConversationItems(current.items, next.items),
        });
        setNotice(null);
      } catch (error) {
        if (!cancelled) setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.couldNotLoadTheAgentConversation"));
      } finally {
        const status = currentPage.current?.agent.status;
        if (!cancelled && live && (status === undefined || status === "RUNNING" || status === "WAITING")) timer = setTimeout(() => void load(), 750);
      }
    };
    timer = setTimeout(() => void load(), 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [live, publish, read, setNotice]);
  useEffect(() => () => { generation.current += 1; }, [read]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    if (followLatest.current) element.scrollTop = element.scrollHeight;
    else if (historyAnchor.current !== null) element.scrollTop = historyAnchor.current.top + element.scrollHeight - historyAnchor.current.height;
    historyAnchor.current = null;
    if (!positioned.current && page !== null && page.items.length > 0) {
      positioned.current = true;
      element.scrollIntoView({ block: "end", inline: "nearest" });
    }
  }, [page]);
  const revealToolTrace = useCallback(async (toolCallId: string) => {
    setToolTraces((current) => ({ ...current, [toolCallId]: { status: "loading" } }));
    try {
      const trace = await api.revealWorkbenchToolTrace(workbenchId, agent.agentId, toolCallId);
      setToolTraces((current) => ({ ...current, [toolCallId]: { status: "ready", trace } }));
    } catch (error) {
      const message = error instanceof ApiError ? error.displayMessage : t("home.couldNotLoadTheFullToolOutput");
      setToolTraces((current) => ({ ...current, [toolCallId]: { status: "error", message } }));
    }
  }, [agent.agentId, api, workbenchId]);
  const loadMore = useCallback(async () => {
    const cursor = currentPage.current?.nextCursor;
    if (cursor === undefined || historyBusy.current) return;
    const revision = generation.current;
    historyBusy.current = true;
    setLoadingHistory(true);
    try {
      const next = await read(cursor);
      if (revision !== generation.current) return;
      const element = viewport.current;
      if (element !== null) historyAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
      const current = currentPage.current;
      publish({ ...next, agent: current?.agent ?? next.agent, items: mergeConversationItems(next.items, current?.items ?? []) });
      setNotice(null);
    } catch (error) {
      if (revision === generation.current) setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.couldNotLoadEarlierEntriesScrollUpToRetry"));
    } finally {
      historyBusy.current = false;
      if (revision === generation.current) setLoadingHistory(false);
    }
  }, [publish, read, setNotice]);
  useEffect(() => {
    // Compact tool groups can leave a page shorter than the viewport: fill it so
    // history is reachable even when there is no scrollbar yet.
    const timer = setTimeout(() => {
      const element = viewport.current;
      if (element !== null && element.clientHeight > 0 && element.scrollHeight <= element.clientHeight) void loadMore();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadMore, page]);
  const trailing = page?.items.at(-1);
  // pi executes tools sequentially, so a trailing TOOL_CALL with no result after it is the
  // one running now. The RUNNING gate keeps a crashed run's dangling call from claiming life.
  const runningEntryId = page?.agent.status === "RUNNING" && trailing?.kind === "TOOL_CALL" ? trailing.entryId : undefined;
  // Grouping walks the whole page, and the poll timer re-renders this component even when the
  // page came back unchanged, so the derivation is memoized on the item list.
  const streamRows = useMemo(
    () => groupArtifactsForDisplay(groupAgentEntries(page?.items ?? []), (group) => group.entry.kind === "ARTIFACT" ? group.entry.artifact : undefined),
    [page?.items],
  );
  return <>
    {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
    <div className="agent-stream-viewport" ref={viewport} role="log" aria-label={t("home.agentExecutionHistory")} aria-live="off" tabIndex={0} onScroll={() => {
      const element = viewport.current;
      if (element === null || element.clientHeight === 0) return;
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      followLatest.current = atBottom;
      setFollowing(atBottom);
      if (element.scrollTop < 64 && !atBottom) void loadMore();
    }}>
    {page?.nextCursor === undefined ? null : <p className="agent-history-hint">{loadingHistory ? t("home.loadingEarlierEntries") : t("home.scrollUpForEarlierEntries")}</p>}
    {page === null ? <p className="content-state">{t("home.preparingTheConversation")}</p> : <div className="agent-message-stream">{page.items.length === 0 ? <p className="plain-empty">{t("home.thisAgentHasNoExecutionMessagesToShowYet")}</p> : streamRows.map((row) => {
      if (row.kind === "FOLDER") {
        const first = row.items[0];
        if (first === undefined) return null;
        return <article className="agent-message tool" key={first.entry.entryId}>
          <ArtifactFolder
            api={api} directory={row.directory} items={row.items.flatMap((group) => group.entry.artifact === undefined ? [] : [group.entry.artifact])}
            source="AGENT" sourceId={agent.agentId} timestamp={first.entry.createdAt} workbenchId={workbenchId}
          />
        </article>;
      }
      const { entry, entries } = row.item;
      return entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT"
      ? <ToolEntry
        desktop={api.desktop} entries={entries} entry={entry} key={entry.entryId}
        onReveal={(toolCallId) => void revealToolTrace(toolCallId)}
        running={entries.some((item) => item.entryId === runningEntryId)}
        traces={toolTraces}
      />
      : <article className={`agent-message ${entry.role.toLowerCase()} ${entry.kind.toLowerCase()}`} key={entry.entryId}>
      <header><strong>{entry.role === "USER" ? t("home.task") : entry.role === "AGENT" ? agent.partnerName : entry.role === "TOOL" ? t("home.tool") : t("home.system")}</strong><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString(currentLocale())}</time></header>
      {entry.kind === "ARTIFACT" && entry.artifact !== undefined
        ? <ArtifactCard api={api} artifact={entry.artifact} source="AGENT" sourceId={agent.agentId} workbenchId={workbenchId} />
        : entry.kind === "ARTIFACT" ? <div className="agent-artifact"><span className="agent-artifact-copy"><strong>{t("home.artifacts")}</strong><span>{t("home.file0B")}</span></span></div>
          : <Markdown>{entry.text ?? ""}</Markdown>}
    </article>;})}</div>}
    </div>
    {following ? null : <button className="button ghost agent-load-more" onClick={() => {
      followLatest.current = true;
      setFollowing(true);
      if (viewport.current !== null) {
        viewport.current.scrollTop = viewport.current.scrollHeight;
        viewport.current.scrollIntoView({ block: "end", inline: "nearest" });
      }
    }} type="button">{t("home.jumpToLatest")}</button>}
  </>;
}

function AgentConversation({ agent, api, workbenchId, onBack }: {
  agent: WorkbenchAgentCardDto;
  api: DigitalLifeApi;
  workbenchId: string;
  onBack: () => void;
}) {
  useI18n();
  return <section className="agent-conversation" aria-label={t("home.valueConversation", { p0: agent.partnerName })}>
    <header className="agent-detail-header"><button className="button ghost" onClick={onBack} type="button">{t("home.backToAgents")}</button><div><p className="eyebrow">{t("home.readOnlyExecutionHistory")}</p><h2>{agent.partnerName}</h2><span>{agent.transport} · {agent.sessionPolicy} · {agentExecutionLabel(agent)}</span></div></header>
    <AgentMessageStream key={agent.agentId} agent={agent} api={api} workbenchId={workbenchId} live={agent.status === "RUNNING" || agent.status === "WAITING"} />
  </section>;
}

function formatWorkbenchUpdated(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function WorkbenchManager({ api, initialWorkbenchId }: { api: DigitalLifeApi; initialWorkbenchId?: string }) {
  useI18n();
  const [removing, setRemoving] = useState<{ workbenchId: string; name: string } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useNotice();
  const removeLock = useRef(false);
  const removeDialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (removing === null) return;
    const previousFocus = document.activeElement;
    removeDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, [removing]);
  const [workbenches, setWorkbenches] = useState<WorkbenchDto[]>([]);
  const [detail, setDetail] = useState<WorkbenchDetailDto | null>(null);
  const [agents, setAgents] = useState<WorkbenchAgentCardDto[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<WorkbenchAgentCardDto | null>(null);
  const [tab, setTab] = useState<"agents" | "context" | "evolution">("agents");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useNotice();
  const load = useCallback(async () => setWorkbenches((await api.listWorkbenches()).items), [api]);
  const loadAgents = useCallback(async (workbenchId: string) => {
    try {
      const page = await api.listWorkbenchAgents(workbenchId, { limit: 100 });
      setAgents(Array.isArray(page.items) ? page.items : []);
    }
    catch { setAgents([]); }
  }, [api]);
  const open = useCallback(async (workbenchId: string, nextTab: "agents" | "context" | "evolution" = "agents") => {
    try {
      setDetail(await api.getWorkbench(workbenchId));
      setSelectedAgent(null); setTab(nextTab); setNotice(null);
      await loadAgents(workbenchId);
    } catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.couldNotLoadTheWorkbenchContext")); }
  }, [api, loadAgents, setNotice]);
  useEffect(() => { const timer = setTimeout(() => void load().catch(() => setNotice(noticeMessage("home.couldNotLoadTheWorkbenchList"))), 0); return () => clearTimeout(timer); }, [load, setNotice]);
  useEffect(() => {
    if (initialWorkbenchId === undefined) return;
    const timer = setTimeout(() => void open(initialWorkbenchId), 0);
    return () => clearTimeout(timer);
  }, [initialWorkbenchId, open]);
  useEffect(() => {
    if (detail === null || selectedAgent !== null) return undefined;
    const timer = setInterval(() => void loadAgents(detail.workbenchId), 1_500);
    return () => clearInterval(timer);
  }, [detail, loadAgents, selectedAgent]);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    await api.createWorkbench({ name: field("name"), personaSummary: field("personaSummary"), projectLabel: field("projectLabel"), scopeSummary: field("scopeSummary") });
    setAdding(false); setNotice(noticeMessage("home.workbenchCreatedJoiWillContinueToAssignAndManage")); await load();
  };
  const saveDetail = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (detail === null) return;
    const form = new FormData(event.currentTarget);
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    const persona = field("persona");
    try {
      setDetail(await api.updateWorkbench(detail.workbenchId, { name: field("name"), ...(persona === "" ? {} : { persona }), projectLabel: field("projectLabel"), responsibility: field("responsibility") }));
      setNotice(noticeMessage("home.workbenchContextUpdated")); await load();
    } catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.workbenchCouldNotBeSaved")); }
  };
  const workspaceAction = async (action: "bind" | "rebuild") => {
    if (detail === null) return;
    try {
      if (action === "bind") await api.bindWorkbenchWorkspace(detail.workbenchId); else await api.rebuildWorkbenchWorkspace(detail.workbenchId);
      await open(detail.workbenchId, tab);
      setNotice(action === "bind" ? noticeMessage("home.existingDirectoryBound") : noticeMessage("home.switchedToTheDefaultRunDirectoryNewTasksWill"));
    } catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.theWorkspaceOperationDidNotComplete")); }
  };
  const removeAgent = async (agent: WorkbenchAgentCardDto) => {
    if (detail === null) return;
    try { await api.deleteWorkbenchAgent(detail.workbenchId, agent.agentId); await loadAgents(detail.workbenchId); }
    catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.theAgentCouldNotBeDeleted")); }
  };
  const requestRemoval = (workbench: { workbenchId: string; name: string }) => {
    setRemoveError(null); setRemoving(workbench);
  };
  const removeWorkbench = async () => {
    if (removing === null || removeLock.current) return;
    removeLock.current = true; setRemoveBusy(true); setRemoveError(null);
    try {
      await api.archiveWorkbench(removing.workbenchId);
      setWorkbenches((items) => items.filter((item) => item.workbenchId !== removing.workbenchId));
      setDetail(null); setAgents([]); setSelectedAgent(null); setRemoving(null);
      setNotice(noticeMessage("home.workbenchRemovedHistoryAndWorkingDirectoryArePreserved"));
    } catch (error) {
      setRemoveError(error instanceof ApiError && error.code === "workbench_change_active_work"
        ? noticeMessage("home.theWorkbenchStillHasUnfinishedTasksCompleteOrCancel")
        : noticeMessage("home.workbenchCouldNotBeRemovedTryAgain"));
    } finally { removeLock.current = false; setRemoveBusy(false); }
  };
  if (detail !== null && selectedAgent !== null) return <AgentConversation agent={selectedAgent} api={api} workbenchId={detail.workbenchId} onBack={() => setSelectedAgent(null)} />;
  return <section className="partner-manager page-section">
    {removing === null ? null : <div className="dialog-backdrop"><section aria-labelledby="remove-workbench-title" aria-modal="true" className="dialog" ref={removeDialog} role="dialog" tabIndex={-1} onKeyDown={(event) => {
      if (event.key === "Escape" && !removeBusy) setRemoving(null);
      if (event.key === "Tab") {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const next = buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
        event.preventDefault(); (next ?? event.currentTarget).focus();
      }
    }}>
      <h2 id="remove-workbench-title">{t("common.remove")}{removing.name}”？</h2>
      <p>{t("home.theWorkbenchWillBeRemovedFromTheListAnd")}</p>
      {removeError === null ? null : <p role="alert">{removeError}</p>}
      <div className="row-actions"><button className="button ghost" disabled={removeBusy} onClick={() => setRemoving(null)} type="button">{t("common.cancel")}</button><button className="button danger-text" disabled={removeBusy} onClick={() => void removeWorkbench()} type="button">{removeBusy ? t("home.removing") : t("home.confirmRemoval")}</button></div>
    </section></div>}
    <header className="page-title-row"><div><p className="eyebrow">{t("home.workbenchAgent")}</p><h1>{detail?.name ?? t("common.workbenches")}</h1><p>{detail === null ? t("home.eachWorkbenchHoldsALongTermContextAgentsAre") : t("home.allAgentsStartedByThisWorkbenchRemainHereUntil")}</p></div>{detail === null ? <button className={adding ? "button quiet" : "button primary"} onClick={() => setAdding((value) => !value)} type="button">{adding ? t("home.collapse") : t("home.createWorkbench")}</button> : <div className="row-actions"><button className="button danger-text" onClick={() => requestRemoval(detail)} type="button">{t("home.removeWorkbench")}</button><button className="button ghost" onClick={() => { setDetail(null); setAgents([]); }} type="button">{t("home.backToWorkbenches")}</button></div>}</header>
    {detail === null && adding ? <form className="partner-form" onSubmit={(event) => void submit(event)}><label>{t("automation.name")}<input name="name" placeholder={t("home.workCategoryEGFrontendDebugging")} required /></label><label>{t("home.projectName")}<input name="projectLabel" placeholder={t("home.workEnvironmentProjectEGDigitalLife")} required /></label><label>{t("home.responsibilities")}<textarea name="scopeSummary" placeholder={t("home.describeTheSharedEnvironmentAndBoundariesOfThisWork")} required rows={4} /></label><label>{t("home.personaSummary")}<textarea name="personaSummary" placeholder={t("home.describeLongTermWorkConstraintsRatherThanAnIndividual")} required rows={4} /></label><button className="button primary" type="submit">{t("home.saveWorkbench")}</button></form> : null}
    {detail === null ? (workbenches.length === 0 ? <div className="plain-empty"><h2>{t("home.noWorkbenchesYet")}</h2><p>{t("home.tellJoiYourGoalOnTheHomePageIt")}</p></div> : <div className="workbench-catalog">{workbenches.map((workbench) => <article className="workbench-catalog-entry" key={workbench.workbenchId}><button aria-label={t("home.openWorkbenchValue", { p0: workbench.name })} className="workbench-catalog-open" onClick={() => void open(workbench.workbenchId)} type="button"><span className="workbench-catalog-head"><span aria-hidden="true" className="workbench-orb">{workbench.name.slice(0, 1)}</span><strong>{workbench.name}</strong></span><span className="workbench-catalog-scope" title={workbench.scopeSummary}>{workbench.scopeSummary}</span></button><footer className="workbench-catalog-footer"><time dateTime={workbench.updatedAt} title={new Date(workbench.updatedAt).toLocaleString(currentLocale())}>{t("home.updated")} {formatWorkbenchUpdated(workbench.updatedAt)}</time><span className="workbench-catalog-actions"><button aria-label={t("home.manageContextValue", { p0: workbench.name })} className="workbench-catalog-manage" onClick={() => void open(workbench.workbenchId, "context")} type="button">{t("home.manageContext")}</button><button aria-label={t("home.removeWorkbenchValue", { p0: workbench.name })} className="button danger-text workbench-catalog-remove" onClick={() => requestRemoval(workbench)} type="button">{t("home.removeWorkbench")}</button></span></footer></article>)}</div>) : <>
      <article aria-label={t("home.workspace")} className="workbench-workspace-bar">
        <div className="workbench-workspace-info">
          <h3>{t("home.workspace")}</h3>
          <p>{detail.workspace.kind === "BOUND" ? t("home.newTasksInThisWorkbenchUseTheSpecifiedDirectory") : t("home.eachNewTaskGetsASeparateDirectoryUnderJoi")}</p>
          <p className="workbench-workspace-state"><strong>{detail.workspace.kind === "BOUND" ? detail.workspace.displayName : t("home.defaultRunDirectory")}</strong> · {detail.workspace.kind} · {detail.workspace.status}{detail.workspace.failureReasonCode === undefined ? null : <small> · {detail.workspace.failureReasonCode}</small>}</p>
        </div>
        <div className="row-actions"><button className="button ghost" onClick={() => void workspaceAction("bind")} type="button">{t("home.bindExistingDirectory")}</button><button className="button ghost" onClick={() => void workspaceAction("rebuild")} type="button">{t("home.useDefaultRunDirectory")}</button></div>
      </article>
      <div className="workbench-detail-tabs" role="tablist"><button aria-selected={tab === "agents"} onClick={() => setTab("agents")} role="tab" type="button">Agent <span>{agents.length}</span></button><button aria-selected={tab === "context"} onClick={() => setTab("context")} role="tab" type="button">{t("home.contextSettings")}</button><button aria-selected={tab === "evolution"} onClick={() => setTab("evolution")} role="tab" type="button">{t("home.automaticEvolution")}</button></div>
      {tab === "agents" ? <div className="workbench-agent-list">{agents.length === 0 ? <div className="plain-empty"><h2>{t("home.noAgentsYet")}</h2><p>{t("home.agentsAppearHereWhenJoiAssignsWorkToThis")}</p></div> : agents.map((agent) => <article className="workbench-agent-card" key={agent.agentId}><button aria-label={t("home.viewDetailsForValue", { p0: agent.partnerName })} className="workbench-agent-open" onClick={() => setSelectedAgent(agent)} type="button"><span className="agent-workbench">{agent.partnerName.slice(0, 1)}</span><span><strong>{agent.partnerName}</strong><small>{agent.transport} · {agent.engine} · {agent.sessionPolicy}</small></span><i className={`agent-status ${(agent.resultAssessment === "INSUFFICIENT" && agent.status === "FAILED" ? "insufficient" : agent.status.toLowerCase())}`}>{agentExecutionLabel(agent)}</i><time>{new Date(agent.lastActivityAt).toLocaleString(currentLocale())}</time></button>{agent.canDelete ? <button aria-label={t("home.deleteValue", { p0: agent.partnerName })} className="button danger-text agent-delete" onClick={() => void removeAgent(agent)} type="button">{t("common.delete")}</button> : null}</article>)}</div> : tab === "context" ? <div className="workbench-context-center">
        <form className="partner-form" onSubmit={(event) => void saveDetail(event)}><label>{t("automation.name")}<input defaultValue={detail.name} name="name" required /></label><label>{t("home.projectName")}<input defaultValue={detail.projectLabel} name="projectLabel" required /></label><label>{t("home.responsibilities")}<textarea defaultValue={detail.responsibility} name="responsibility" required rows={4} /></label><label>{t("home.submitANewPersonaRevisionLeaveBlankToKeep")}<textarea name="persona" rows={4} /></label><button className="button primary" type="submit">{t("home.saveContext")}</button></form>
        <article className="context-card"><h3>{t("home.activeWork")}</h3>{detail.activeWork.length === 0 ? <p>{t("home.noUnfinishedWorkRightNow")}</p> : <ul>{detail.activeWork.map((work) => <li key={work.workId}>{work.title} · {agentExecutionLabel(work)}</li>)}</ul>}</article>
        <article className="context-card"><h3>{t("home.recentResultSummaries")}</h3>{detail.recentOutcomes.length === 0 ? <p>{t("home.noGoalLevelSummariesYet")}</p> : <ul>{detail.recentOutcomes.map((item) => <li key={`${item.goalId}:${String(item.resultRevision)}`}><strong>{item.title}</strong><span>{item.summary}</span><small>{recentOutcomeLabel(item.status)} · {new Date(item.completedAt).toLocaleString(currentLocale())}</small></li>)}</ul>}</article>
      </div> : <div className="workbench-context-center"><WorkbenchEvolutionPanel api={api} key={detail.workbenchId} workbenchId={detail.workbenchId} /></div>}
    </>}
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
  </section>;
}

// 单行起步的补充说明输入框：内容超行时自动长高，封顶后内部滚动；Enter 提交、Shift+Enter 换行。
function ClarifyTextarea({ "aria-label": ariaLabel, disabled, onChange, onKeyDown, placeholder, value }: {
  "aria-label": string;
  disabled: boolean;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  value: string;
}) {
  useI18n();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const computed = getComputedStyle(node);
    const borders = Number.parseFloat(computed.borderTopWidth) + Number.parseFloat(computed.borderBottomWidth);
    node.style.height = "auto";
    node.style.height = `${String(node.scrollHeight + borders)}px`;
  }, [value]);
  return <textarea aria-label={ariaLabel} disabled={disabled} onChange={onChange} onKeyDown={onKeyDown} placeholder={placeholder} ref={ref} rows={1} value={value} />;
}

function ClarificationActions({ api, partners, workbenchId, workbenches, inputId, onResolved, prompt, questionId, questionVersion, reasonCode, suggestionSeed, continuationSummary, onShowContinuationResult }: {
  api: DigitalLifeApi;
  partners: PartnerDto[];
  workbenchId: string | undefined;
  workbenches: WorkbenchDto[];
  inputId: string;
  onResolved: () => void;
  prompt: string | undefined;
  questionId: string | undefined;
  questionVersion: number | undefined;
  reasonCode: string | undefined;
  suggestionSeed?: string;
  continuationSummary?: string | undefined;
  onShowContinuationResult?: () => void;
}) {
  useI18n();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNotice();
  const isQuestion = reasonCode === "question_required";
  const needsPartnerChoice = reasonCode === "partner_selection_required";
  const needsWaitingRecovery = reasonCode === "partner_waiting_recovery_required" || reasonCode === "partner_auth_required";
  const needsGoalContinuation = reasonCode === "goal_continuation_required";
  const needsReviewRetry = reasonCode === "goal_review_interrupted";
  const needsWorkspace = reasonCode === "workbench_workspace_not_ready";
  const needsWorkbenchChoice = reasonCode === "workbench_selection_invalid" || reasonCode === "workbench_creation_unavailable" || reasonCode === "workbench_not_found";
  const needsHistoricalReview = reasonCode === "harness_review_unrecoverable";
  const assignedWorkbench = workbenches.find((workbench) => workbench.workbenchId === workbenchId);
  const selectablePartners = partners.filter((partner) => partner.status === "ACTIVE" && partner.configuration === undefined);
  const resolve = async (resolution: { actionChoice?: "RESUME" | "CONTINUE" | "ACCEPT_CURRENT"; partnerId?: string; workbenchId?: string; text?: string }) => {
    setBusy(true); setNotice(null);
    try {
      await api.clarifyJoiMessage(inputId, { ...resolution, ...(questionId === undefined || questionVersion === undefined ? {} : { questionId, questionVersion }) });
      setNotice(noticeMessage("home.sentToJoiRearranging"));
      setDraft("");
      onResolved();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.couldNotSendToJoiTryAgain"));
    } finally {
      setBusy(false);
    }
  };
  const submitDraft = () => { void resolve({ text: draft.trim() }); };
  const chooseWorkspace = async () => {
    if (workbenchId === undefined) {
      setNotice(noticeMessage("home.thisTaskHasNoWorkbenchYetSoAWorking"));
      return;
    }
    setBusy(true); setNotice(null);
    try {
      await api.bindWorkbenchWorkspace(workbenchId);
      await api.clarifyJoiMessage(inputId, { workbenchId, ...(questionId === undefined || questionVersion === undefined ? {} : { questionId, questionVersion }) });
      setNotice(noticeMessage("home.workingDirectoryBoundJoiIsContinuingThePlan"));
      onResolved();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("home.couldNotBindTheWorkingDirectoryTryAgain"));
    } finally {
      setBusy(false);
    }
  };
  return <div className="joi-clarify">
    <p className="joi-clarify-label">{needsHistoricalReview ? t("home.joiIsReconcilingHistoricalStatus") : needsGoalContinuation ? t("home.continueImprovingTheResult") : t("home.joiNeedsYourConfirmation")}</p>
    <p className="joi-clarify-reason">{clarificationText(reasonCode, prompt, assignedWorkbench?.name)}</p>
    {needsGoalContinuation ? <section aria-label={t("home.currentResultAndRemainingWork")} className="joi-continuation-context">
      <strong>{t("home.currentResultAndRemainingWork")}</strong>
      {continuationSummary?.trim() ? <div aria-label={t("home.currentResultNotes")} className="joi-continuation-body joi-md" role="region" tabIndex={0}><Markdown>{continuationSummary}</Markdown></div> : <p className="joi-clarify-hint">{t("home.noResultNotesAreAvailableYetToIdentifySpecific")}</p>}
      {continuationSummary?.trim() && onShowContinuationResult !== undefined ? <button className="button ghost" onClick={onShowContinuationResult} type="button">{t("home.viewTheFullCurrentResult")}</button> : null}
    </section> : null}
    {needsHistoricalReview ? <div className="joi-clarify-workspace">
      <div><strong>{t("home.sentToJoiForReconciliation")}</strong><span>{t("home.joiReconcilesStatusUsingCompletedWorkAndClosedPaths")}</span></div>
    </div> : needsPartnerChoice ? <>
      {selectablePartners.length === 0 ? <p className="joi-clarify-hint">{t("home.noPartnersAreAvailableOpenPartnersToFixOr")}</p> : null}
      {selectablePartners.length === 0 ? null : <div className="joi-clarify-partner-list" role="group" aria-label={t("home.chooseAPartnerToContinue")}>
        {selectablePartners.map((partner) => <button className="joi-clarify-partner" disabled={busy} key={partner.partnerId} onClick={() => void resolve({ partnerId: partner.partnerId })} type="button">
          <strong>{partner.displayName}</strong>
          <span>{partner.description ?? (partner.kind === "local-pi" ? t("home.localPartner") : t("home.remotePartner"))}</span>
        </button>)}
      </div>}
    </> : needsWorkbenchChoice ? <WorkbenchChoiceForm api={api} message={{ inputId, ...(suggestionSeed === undefined ? {} : { textPreview: suggestionSeed }), ...(questionId === undefined ? {} : { questionId }), ...(questionVersion === undefined ? {} : { questionVersion }) }} onResolved={onResolved} workbenches={workbenches} /> : null}
    {needsHistoricalReview || needsPartnerChoice ? null : needsReviewRetry ? <div className="joi-clarify-workspace">
      <div><strong>{t("home.recheckExistingWork")}</strong><span>{t("home.existingAnswersAndResultsArePreservedJoiWillReview")}</span></div>
      <button className="button primary" disabled={busy} onClick={() => void resolve({ text: REVIEW_RETRY_TEXT })} type="button">{busy ? t("home.submitting") : t("home.retryReview")}</button>
    </div> : needsGoalContinuation ? <div className="joi-clarify-workspace">
      <div><span>{t("home.continueImprovingTryUpToTwoMoreRoundsYou")}</span><span>{t("home.keepCurrentResultEndThisTaskPreserveConclusionsAnd")}</span></div>
      <span className="row-actions">
        <button className="button primary" disabled={busy} onClick={() => void resolve({ actionChoice: "CONTINUE" })} type="button">{busy ? t("home.submitting") : t("home.continueImproving")}</button>
        <button className="button quiet" disabled={busy} onClick={() => void resolve({ actionChoice: "ACCEPT_CURRENT" })} type="button">{t("home.keepCurrentResult")}</button>
      </span>
    </div> : needsWaitingRecovery ? <div className="joi-clarify-workspace">
      <div><strong>{t("home.resumeOriginalWork")}</strong><span>{t("home.joiResumesTheSavedWorkAndPartnerSessionWithout")}</span></div>
      <button className="button primary" disabled={busy} onClick={() => void resolve({ actionChoice: "RESUME" })} type="button">{busy ? t("home.resuming") : t("home.resumeOriginalWorkfa2119")}</button>
    </div> : needsWorkspace ? <div className="joi-clarify-workspace">
      <div><strong>{assignedWorkbench?.name ?? t("home.currentWorkbench")}</strong><span>{t("home.onlyASafeWorkspaceIdentifierIsSavedAbsolutePaths")}</span></div>
      <button className="button primary" disabled={busy || workbenchId === undefined} onClick={() => void chooseWorkspace()} type="button">{busy ? t("home.selecting") : t("home.chooseWorkingDirectory")}</button>
    </div> : needsWorkbenchChoice ? null : <div className="joi-clarify-add">
      <ClarifyTextarea aria-label={isQuestion ? t("home.yourAnswer") : t("home.additionalInformation")} disabled={busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && draft.trim() !== "") { event.preventDefault(); submitDraft(); } }} placeholder={isQuestion ? t("home.answerAndJoiWillContinueTheTaskShiftEnter") : t("home.addDetailsSoJoiCanContinueShiftEnterFor")} value={draft} />
      <button className="button quiet" disabled={busy || draft.trim() === ""} onClick={submitDraft} type="button">{isQuestion ? t("home.answerAndContinue") : t("home.addDetailsAndContinue")}</button>
    </div>}
    {notice === null ? null : <p className="inline-notice info" role="status">{notice}</p>}
  </div>;
}

function CancelInputButton({ api, inputId, onCanceled }: { api: DigitalLifeApi; inputId: string; onCanceled: () => void }) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useNotice();
  const cancel = async () => {
    setBusy(true); setError(null);
    try {
      await api.cancelJoiMessage(inputId);
      onCanceled();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.displayMessage : noticeMessage("home.couldNotCancelThisTaskTryAgain"));
    } finally {
      setBusy(false);
    }
  };
  return <span className="joi-feed-cancel-wrap"><button aria-label={t("home.cancelThisTask")} className="button quiet joi-feed-cancel" disabled={busy} onClick={() => void cancel()} type="button">{busy ? t("home.canceling") : t("common.cancel")}</button>{error === null ? null : <span className="joi-feed-cancel-error" role="status">{error}</span>}</span>;
}

function ComposerWorkbenchPicker({ workbenches, onSelect, selected }: {
  workbenches: WorkbenchDto[];
  onSelect: (workbenchId: string | null) => void;
  selected: WorkbenchDto | undefined;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const showSearch = workbenches.length > 6;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleWorkbenches = !showSearch || normalizedQuery === ""
    ? workbenches
    : workbenches.filter((workbench) => `${workbench.name} ${workbench.scopeSummary}`.toLowerCase().includes(normalizedQuery));
  const toggle = () => setOpen((current) => {
    if (current) setQuery("");
    return !current;
  });
  const choose = (workbenchId: string | null) => { onSelect(workbenchId); setQuery(""); setOpen(false); };
  return <div className="joi-workbench-picker">
    <button aria-expanded={open} aria-haspopup="dialog" className="joi-workbench-button" onClick={toggle} type="button">
      {selected === undefined ? t("home.letJoiDecide") : t("home.assignToValue", { p0: selected.name })}
    </button>
    {open ? <div aria-label={t("home.chooseWorkbench")} className="joi-workbench-menu" role="dialog">
      {showSearch ? <label className="joi-workbench-search">{t("home.searchWorkbenches")}<input aria-label={t("home.searchWorkbenches")} onChange={(event) => setQuery(event.target.value)} placeholder={t("home.searchByNameOrScope")} type="search" value={query} /></label> : null}
      <div aria-label={t("home.workbenchList")} className="joi-workbench-options" role="group">
        {visibleWorkbenches.length === 0 ? <small className="joi-workbench-empty">{t("home.noMatchingWorkbenchesTryADifferentKeyword")}</small> : visibleWorkbenches.map((workbench) => <button aria-label={workbench.name} className="button ghost" key={workbench.workbenchId} onClick={() => choose(workbench.workbenchId)} type="button">{workbench.name}</button>)}
      </div>
    </div> : null}
  </div>;
}


function goalStatusLabel(status: JoiGoalCardDto["status"]): string {
  if (status === "ARRANGING") return t("home.planning");
  if (status === "ARRANGED") return t("home.queued");
  if (status === "RUNNING") return t("home.executing");
  if (status === "REVIEWING") return t("home.reviewing");
  if (status === "EXTENDING") return t("home.extendingAfterReview");
  if (status === "NEEDS_ATTENTION") return t("home.needsYou");
  if (status === "FINALIZING") return t("home.summarizing");
  if (status === "COMPLETED") return t("status.completed");
  if (status === "COMPLETED_WITH_GAPS") return t("home.completedWithGaps");
  if (status === "FAILED") return t("home.failed763284");
  return t("status.canceled");
}

function agentExecutionLabel(agent: Pick<WorkbenchAgentCardDto, "executionPhase" | "waitReason" | "resultAssessment"> & { status: string }): string {
  if (agent.status === "FAILED" && agent.resultAssessment === "INSUFFICIENT") return t("home.insufficient");
  if (agent.waitReason === "CAPACITY") return t("home.waitingForExecutionCapacity");
  if (agent.executionPhase === "READ_QUEUED") return t("home.waitingForWorkspaceReadAccess");
  if (agent.executionPhase === "WRITE_QUEUED") return t("home.waitingToWrite");
  if (agent.executionPhase === "READ_RUNNING") return t("home.analyzing");
  if (agent.executionPhase === "WRITE_RUNNING") return t("home.writing");
  return agent.status;
}

function recentOutcomeLabel(status: WorkbenchDetailDto["recentOutcomes"][number]["status"]): string {
  if (status === "COMPLETED_WITH_GAPS") return t("home.completedWithGaps");
  if (status === "FAILED") return t("home.failed763284");
  if (status === "CANCELED") return t("status.canceled");
  return t("status.completed");
}

const ACTIVE_GOAL_STATUSES: ReadonlySet<JoiGoalCardDto["status"]> = new Set(["ARRANGING", "ARRANGED", "RUNNING", "REVIEWING", "EXTENDING", "FINALIZING"]);

function GoalStatusBadge({ status }: { status: JoiGoalCardDto["status"] }) {
  useI18n();
  return <span className={`joi-goal-status ${status.toLowerCase()}`}>{ACTIVE_GOAL_STATUSES.has(status) ? <i aria-hidden="true" className="joi-goal-status-dot" /> : null}{goalStatusLabel(status)}</span>;
}

function GoalProgress({ goal }: { goal: JoiGoalCardDto }) {
  useI18n();
  // A Work that ended is finished whether or not it produced what was asked, so a failure has to
  // move the bar too. Counting completions alone leaves a goal that is already over displayed at a
  // partial percentage, which reads as work still owed.
  const settled = goal.work.completed + goal.work.failed;
  const percent = goal.status === "COMPLETED" || goal.status === "COMPLETED_WITH_GAPS"
    ? 100
    : goal.work.total === 0 ? 0 : Math.round((settled / goal.work.total) * 100);
  // A count of "6/11" hides what the other five are: the reader cannot tell a running Work from a
  // failed one, or a failure that a replacement already answered from one that is still open.
  const parts: string[] = [`${String(goal.agentCount)} Agent`];
  const resolvedFailures = goal.work.failedResolved ?? 0;
  if (goal.work.completed > 0) parts.push(t("home.valueWorkCompleted", { p0: String(goal.work.completed) }));
  if (goal.work.failed > 0) {
    parts.push(resolvedFailures > 0
      ? t("home.valueFailedValueResolved", { p0: String(goal.work.failed), p1: String(resolvedFailures) })
      : t("home.valueFailed", { p0: String(goal.work.failed) }));
  }
  if (goal.work.executing !== undefined || goal.work.resourceWaiting !== undefined) {
    if ((goal.work.executing ?? 0) > 0) parts.push(t("home.valueExecuting", { p0: String(goal.work.executing) }));
    if ((goal.work.resourceWaiting ?? 0) > 0) parts.push(t("home.valueWaiting", { p0: String(goal.work.resourceWaiting) }));
    for (const reason of goal.work.waitingReasons ?? []) {
      parts.push(reason === "CAPACITY" ? t("home.waitingForExecutionCapacity") : reason === "WORKSPACE_READ" ? t("home.waitingForWorkspaceReadAccess") : t("home.waitingToWrite"));
    }
  } else if (goal.work.active > 0) parts.push(t("home.valueInProgress", { p0: String(goal.work.active) }));
  return <span className="joi-goal-progress">
    <span aria-hidden="true" className="joi-goal-progress-track"><i style={{ width: `${String(percent)}%` }} /></span>
    <i>{parts.join(" · ")}</i>
  </span>;
}

/**
 * A card's clickable head.
 *
 * `compact` is the archived shape: a goal that has been filed away is not mid-flight any more, so the
 * progress bar and the Work counts say nothing and give way to the one fact that does — when it was
 * filed. The full result is still one click in, at the drawer.
 */
function GoalCardHead({ goal, onOpen, compact = false }: { goal: JoiGoalCardDto; onOpen: () => void; compact?: boolean }) {
  useI18n();
  const projectLabel = goal.workbench.projectLabel?.trim() ?? "";
  const label = projectLabel.length === 0 ? goal.workbench.name : projectLabel;
  const han = label.match(/\p{Script=Han}/gu);
  const monogram = (han ?? label.match(/[\p{L}\p{N}]/gu))?.slice(0, han === null ? 4 : 2).join("") ?? "joi";
  return <button className="joi-goal-open" disabled={goal.workbench.workbenchId === ""} onClick={onOpen} type="button"><span aria-hidden="true" className={`workbench-orb${han === null ? " monogram-latin" : ""}`}>{monogram}</span><span className="joi-goal-copy"><small>{goal.workbench.name}</small><strong className="joi-goal-title">{goal.title}</strong>{compact ? (goal.archivedAt === undefined ? null : <i>{t("home.valueArchived", { p0: new Date(goal.archivedAt).toLocaleString(currentLocale()) })}</i>) : <GoalProgress goal={goal} />}</span></button>;
}

function GoalResultPreview({ goal, onOpen }: { goal: JoiGoalCardDto; onOpen: () => void }) {
  useI18n();
  if (goal.completionSummary === undefined || goal.clarification?.reasonCode === "goal_continuation_required") return null;
  return <div aria-haspopup="dialog" aria-label={t("home.openTheFullFinalResultForValue", { p0: goal.title })} data-full-text-label={t("home.viewTheFullCurrentResult")} className="joi-goal-result-preview joi-md" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}><div className="joi-goal-result-copy"><Markdown>{goal.completionSummary}</Markdown></div><span aria-hidden="true" className="joi-goal-result-link">{t("home.viewTheFullCurrentResult")}<ArrowUpRightIcon /></span></div>;
}

/** Terminal and archived facts determine the actions behind each card's single menu. */
function GoalActionMenu({ api, goal, archived, onRetried, onDismissed, onChanged }: {
  api: DigitalLifeApi;
  goal: JoiGoalCardDto;
  archived?: boolean;
  onRetried: () => void;
  onDismissed: () => void;
  onChanged: () => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useNotice();
  const wrapper = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || menu.current === null || wrapper.current?.closest(".joi-home-c2") === null) return;
    const trigger = wrapper.current?.querySelector("button");
    if (trigger === null || trigger === undefined) return;
    const anchor = trigger.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    const top = anchor.bottom + 6 + bounds.height <= window.innerHeight - 12 ? anchor.bottom + 6 : anchor.top - 6 - bounds.height;
    Object.assign(menu.current.style, {
      position: "fixed", right: "auto", left: `${String(Math.max(12, Math.min(anchor.right - bounds.width, document.documentElement.clientWidth - bounds.width - 12)))}px`,
      top: `${String(Math.max(12, top))}px`, maxHeight: "calc(100dvh - 24px)", overflowY: "auto",
    });
  }, [open, error]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (wrapper.current?.contains(event.target as Node) !== true) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); wrapper.current?.querySelector("button")?.focus(); } };
    const closeOnScroll = (event: Event) => { if (menu.current?.contains(event.target as Node) !== true) setOpen(false); };
    const closeOnResize = () => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", closeOnResize);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); document.removeEventListener("scroll", closeOnScroll, true); window.removeEventListener("resize", closeOnResize); };
  }, [open]);
  const run = async (operation: Promise<unknown>, done: () => void, failure: string) => {
    setBusy(true); setError(null);
    try { await operation; setOpen(false); done(); }
    catch (reason) { setError(reason instanceof ApiError ? reason.displayMessage : failure); }
    finally { setBusy(false); }
  };
  const terminal = TERMINAL_GOAL_STATUSES.includes(goal.status);
  const item = (label: string, onClick: () => void, danger = false) => <button
    className={danger ? "danger" : undefined}
    disabled={busy}
    key={label}
    onClick={onClick}
    role="menuitem"
    type="button">{label}</button>;
  const items = [
    terminal ? item(t("common.continue"), () => { setOpen(false); onRetried(); }) : null,
    archived === true
      ? item(t("common.unarchive"), () => void run(api.unarchiveJoiMessage(goal.goalId), onChanged, t("home.couldNotUnarchiveTryAgain")))
      : goal.canArchive === true ? item(t("common.archive"), () => void run(api.archiveJoiMessage(goal.goalId), onChanged, t("home.couldNotArchiveThisCardTryAgain"))) : null,
    terminal ? null : item(t("home.cancelTask"), () => void run(api.cancelJoiMessage(goal.goalId), onChanged, t("home.couldNotCancelThisTaskTryAgain"))),
    goal.canDelete ? item(t("home.remove2f752c"), () => void run(api.dismissJoiMessage(goal.goalId), onDismissed, t("home.couldNotRemoveThisCardTryAgain")), true) : null,
  ].filter((entry) => entry !== null);
  return <div className="joi-goal-menu" onClick={(event) => event.stopPropagation()} ref={wrapper}>
    <button aria-expanded={open} aria-haspopup="menu" aria-label={t("home.moreActionsForValue", { p0: goal.title })} className="icon-button joi-goal-menu-trigger" disabled={busy} onClick={() => setOpen((current) => !current)} type="button"><DotsThreeIcon aria-hidden weight="bold" /></button>
    {open ? <div aria-label={t("home.valueActions", { p0: goal.title })} className="joi-goal-menu-list" ref={menu} role="menu">
      {items}
      {/* A refusal keeps the menu open so the action can be retried without reopening; the reason
          belongs next to the item that was refused rather than at the card. */}
      {error === null ? null : <span className="joi-goal-menu-error" role="status">{error}</span>}
    </div> : null}
  </div>;
}

function GoalAgentWarning({ goal, onOpen }: { goal: JoiGoalCardDto; onOpen: () => void }) {
  useI18n();
  if ((goal.status !== "COMPLETED" && goal.status !== "COMPLETED_WITH_GAPS") || goal.work.failed === 0) return null;
  return <button
    aria-label={t("home.viewValuePartnerIssues", { p0: String(goal.work.failed) })}
    className="joi-goal-agent-warning"
    onClick={onOpen}
    type="button">
    {String(goal.work.failed)}  {t("home.partnerIssuesViewDetails")}</button>;
}

function GoalFailureNotice({ failure }: { failure: NonNullable<JoiGoalCardDto["failure"]> }) {
  useI18n();
  const action = failure.suggestedAction === "RESTART_OR_UPDATE"
    ? t("home.thisIsAnInternalJoiConfigurationIssueRestartOr")
    : failure.suggestedAction === "CHECK_MODEL_SOURCE"
      ? t("home.checkThePrimaryModelConnectionCredentialsAndAvailabilityIn")
      : t("home.submitAgainIfItFailsAgainExportDiagnosticsTo");
  return <section className="joi-goal-failure" role="alert">
    <strong>{t("home.joiHasStoppedRetrying")}</strong>
    <p>{t("home.automaticAttempts")} {String(failure.attempts)}  {t("home.retriesHaveNowStopped")}{failure.executionStarted ? t("home.executionHasStartedAndSomeWorkMayAlreadyHave") : t("home.noAgentsHaveStartedAndNoWorkHasBeen")}</p>
    <p>{action}</p>
    <small>{t("home.diagnosticCode")}{failure.reasonCode}</small>
  </section>;
}

const TERMINAL_GOAL_STATUSES: readonly JoiGoalCardDto["status"][] = ["CANCELED", "COMPLETED", "COMPLETED_WITH_GAPS", "FAILED"];

function goalRetryHint(status: JoiGoalCardDto["status"]): string {
  if (status === "FAILED") return t("home.continueThisTaskOnceTheIssueIsResolvedAdd");
  if (status === "CANCELED") return t("home.thisTaskWasCanceledContinueFromTheOriginalGoal");
  return t("home.thisGoalHasFinishedAddFollowUpRequirementsTo");
}

function GoalRetryPanel({ api, goal, onDone }: {
  api: DigitalLifeApi;
  goal: JoiGoalCardDto;
  onDone: (accepted: JoiAcceptedMessageDto) => void;
}) {
  useI18n();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNotice();
  const [feedback, setFeedback] = useNotice();
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  if (!TERMINAL_GOAL_STATUSES.includes(goal.status)) return null;
  const submit = () => {
    if (busy) return;
    setBusy(true); setNotice(null);
    const text = draft.trim();
    void api.retryJoiMessage(goal.goalId, { ...(text === "" ? {} : { text }) })
      .then((accepted) => onDone(accepted))
      .catch((reason: unknown) => setNotice(reason instanceof ApiError ? reason.displayMessage : noticeMessage("home.couldNotContinueThisGoalTryAgain")))
      .finally(() => setBusy(false));
  };
  const sendNegativeFeedback = () => {
    if (feedbackBusy) return;
    setFeedbackBusy(true); setFeedback(null);
    void api.evolutionNegativeFeedback(goal.workbench.workbenchId, goal.goalId)
      .then((status) => setFeedback(status.reason === "rolled_back"
        ? noticeMessage("home.policyRolledBackAndAutomaticEvolutionPausedRunningGoals")
        : noticeMessage("home.feedbackRecordedThisGoalDidNotUseTheCurrent")))
      .catch((reason: unknown) => setFeedback(reason instanceof ApiError && reason.code === "evolution_goal_invalid"
        ? noticeMessage("home.thisGoalHasNoEvolutionPolicyToGiveFeedback")
        : noticeMessage("home.couldNotSubmitPolicyFeedbackTryAgain")))
      .finally(() => setFeedbackBusy(false));
  };
  return <div className="joi-goal-retry joi-clarify">
    <p className="joi-clarify-reason">{goalRetryHint(goal.status)}</p>
    {busy ? <div aria-label={t("home.submittingContinuationRequest")} className="joi-retry-submitting" role="status">
      <span aria-hidden="true" className="joi-thinking-dot" />
      <span><strong>{t("home.submittingContinuationRequest")}</strong><small>{t("home.onceJoiConfirmsReceiptTheTaskMovesToPlanning")}</small></span>
    </div> : null}
    <div className="joi-clarify-add">
      <ClarifyTextarea aria-label={t("home.additionalNotes")} disabled={busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={t("home.addRequirementsLeaveBlankToContinueShiftEnterFor")} value={draft} />
      <button className="button quiet" disabled={busy} onClick={submit} type="button">{busy ? t("home.sendingToJoi") : t("common.continue")}</button>
    </div>
    {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
    <div className="joi-goal-feedback">
      <button className="button ghost" disabled={feedbackBusy} onClick={sendNegativeFeedback} title={t("home.reportAPoorResultToTheEvolutionPolicyThat")} type="button">{feedbackBusy ? t("home.submittingFeedback") : t("home.reportUnhelpfulPolicy")}</button>
      {feedback === null ? null : <p className="field-hint" role="status">{feedback}</p>}
    </div>
  </div>;
}

function optimisticRetryFeed(feed: JoiHomeFeedDto, goal: JoiGoalCardDto): JoiHomeFeedDto {
  const startedAt = new Date().toISOString();
  const nextGoal: JoiGoalCardDto = {
    agentCount: 0,
    canDelete: false,
    goalId: goal.goalId,
    ...(goal.harness === undefined ? {} : { harness: goal.harness }),
    status: "ARRANGING",
    title: goal.title,
    updatedAt: startedAt,
    work: { active: 0, completed: 0, failed: 0, total: 0 },
    workbench: goal.workbench,
  };
  return {
    ...feed,
    goals: feed.goals.map((item) => item.goalId === goal.goalId ? nextGoal : item),
    thinking: [{
      agentCount: 0,
      goalId: goal.goalId,
      phase: "queued",
      stage: "ROUTING",
      startedAt,
      turnId: `pending:${goal.goalId}`,
      work: { active: 0, completed: 0, failed: 0, total: 0 },
    }, ...feed.thinking.filter((item) => item.goalId !== goal.goalId)],
  };
}

const THINKING_STAGE_LABELS: Record<JoiThinkingItemDto["stage"], string> = {
  get ROUTING() { return t("home.organizingTheTask"); },
  get PLANNING() { return t("home.breakingDownWork"); },
  get DISPATCHING() { return t("home.assigningPartners"); },
  get RUNNING() { return t("home.partnersAreWorking"); },
  get WAITING() { return t("home.waitingForAPartnerResponse"); },
  get FINALIZING() { return t("home.combiningResults"); },
  get REVIEWING() { return t("home.reviewingResults"); },
  get EXTENDING() { return t("home.extendingAfterReview"); },
};

type JoiThinkingRenderItem = Omit<JoiThinkingItemDto, "agentCount" | "stage" | "work"> & Partial<Pick<JoiThinkingItemDto, "agentCount" | "stage" | "work">>;

function thinkingStageLabel(stage: JoiThinkingRenderItem["stage"]): string {
  return stage === undefined ? t("home.organizingTheTask") : THINKING_STAGE_LABELS[stage];
}

function thinkingElapsed(startedAt: string, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  if (elapsedSeconds < 60) return t("home.valueS", { p0: String(elapsedSeconds) });
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return t("home.valueMin", { p0: String(minutes) });
  const hours = Math.floor(minutes / 60);
  return t("home.valueHValue", { p0: String(hours), p1: (minutes % 60 === 0 ? "" : t("home.valueMin863710", { p0: String(minutes % 60) })) });
}

function thinkingWorkSummary(item: JoiThinkingRenderItem): string {
  const work = item.work ?? { active: 0, completed: 0, failed: 0, total: 0 };
  const agentCount = item.agentCount ?? 0;
  const parts = [
    agentCount > 0 ? `${String(agentCount)} Agent` : null,
    work.total > 0 ? t("home.valueValueWorkCompleted", { p0: String(work.completed), p1: String(work.total) }) : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}

/**
 * The elapsed clock is owned by the row rather than the feed: a running turn ticks once a second,
 * and that repaint must stay inside this row instead of reaching the composer and every goal card.
 */
function ThinkingRow({ item }: { item: JoiThinkingItemDto }) {
  useI18n();
  const renderItem = item as JoiThinkingRenderItem;
  const isProgressing = item.phase !== "queued";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isProgressing) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [isProgressing]);
  const stageLabel = thinkingStageLabel(renderItem.stage);
  const workSummary = thinkingWorkSummary(renderItem);
  const accessibleSummary = isProgressing
    ? `${stageLabel}${workSummary === "" ? "" : `，${workSummary}`}`
    : t("home.queued");
  return <div aria-label={accessibleSummary} className={`joi-thinking ${item.phase}`} role="status">
    <span aria-hidden="true" className="joi-thinking-dot" />
    <div className="joi-thinking-copy">
      <strong className={isProgressing ? "joi-thinking-stage" : undefined}>{isProgressing ? stageLabel : t("home.queued")}</strong>
      {isProgressing ? <span className="joi-thinking-summary">
        {workSummary === "" ? null : <span className="joi-thinking-meta">{workSummary}</span>}
        <span aria-hidden="true" className="joi-thinking-elapsed">  {t("home.used")} {thinkingElapsed(item.startedAt, now)}</span>
      </span> : null}
    </div>
  </div>;
}

function GoalDetail({ api, partners, workbenches, goal, initialAgentStatus, onBack, onResolved, onRetried, onScheduleGoal }: {
  api: DigitalLifeApi;
  partners: PartnerDto[];
  workbenches: WorkbenchDto[];
  goal: JoiGoalCardDto;
  initialAgentStatus?: WorkbenchAgentStatusDto;
  onScheduleGoal?: (goalId: string) => void;
  onBack: () => void;
  onResolved: () => void;
  onRetried: (goal: JoiGoalCardDto) => void;
}) {
  useI18n();
  const detailState = useGoalDetail(api, goal.goalId);
  const [agents, setAgents] = useState<WorkbenchAgentCardDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [notice, setNotice] = useNotice();
  const loadAgents = useCallback(async () => {
    try {
      const page = await api.listWorkbenchAgents(goal.workbench.workbenchId, { goalId: goal.goalId, limit: 100 });
      const items = Array.isArray(page.items) ? page.items : [];
      setAgents(items);
      setNotice(null);
      setSelectedAgentId((current) => current !== null && items.some((agent) => agent.agentId === current)
        ? current
        : (items.find((agent) => agent.status === initialAgentStatus)?.agentId ?? items[0]?.agentId ?? null));
    } catch {
      setNotice(noticeMessage("home.couldNotLoadAgentsForThisGoal"));
    }
  }, [api, goal.workbench.workbenchId, goal.goalId, setNotice, initialAgentStatus]);
  useEffect(() => {
    const initial = setTimeout(() => void loadAgents(), 0);
    const interval = setInterval(() => void loadAgents().catch(() => undefined), 1_500);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [loadAgents]);
  const selectedAgent = agents.find((agent) => agent.agentId === selectedAgentId);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onBack(); };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; };
  }, [onBack]);
  return <div className="joi-drawer-backdrop" onClick={onBack} role="presentation">
    <section aria-label={t("home.goalDetailsForValue", { p0: goal.workbench.name })} aria-modal="true" className="joi-goal-drawer" onClick={(event) => event.stopPropagation()} role="dialog">
      <header className="joi-goal-detail-header">
        <div className="joi-goal-detail-title">
          <p className="eyebrow">{goal.workbench.name}</p>
          <GoalTitle title={goal.title} {...(detailState.detail === undefined ? {} : { fullTitle: detailState.detail.fullTitle })} />
          <span className="joi-goal-detail-meta"><GoalStatusBadge status={goal.status} /><GoalProgress goal={goal} /></span>
        </div>
        <div className="joi-goal-detail-actions">
          <button aria-label={t("common.close")} className="icon-button joi-goal-detail-close" onClick={onBack} title={t("common.close")} type="button"><XIcon aria-hidden size={18} /></button>
          {onScheduleGoal === undefined ? null : <button className="button joi-goal-schedule" onClick={() => onScheduleGoal(goal.goalId)} title={t("home.scheduleContinuationForThisGoal")} type="button"><ClockIcon aria-hidden size={16} /><span>{t("home.schedule")}</span></button>}
        </div>
      </header>
      <div className="joi-goal-drawer-body">
        {detailState.detail?.harness !== undefined ? <GoalMap harness={detailState.detail.harness} hasMore={detailState.detail.nextOffset !== undefined} busy={detailState.busy} failed={detailState.failed} onLoadMore={detailState.loadMore} onRetry={detailState.retry} /> : goal.harness === undefined ? null : <article className="joi-route-map" aria-busy={!detailState.failed}>
          <div className="joi-route-map-heading"><h2>{t("home.goalRouteMap")}</h2></div>
          <div className="joi-route-destination compact"><p>{goal.harness.destination ?? t("home.unnamedDestinationJoiWillNameItDuringReview")}</p></div>
          <p className="joi-route-counts">{t("home.routeLoading")}</p>
        </article>}
        {detailState.failed && detailState.detail?.harness === undefined ? <p className="joi-detail-load-notice" role="alert">{t("home.goalDetailLoadFailed")} <button className="button ghost" disabled={detailState.busy} onClick={detailState.retry} type="button">{t("common.retry")}</button></p> : null}
        {goal.failure === undefined ? null : <GoalFailureNotice failure={goal.failure} />}
        {goal.completionSummary === undefined ? null : goal.clarification?.reasonCode === "goal_continuation_required" ? <GoalArtifacts api={api} goal={goal} /> : <article className="joi-goal-result"><h2>{t("home.finalResult")}</h2><div className="joi-md"><Markdown>{goal.completionSummary}</Markdown></div><GoalArtifacts api={api} goal={goal} /></article>}
        <GoalAgentWarning goal={goal} onOpen={() => setSelectedAgentId(agents.find((agent) => agent.status === "FAILED")?.agentId ?? null)} />
        {goal.clarification === undefined ? null : <ClarificationActions api={api} partners={partners} workbenchId={goal.workbench.workbenchId} workbenches={workbenches} inputId={goal.goalId} onResolved={onResolved} prompt={goal.clarification.prompt} questionId={goal.clarification.questionId} questionVersion={goal.clarification.questionVersion} reasonCode={goal.clarification.reasonCode} suggestionSeed={goal.title} continuationSummary={goal.completionSummary} />}
        {TERMINAL_GOAL_STATUSES.includes(goal.status) ? <GoalRetryPanel api={api} goal={goal} onDone={() => onRetried(goal)} /> : null}
        {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
        <div className="joi-goal-detail-body">
          <aside aria-label={t("home.agentsForThisGoal")} className="joi-goal-agents">
            {agents.length === 0 ? <p className="plain-empty">{t("home.joiHasNotStartedAnyAgentsForThisGoal")}</p> : agents.map((agent) => <button aria-pressed={agent.agentId === selectedAgentId} className={`joi-goal-agent ${agent.agentId === selectedAgentId ? "selected" : ""}`} key={agent.agentId} onClick={() => setSelectedAgentId(agent.agentId)} type="button">
              <span className="agent-workbench">{agent.partnerName.slice(0, 1)}</span>
              <span className="joi-goal-agent-copy"><strong>{agent.partnerName}</strong><small>{agent.transport} · {agent.engine}</small></span>
              <i className={`agent-status ${(agent.resultAssessment === "INSUFFICIENT" && agent.status === "FAILED" ? "insufficient" : agent.status.toLowerCase())}`}>{agentExecutionLabel(agent)}</i>
            </button>)}
          </aside>
          <div className="joi-goal-stream">
            {selectedAgent === undefined
              ? <p className="content-state">{t("home.agentActivityAndResultsAppearHereOnceAnAgent")}</p>
              : <AgentMessageStream agent={selectedAgent} api={api} workbenchId={goal.workbench.workbenchId} goalId={goal.goalId} key={`${goal.goalId}:${selectedAgent.agentId}`} live={selectedAgent.status === "RUNNING" || selectedAgent.status === "WAITING"} />}
          </div>
        </div>
      </div>
    </section>
  </div>;
}

function GoalResultView({ api, goal, onBack, onOpenDetail, onRetried }: {
  api: DigitalLifeApi;
  goal: JoiGoalCardDto;
  onBack: () => void;
  onOpenDetail: (preferredStatus?: WorkbenchAgentStatusDto) => void;
  onRetried: (goal: JoiGoalCardDto) => void;
}) {
  useI18n();
  const [body] = useState(goal.completionSummary ?? "");
  const resultLabel = !TERMINAL_GOAL_STATUSES.includes(goal.status) ? t("home.currentResult") : t("home.finalResult");
  const [exportMenu, setExportMenu] = useState(false);
  const close = () => { if (exportMenu) setExportMenu(false); else onBack(); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { if (exportMenu) setExportMenu(false); else onBack(); } };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; };
  }, [onBack, exportMenu]);
  return <div className="joi-drawer-backdrop" onClick={close} role="presentation">
    <section aria-label={t("home.valueForValue", { p0: goal.workbench.name, p1: resultLabel })} aria-modal="true" className="joi-goal-drawer joi-result-drawer" onClick={(event) => { event.stopPropagation(); setExportMenu(false); }} role="dialog">
      <header className="joi-goal-detail-header">
        <div className="joi-goal-detail-title">
          <p className="eyebrow">{goal.workbench.name}</p>
          <h1>{goal.title}</h1>
          <span className="joi-goal-detail-meta"><GoalStatusBadge status={goal.status} />{goal.completedAt === undefined ? null : <time className="joi-feed-time">{new Date(goal.completedAt).toLocaleString(currentLocale())}</time>}</span>
        </div>
        <div className="row-actions"><button className="button ghost" disabled={goal.workbench.workbenchId === ""} onClick={() => onOpenDetail()} type="button">{t("home.viewDetails")}</button><button className="button quiet" onClick={close} type="button">{t("common.close")}</button></div>
      </header>
      <div className="joi-goal-drawer-body">
        <article className="joi-goal-result"><h2>{resultLabel}</h2><div className="joi-md"><Markdown>{body}</Markdown></div><GoalArtifacts api={api} goal={goal} /></article>
        <GoalAgentWarning goal={goal} onOpen={() => onOpenDetail("FAILED")} />
        {TERMINAL_GOAL_STATUSES.includes(goal.status) ? <GoalRetryPanel api={api} goal={goal} onDone={() => onRetried(goal)} /> : null}
      </div>
      <ResultExportMenu api={api} goalId={goal.goalId} body={body} expanded={exportMenu} onExpanded={setExportMenu} />
    </section>
  </div>;
}

const JOI_MAX_ATTACHMENTS = 8;
const JOI_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// A pasted Codux clipboard image arrives as a plain text path, not a file.
// Recognize absolute image-file paths so the composer can import them as
// attachments instead of leaving the model a string it cannot act on.
const JOI_IMAGE_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/][^\n]*|\\\\[^\n]*|\/[^\n]*)\.(?:bmp|gif|jpe?g|png|webp)$/i;
function joiImagePathFromText(value: string): string | null {
  const candidate = value.trim().replace(/^['"]+|['"]+$/g, "").trim();
  return JOI_IMAGE_PATH_PATTERN.test(candidate) ? candidate : null;
}

const THINKING_EXPIRY_TICK_MILLIS = 5_000;
const ACTIVE_FEED_REFRESH_MILLIS = 1_500;
const IDLE_FEED_REFRESH_MILLIS = 7_500;

function JoiComposer({ api, focusGoalId, onNavigate, onScheduleGoal, snapshot }: {
  api: DigitalLifeApi;
  focusGoalId?: string;
  onNavigate?: (section: "agents" | "joi", tab?: "partners" | "scenarios") => void;
  onScheduleGoal?: (goalId: string) => void;
  snapshot: JoiSnapshotDto;
}) {
  useI18n();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [imported, setImported] = useState<JoiAttachmentDto[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [targetWorkbenchId, setTargetWorkbenchId] = useState<string | null>(null);
  const targetWorkbench = snapshot.workbenches.find((workbench) => workbench.workbenchId === targetWorkbenchId);
  const [feed, setFeed] = useState<JoiHomeFeedDto>({ goals: [], thinking: [], unassignedActions: [] });
  const [feedError, setFeedError] = useState(false);
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [openGoalId, setOpenGoalId] = useState<string | null>(focusGoalId ?? null);
  const [workbenchChoiceId, setWorkbenchChoiceId] = useState<string | null>(null);
  const shownWorkbenchQuestions = useRef(new Set<string>());
  const [openGoalAgentStatus, setOpenGoalAgentStatus] = useState<WorkbenchAgentStatusDto | undefined>(undefined);
  const [resultGoalId, setResultGoalId] = useState<string | null>(null);
  const resultGoal = feed.goals.find((goal) => goal.goalId === resultGoalId);
  const [retryGoalId, setRetryGoalId] = useState<string | null>(null);
  const [expiryTick, setExpiryTick] = useState(() => Date.now());
  const [workbenchChanges, setWorkbenchChanges] = useState(snapshot.workbenchChanges);
  const [error, setError] = useNotice();
  const feedRevisionRef = useRef(0);
  const feedInFlightRef = useRef<{ promise: Promise<void>; revision: number } | null>(null);
  const feedNeedsFastRefreshRef = useRef(false);
  const loadFeed = useCallback(async (revision = feedRevisionRef.current) => {
    const existing = feedInFlightRef.current;
    if (existing !== null) {
      await existing.promise;
      if (existing.revision === revision || revision !== feedRevisionRef.current) return;
    }
    const request = (async () => {
    try {
      const loaded = await api.joiHomeFeed();
      if (!Array.isArray(loaded.goals) || !Array.isArray(loaded.thinking) || !Array.isArray(loaded.unassignedActions)) throw new Error("joi_home_feed_invalid");
      if (revision !== feedRevisionRef.current) return;
      feedNeedsFastRefreshRef.current = loaded.thinking.some((item) => item.phase === "queued" || item.phase === "progressing")
        || loaded.goals.some((goal) => !TERMINAL_GOAL_STATUSES.includes(goal.status));
      setFeed(loaded);
      setResultGoalId((current) => current !== null && !loaded.goals.some((goal) => goal.goalId === current) ? null : current);
      setRetryGoalId((current) => current !== null && !loaded.goals.some((goal) =>
        goal.goalId === current && TERMINAL_GOAL_STATUSES.includes(goal.status)) ? null : current);
      setWorkbenchChanges(loaded.workbenchChanges ?? []);
      setFeedLoaded(true);
      setFeedError(false);
    } catch {
      if (revision !== feedRevisionRef.current) return;
      // Inbox routing/consumption is not execution/completion evidence.
      // Keep the last authoritative projection until this endpoint recovers.
      setFeedError(true);
    }
    })();
    feedInFlightRef.current = { promise: request, revision };
    await request.finally(() => {
      if (feedInFlightRef.current?.promise === request) feedInFlightRef.current = null;
    });
  }, [api]);
  // The feed already carries the pending workbench changes, so one poll covers both. The separate
  // snapshot call this replaced ran six queries per poll and only its workbenchChanges survived.
  const refresh = useCallback(async () => { await loadFeed(); }, [loadFeed]);
  const refreshAfterMutation = useCallback(async () => {
    feedRevisionRef.current += 1;
    await loadFeed();
  }, [loadFeed]);
  useEffect(() => {
    let stopped = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (stopped || document.visibilityState === "hidden") return;
      timer = setTimeout(run, feedNeedsFastRefreshRef.current ? ACTIVE_FEED_REFRESH_MILLIS : IDLE_FEED_REFRESH_MILLIS);
    };
    const run = () => {
      if (stopped || polling || document.visibilityState === "hidden") return;
      polling = true;
      void refresh().finally(() => {
        polling = false;
        schedule();
      });
    };
    const onVisibilityChange = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (document.visibilityState !== "hidden") run();
    };
    const initial = setTimeout(run, 0);
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Only decided when an already-settled row should stop showing; per-second precision is not
    // needed here, and a coarser tick keeps this repaint off the second-by-second path.
    const expiryClock = setInterval(() => setExpiryTick(Date.now()), THINKING_EXPIRY_TICK_MILLIS);
    return () => {
      stopped = true;
      clearTimeout(initial);
      if (timer !== null) clearTimeout(timer);
      clearInterval(expiryClock);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);
  const addFiles = (incoming: Iterable<File>) => {
    const oversized: string[] = [];
    const accepted: File[] = [];
    let dropped = 0;
    for (const file of incoming) {
      if (file.size > JOI_MAX_ATTACHMENT_BYTES) {
        oversized.push(file.name);
        continue;
      }
      if (files.length + imported.length + accepted.length >= JOI_MAX_ATTACHMENTS) {
        dropped += 1;
        continue;
      }
      if ([...files, ...accepted].some((existing) => existing.name === file.name && existing.size === file.size)) continue;
      accepted.push(file);
    }
    if (accepted.length > 0) setFiles([...files, ...accepted]);
    const notices: string[] = [];
    if (oversized.length > 0) notices.push(t("home.valueExceeds10MibAndWasNotAttached", { p0: oversized.join("」「") }));
    if (dropped > 0) notices.push(t("home.upToValueAttachmentsAreAllowedExtraFilesWere", { p0: String(JOI_MAX_ATTACHMENTS) }));
    setError(notices.length === 0 ? null : notices.join(" "));
  };
  const importImagePath = (imagePath: string) => {
    if (files.length + imported.length >= JOI_MAX_ATTACHMENTS) {
      setError(noticeMessage("home.upToValueAttachmentsAreAllowed", { p0: String(JOI_MAX_ATTACHMENTS) }));
      return;
    }
    api.importJoiAttachment(imagePath)
      .then((attachment) => {
        setImported((current) => current.some((item) => item.attachmentId === attachment.attachmentId) ? current : [...current, attachment]);
        setError(null);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof ApiError ? reason.displayMessage : noticeMessage("home.couldNotAttachTheImagePathPasteTheImage"));
        setText((current) => current === "" ? imagePath : `${current}\n${imagePath}`);
      });
  };
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = text.trim();
    if (message === "") return;
    setText(""); setError(null);
    try {
      const uploaded = await Promise.all(files.map((file) => api.uploadJoiAttachment(file)));
      const attachmentIds = [...imported.map((item) => item.attachmentId), ...uploaded.map((item) => item.attachmentId)];
      const saved = await api.sendJoiMessage(message, {
        ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
        ...(targetWorkbench === undefined ? {} : { workbenchId: targetWorkbench.workbenchId }),
      });
      setTargetWorkbenchId(null);
      setFiles([]);
      setImported([]);
      setFeed((current) => ({ ...current, thinking: [{
        agentCount: 0,
        goalId: saved.inputId,
        phase: "queued",
        stage: "ROUTING",
        startedAt: saved.acceptedAt,
        turnId: `pending:${saved.inputId}`,
        work: { active: 0, completed: 0, failed: 0, total: 0 },
      }, ...current.thinking] }));
      void refresh().catch(() => undefined);
    } catch (reason) {
      setText(message);
      setError(reason instanceof ApiError ? reason.displayMessage : noticeMessage("home.yourInputCouldNotBeSavedTryAgain"));
    }
  };
  const visibleThinking = useMemo(() => feed.thinking.filter((item) => item.phase === "queued" || item.phase === "progressing" || Date.parse(item.expiresAt ?? "") > expiryTick), [feed.thinking, expiryTick]);
  // Archived cards travel in the same list (they carry `archivedAt`) and belong to the archive
  // screen. Lookups still search every goal, so focusing an archived one opens its detail.
  const visibleGoals = useMemo(() => feed.goals.filter((goal) => goal.archivedAt === undefined), [feed.goals]);
  const openGoal = feed.goals.find((goal) => goal.goalId === openGoalId);
  const pendingWorkbenchChoices = useMemo<JoiAcceptedMessageDto[]>(() => [
    ...feed.unassignedActions.filter((message) => needsWorkbenchChoice(message.clarificationReasonCode)),
    ...feed.goals.flatMap((goal): JoiAcceptedMessageDto[] => goal.status === "NEEDS_ATTENTION" && needsWorkbenchChoice(goal.clarification.reasonCode) ? [{
      inputId: goal.goalId, acceptedAt: goal.updatedAt, status: "CLARIFICATION_REQUIRED", textPreview: goal.title,
      clarificationReasonCode: goal.clarification.reasonCode,
      ...(goal.clarification.questionId === undefined ? {} : { questionId: goal.clarification.questionId }),
      ...(goal.clarification.questionVersion === undefined ? {} : { questionVersion: goal.clarification.questionVersion }),
    }] : []),
  ], [feed.unassignedActions, feed.goals]);
  const workbenchChoice = pendingWorkbenchChoices.find((message) => message.inputId === workbenchChoiceId);
  useEffect(() => {
    if (workbenchChoice !== undefined || openGoalId !== null || resultGoalId !== null || !feedLoaded || feedError) return;
    const next = pendingWorkbenchChoices.find((message) =>
      !shownWorkbenchQuestions.current.has(`${message.inputId}:${message.questionId ?? "legacy"}:${String(message.questionVersion ?? 1)}`));
    if (next === undefined) return;
    const timer = setTimeout(() => {
      shownWorkbenchQuestions.current.add(`${next.inputId}:${next.questionId ?? "legacy"}:${String(next.questionVersion ?? 1)}`);
      setWorkbenchChoiceId(next.inputId);
    }, 0);
    return () => clearTimeout(timer);
  }, [pendingWorkbenchChoices, feedLoaded, feedError, openGoalId, resultGoalId, workbenchChoice]);
  const dismissGoal = (goalId: string) => setFeed((current) => ({ ...current, goals: current.goals.filter((goal) => goal.goalId !== goalId) }));
  const dismissAction = (inputId: string) => setFeed((current) => ({ ...current, unassignedActions: current.unassignedActions.filter((item) => item.inputId !== inputId) }));
  const markRetryStarted = (goal: JoiGoalCardDto) => {
    feedRevisionRef.current += 1;
    setFeed((current) => optimisticRetryFeed(current, goal));
    void refresh().catch(() => undefined);
  };
  return <section className="joi-home joi-home-c2" aria-labelledby="joi-home-title">
    <header><h1 id="joi-home-title">{t("home.whatWouldYouLikeJoiToDo")}</h1><p>{t("home.tellJoiYourGoalItWillChooseTheWorkbench")}</p></header>
    {focusGoalId !== undefined && openGoalId === focusGoalId && feedLoaded && !feedError && openGoal === undefined ? <p className="inline-notice" role="status">{t("home.theGoalWasRemovedOrIsUnavailableHistoricalUsage")}</p> : null}
    {workbenchChoice === undefined ? null : <WorkbenchChoiceDialog api={api} key={`${workbenchChoice.inputId}:${workbenchChoice.questionId ?? "legacy"}:${String(workbenchChoice.questionVersion ?? 1)}`} message={workbenchChoice} onClose={() => setWorkbenchChoiceId(null)} onResolved={() => { dismissAction(workbenchChoice.inputId); setWorkbenchChoiceId(null); void refreshAfterMutation().catch(() => undefined); }} workbenches={snapshot.workbenches} />}
    {feedError ? <div className="inline-notice danger" role="alert"><p>{t("home.taskStatusCouldNotBeRefreshedTheLastSuccessful")}</p><button className="button quiet" onClick={() => void loadFeed()} type="button">{t("home.reloadTaskStatus")}</button></div> : null}
    {workbenchChanges.length === 0 ? null : <section className="joi-workbench-confirmations" aria-label={t("home.confirmWorkbenchChange")}><h2>{t("home.yourConfirmationIsNeeded")}</h2>{workbenchChanges.map((change) => <article key={change.requestId}>
      <div><strong>{change.kind === "MERGE" ? t("home.joiSuggestsMergingWorkbenches") : t("home.joiSuggestsArchivingAWorkbench")}</strong><span>{change.reason}</span><small>{change.kind === "MERGE" ? `${change.sourceWorkbenchId} → ${change.targetWorkbenchId ?? ""}` : change.sourceWorkbenchId}</small></div>
      <div className="row-actions"><button className="button ghost" onClick={() => void api.decideWorkbenchChange(change.requestId, "REJECT").then(refresh)} type="button">{t("home.keepAsIs")}</button><button className="button danger-text" onClick={() => void api.decideWorkbenchChange(change.requestId, "CONFIRM").then(refresh)} type="button">{change.kind === "MERGE" ? t("home.confirmMerge") : t("home.confirmArchive")}</button></div>
    </article>)}</section>}
    {openGoal === undefined ? null : <GoalDetail key={openGoal.goalId} api={api} partners={snapshot.partners} workbenches={snapshot.workbenches} goal={openGoal} {...(onScheduleGoal === undefined ? {} : { onScheduleGoal })} {...(openGoalAgentStatus === undefined ? {} : { initialAgentStatus: openGoalAgentStatus })} onBack={() => { setOpenGoalId(null); setOpenGoalAgentStatus(undefined); }} onResolved={() => void refreshAfterMutation().catch(() => undefined)} onRetried={markRetryStarted} />}
    {resultGoal === undefined ? null : <GoalResultView key={resultGoal.goalId} api={api} goal={resultGoal} onBack={() => setResultGoalId(null)} onOpenDetail={(preferredStatus) => { setResultGoalId(null); setOpenGoalAgentStatus(preferredStatus); setOpenGoalId(resultGoal.goalId); }} onRetried={(retriedGoal) => { setResultGoalId(null); markRetryStarted(retriedGoal); }} />}
    <div aria-label={t("home.joiActivityFeed")} className="joi-feed joi-feed-single">
      {visibleThinking.map((item) => <ThinkingRow item={item} key={item.turnId} />)}
      {feed.unassignedActions.map((message) => <article className="joi-feed-item needs-you" key={message.inputId}><div className="joi-feed-head"><span className="joi-feed-stage">{t("home.yourConfirmationIsNeeded")}</span><span className="joi-feed-head-right"><time className="joi-feed-time">{new Date(message.acceptedAt).toLocaleString(currentLocale())}</time><CancelInputButton api={api} inputId={message.inputId} onCanceled={() => dismissAction(message.inputId)} /></span></div>{message.textPreview === undefined ? null : <p className="joi-feed-text">{message.textPreview}</p>}{needsWorkbenchChoice(message.clarificationReasonCode) ? <><p className="joi-clarify-reason">{clarificationText(message.clarificationReasonCode, message.clarificationPrompt)}</p><button className="button primary" onClick={() => setWorkbenchChoiceId(message.inputId)} type="button">{t("home.chooseWorkbench")}</button></> : <ClarificationActions api={api} partners={snapshot.partners} workbenchId={message.workbenchId} workbenches={snapshot.workbenches} inputId={message.inputId} onResolved={() => { dismissAction(message.inputId); void refreshAfterMutation().catch(() => undefined); }} prompt={message.clarificationPrompt} questionId={message.questionId} questionVersion={message.questionVersion} reasonCode={message.clarificationReasonCode} {...(message.textPreview === undefined ? {} : { suggestionSeed: message.textPreview })} />}</article>)}
      {visibleGoals.map((goal) => <article className={`joi-goal-card ${goal.status.toLowerCase()}`} key={goal.goalId}>
        <div className="joi-goal-row">
          <GoalCardHead goal={goal} onOpen={() => { setResultGoalId(null); setOpenGoalAgentStatus(undefined); setOpenGoalId(goal.goalId); }} />
          <div className="joi-goal-side"><GoalStatusBadge status={goal.status} /><GoalActionMenu api={api} goal={goal} onRetried={() => setRetryGoalId((current) => current === goal.goalId ? null : goal.goalId)} onDismissed={() => dismissGoal(goal.goalId)} onChanged={() => void refresh().catch(() => undefined)} /></div>
        </div>
        <GoalResultPreview goal={goal} onOpen={() => { setResultGoalId(goal.goalId); setOpenGoalId(null); }} />
        {goal.failure === undefined ? null : <GoalFailureNotice failure={goal.failure} />}
        {goal.clarification === undefined ? null : <ClarificationActions api={api} partners={snapshot.partners} workbenchId={goal.workbench.workbenchId} workbenches={snapshot.workbenches} inputId={goal.goalId} onResolved={() => void refreshAfterMutation().catch(() => undefined)} prompt={goal.clarification.prompt} questionId={goal.clarification.questionId} questionVersion={goal.clarification.questionVersion} reasonCode={goal.clarification.reasonCode} suggestionSeed={goal.title} continuationSummary={goal.completionSummary} onShowContinuationResult={() => { setResultGoalId(goal.goalId); setOpenGoalId(null); }} />}
        {retryGoalId === goal.goalId ? <GoalRetryPanel api={api} goal={goal} onDone={() => { setRetryGoalId(null); markRetryStarted(goal); }} /> : null}
      </article>)}
      {!feedError && visibleThinking.length === 0 && feed.unassignedActions.length === 0 && visibleGoals.length === 0 ? <p className="joi-feed-empty">{t("home.aFreshStartTellJoiAGoalAndWork")}</p> : null}
    </div>
    {snapshot.partners.length >= 2 ? null : <div className="inline-notice warning"><span>{snapshot.partners.length === 0 ? t("home.noWorkPartnersYet") : t("home.onlyValueWorkPartnersAreAvailable", { p0: String(snapshot.partners.length) })}{t("home.buildATeamFromAScenarioPresetOrCreate")}</span><span className="row-actions"><button className="button ghost" onClick={() => onNavigate?.("agents", "scenarios")} type="button">{t("home.viewScenarioPresets")}</button><button className="button ghost" onClick={() => onNavigate?.("agents", "partners")} type="button">{t("home.createPartners")}</button></span></div>}
    <div className="joi-composer-dock">
      <form
        className={`joi-composer${text.length > 0 || files.length > 0 || imported.length > 0 || targetWorkbench !== undefined ? " has-content" : ""}${dragOver ? " drag-over" : ""}`}
        onDragLeave={(event) => { if (event.currentTarget.contains(event.relatedTarget as Node | null)) return; setDragOver(false); }}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); addFiles(Array.from(event.dataTransfer.files)); }}
        onSubmit={(event) => void submit(event)}>
        <label className="joi-composer-label" htmlFor="joi-input">{t("home.messageJoi")}</label>
        <textarea id="joi-input" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} onPaste={(event) => {
          const pasted = Array.from(event.clipboardData.files);
          if (pasted.length > 0) {
            event.preventDefault();
            addFiles(pasted);
            return;
          }
          const imagePath = joiImagePathFromText(event.clipboardData.getData("text/plain"));
          if (imagePath === null) return;
          event.preventDefault();
          importImagePath(imagePath);
        }} placeholder={t("home.describeAGoalAddAnIdeaOrContinueA")} rows={1} value={text} />
        <div className="joi-composer-toolbar">
          <label className="joi-attachment-button" title={t("home.addAttachment")}><PaperclipIcon aria-hidden="true" /><span className="joi-composer-attachment-label">{t("home.addAttachment")}</span><input aria-label={t("home.addAnAttachmentForJoi")} multiple onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} type="file" /></label>
          <ComposerWorkbenchPicker workbenches={snapshot.workbenches} onSelect={setTargetWorkbenchId} selected={targetWorkbench} />
          {files.length === 0 && imported.length === 0 ? null : <span className="joi-file-summary">{[...imported.map((item) => item.filename), ...files.map((file) => file.name)].join("、")}</span>}
          <button className="button primary" disabled={text.trim() === ""} type="submit">{t("home.sendToJoi")}<ArrowUpIcon aria-hidden="true" /></button>
        </div>
      </form>
      {error === null ? null : <p className="inline-notice danger" role="alert">{error}</p>}
    </div>
  </section>;
}

function clarificationText(code: string | undefined, prompt?: string, workbenchName?: string): string {
  if (code === "question_required") return prompt ?? t("home.joiNeedsAnAnswerBeforeContinuingToPlanThis");
  if (code === "partner_waiting_recovery_required") return prompt ?? t("home.aPartnerIsStillWaitingChooseResumeOriginalWork");
  if (code === "partner_auth_required") return prompt ?? t("home.thePartnerNeedsAuthorizationAgainAuthorizeItInPartner");
  if (code === "goal_continuation_required") return t("home.theResultStillNeedsAdditionsOrVerificationThisRound");
  if (code === "workbench_workspace_not_ready") return t("home.valueHasNoWorkingDirectoryYetChooseADirectory", { p0: (workbenchName ?? t("home.currentWorkbench")) });
  if (code === "partner_selection_required") return prompt ?? t("home.chooseAnAvailablePartnerToContinueThisTask");
  if (code === "work_dispatch_failed") return prompt ?? t("home.joiCouldNotDispatchThisTaskItIsPaused");
  if (code === "workbench_selection_invalid") return t("home.joiCannotDetermineTheContextForThisInputChoose");
  if (code === "workbench_creation_unavailable") return t("home.joiWantsToCreateAWorkbenchForThisInput");
  if (code === "workbench_not_found") return t("home.theWorkbenchForThisInputNoLongerExistsChoose");
  return prompt ?? t("home.joiNeedsMoreInformationToContinueAddDetailsBelow");
}

export function JoiHome({ api, focusGoalId, onNavigate, onScheduleGoal }: {
  api: DigitalLifeApi;
  focusGoalId?: string;
  onNavigate?: (section: "agents" | "joi", tab?: "partners" | "scenarios") => void;
  onScheduleGoal?: (goalId: string) => void;
}) {
  useI18n();
  const [snapshot, setSnapshot] = useState<JoiSnapshotDto | null>(null);
  const [error, setError] = useNotice();
  const load = useCallback(async () => {
    try { setSnapshot(await api.joiSnapshot()); setError(null); }
    catch (reason) { setError(reason instanceof ApiError ? reason.displayMessage : noticeMessage("home.couldNotLoadJoiStatus")); }
  }, [api, setError]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  if (error !== null) return <section className="content-state" role="alert"><p>{error}</p><button className="button quiet" onClick={() => void load()} type="button">{t("onboarding.tryAgain")}</button></section>;
  if (snapshot === null) return <section className="content-state" role="status">{t("home.joiIsPreparingOverallStatus")}</section>;
  return snapshot.runtime.configured ? <JoiComposer api={api} {...(focusGoalId === undefined ? {} : { focusGoalId })} {...(onNavigate === undefined ? {} : { onNavigate })} {...(onScheduleGoal === undefined ? {} : { onScheduleGoal })} snapshot={snapshot} /> : <ModelSourceSetup api={api} changed={load} />;
}

/**
 * The cards the user filed away.
 *
 * Archiving is the reversible half of cleaning up the feed, so this screen has to keep every way
 * back: unarchive restores the card, continue revives the goal (which also unarchives it, and hands
 * the user back to the home feed where the resumed work will show up), and remove is still the one
 * action that throws the goal away.
 *
 * The cards here are the compact shape (`GoalCardHead compact`): a filed-away goal is not mid-flight,
 * so its progress and result preview would only make the list harder to scan. The full result stays
 * reachable by opening the card, which is what the whole row does.
 */
export function ArchivedGoals({ api, onContinued }: { api: DigitalLifeApi; onContinued?: (goalId: string) => void }) {
  useI18n();
  const [feed, setFeed] = useState<JoiHomeFeedDto | null>(null);
  const [snapshot, setSnapshot] = useState<JoiSnapshotDto | null>(null);
  const [error, setError] = useNotice();
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);
  const [retryGoalId, setRetryGoalId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [nextFeed, nextSnapshot] = await Promise.all([api.joiHomeFeed(), api.joiSnapshot()]);
      setFeed(nextFeed); setSnapshot(nextSnapshot); setError(null);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.displayMessage : noticeMessage("home.couldNotLoadArchivedGoals"));
    }
  }, [api, setError]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  const refresh = () => void load().catch(() => undefined);
  if (error !== null) return <section className="content-state" role="alert"><p>{error}</p><button className="button quiet" onClick={() => void load()} type="button">{t("onboarding.tryAgain")}</button></section>;
  if (feed === null || snapshot === null) return <section className="content-state" role="status">{t("home.joiIsLoadingArchivedGoals")}</section>;
  const archived = feed.goals.filter((goal) => goal.archivedAt !== undefined);
  const openGoal = archived.find((goal) => goal.goalId === openGoalId);
  return <section className="joi-home" aria-labelledby="joi-archived-title">
    <header><h1 id="joi-archived-title">{t("common.archived")}</h1><p>{t("home.archivingHidesACardFromTheHomePageUnarchive")}</p></header>
    {openGoal === undefined ? null : <GoalDetail key={openGoal.goalId} api={api} partners={snapshot.partners} workbenches={snapshot.workbenches} goal={openGoal} onBack={() => setOpenGoalId(null)} onResolved={refresh} onRetried={(goal) => onContinued?.(goal.goalId)} />}
    <div aria-label={t("home.archivedGoals")} className="joi-feed joi-feed-single">
      {archived.length === 0 ? <p className="joi-feed-empty">{t("home.noArchivedGoalsYetChooseArchiveFromACard")}</p> : archived.map((goal) => <article className={`joi-goal-card archived ${goal.status.toLowerCase()}`} key={goal.goalId}>
        <div className="joi-goal-row">
          <GoalCardHead compact goal={goal} onOpen={() => { setRetryGoalId(null); setOpenGoalId(goal.goalId); }} />
          <div className="joi-goal-side"><GoalStatusBadge status={goal.status} /><GoalActionMenu api={api} archived goal={goal} onRetried={() => setRetryGoalId((current) => current === goal.goalId ? null : goal.goalId)} onDismissed={refresh} onChanged={refresh} /></div>
        </div>
        {retryGoalId === goal.goalId ? <GoalRetryPanel api={api} goal={goal} onDone={() => { setRetryGoalId(null); onContinued?.(goal.goalId); }} /> : null}
      </article>)}
    </div>
  </section>;
}
