import { localizeProductText, noticeMessage, t, useI18n, useNotice } from "./i18n";
import { type ChangeEvent, type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";

import type { CodexPermissionsDto, ModelSourceDto, PartnerDto, PartnerEngineDto, PartnerKnowledgeDocDto, PartnerModelTestDto, ScenarioPackDto, ScenarioPackRoleStateDto, ToolPolicyModeDto } from "../shared/joi";
import { ApiError, type DigitalLifeApi } from "./api";

type PartnerView = { mode: "grid" } | { mode: "editor"; partner: PartnerDto | null };
interface EngineStatus { available: boolean; reason?: string; tools: string[]; }
interface SkillOption { displayName: string; id: string; }

const ENGINE_ORDER: PartnerEngineDto[] = ["pi-core", "claude-code", "codex"];
const ENGINE_LABELS: Record<PartnerEngineDto, string> = { "claude-code": "Claude Code", codex: "Codex", "pi-core": "Pi core" };

function textValue(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function fieldName(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.displayMessage : fallback;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function configurationMessage(reasonCodes: readonly string[]): string {
  if (reasonCodes.includes("partner_skill_requires_read")) return t("partners.enableTheReadToolWhenAttachingASkillTo");
  if (reasonCodes.includes("partner_skill_ref_invalid") || reasonCodes.includes("partner_skill_not_available") || reasonCodes.includes("partner_skill_not_found")) {
    return t("partners.someSkillReferencesAreInvalidSelectInstalledLocalSkills");
  }
  if (reasonCodes.includes("partner_skill_collision")) return t("partners.selectedSkillNamesConflictKeepOnlyOneSourceFor");
  if (reasonCodes.includes("partner_skill_environment_invalid")) return t("partners.theSkillEnvironmentDeclarationIsInvalidChooseAValid");
  return t("partners.fixThePartnerConfigurationBeforeDispatchingWork");
}

function modelTestMessage(result: PartnerModelTestDto, engine: PartnerEngineDto): string {
  if (result.status === "READY") return engine === "pi-core" ? t("partners.modelReady") : t("partners.partnerReady");
  if (result.reasonCode === "partner_model_override_not_ready") return t("partners.theModelNameDoesNotMatchTheProviderS");
  if (result.reasonCode === "partner_model_source_not_ready") return t("partners.providerNotReady");
  if (result.reasonCode === "partner_cli_probe_timed_out") return t("partners.partnerCallTimedOut");
  if (result.reasonCode === "partner_cli_auth_required") return engine === "claude-code" ? t("partners.claudeCodeAuthenticationFailedCheckTheLocalClaudeLogin") : t("partners.valueIsNotSignedInSignInFirst", { p0: ENGINE_LABELS[engine] });
  if (result.reasonCode === "partner_cli_model_unsupported") return t("partners.theLocalCliOrAccountDoesNotSupportThis");
  if (result.reasonCode === "partner_cli_rate_limited") return t("partners.tooManyRequestsTryAgainLater");
  if (result.reasonCode === "partner_cli_provider_unavailable") return t("partners.theModelServiceIsTemporarilyUnavailableTryAgainLater");
  if (result.reasonCode === "partner_cli_process_failed") return t("partners.theLocalPartnerProcessCouldNotStart");
  if (result.reasonCode === "partner_cli_store_failed") return t("partners.theLocalSessionCouldNotBeRecorded");
  if (result.reasonCode === "engine_unavailable") return t("partners.localEngineNotReady");
  return engine === "pi-core" ? t("partners.modelConnectionFailed") : t("partners.partnerCallFailed");
}

function PartnerModelStatus({ engine, result }: { engine: PartnerEngineDto; result: PartnerModelTestDto | "TESTING" | undefined }) {
  useI18n();
  const modelManaged = engine === "pi-core";
  if (result === "TESTING") return <div className="partner-model-status" role="status"><span>{modelManaged ? t("partners.testingTheModel") : t("partners.callingThePartner")}</span></div>;
  if (result === undefined) return <div className="partner-model-status" role="status"><span>{modelManaged ? t("partners.modelNotTestedYet") : t("partners.partnerAvailabilityNotTestedYet")}</span></div>;
  const tested = result.testedAt === undefined ? "" : new Date(result.testedAt).toLocaleString("zh-CN");
  const detail = [result.sourceDisplayName, result.modelId, tested].filter(Boolean).join(" · ");
  return <div className="partner-model-status" role="status">
    <span>{modelTestMessage(result, engine)}</span>
    <small>{detail}</small>
  </div>;
}

function persistedModelTest(partner: PartnerDto, sources: ModelSourceDto[]): PartnerModelTestDto | undefined {
  const ordered = [...sources].filter((source) => source.status !== "DISABLED").sort((left, right) => left.order - right.order);
  const source = partner.modelSourceId === undefined
    ? ordered.find((candidate) => candidate.status === "READY") ?? ordered[0]
    : sources.find((candidate) => candidate.sourceId === partner.modelSourceId);
  if (source === undefined) return undefined;
  const modelMismatch = partner.modelIdOverride !== undefined && partner.modelIdOverride !== source.activeModel.id;
  // Editing a model source resets it to DRAFT and clears its validation stamp, and that is exactly
  // the state the next dispatch fails on. Waiting for `lastValidatedAt` would hide it, so a partner
  // the user pinned to a source that is not READY says so now rather than after a wasted run.
  if (partner.modelSourceId !== undefined && source.status !== "READY") {
    return {
      modelId: partner.modelIdOverride ?? source.activeModel.id,
      partnerId: partner.partnerId,
      reasonCode: "partner_model_source_not_ready",
      sourceDisplayName: source.displayName,
      sourceId: source.sourceId,
      status: "FAILED",
      ...(source.lastValidatedAt === undefined ? {} : { testedAt: source.lastValidatedAt }),
    };
  }
  if (source.lastValidatedAt === undefined) return undefined;
  return {
    modelId: partner.modelIdOverride ?? source.activeModel.id,
    partnerId: partner.partnerId,
    ...(modelMismatch ? { reasonCode: "partner_model_override_not_ready" } : source.reasonCode === undefined ? {} : { reasonCode: source.reasonCode }),
    sourceDisplayName: source.displayName,
    sourceId: source.sourceId,
    status: source.status === "READY" && !modelMismatch ? "READY" : "FAILED",
    testedAt: source.lastValidatedAt,
  };
}

function KnowledgeDocList({ api, onChanged, partnerId }: { api: DigitalLifeApi; onChanged: () => void; partnerId: string }) {
  useI18n();
  const [docs, setDocs] = useState<PartnerKnowledgeDocDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => setDocs((await api.listKnowledgeDocs(partnerId)).items), [api, partnerId]);
  useEffect(() => { const timer = setTimeout(() => void load().catch(() => setBusy(t("partners.couldNotLoadTheKnowledgeBase"))), 0); return () => clearTimeout(timer); }, [load]);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    for (const file of files) {
      setBusy(t("partners.importingValue", { p0: file.name }));
      try { await api.uploadKnowledgeDoc(partnerId, file); }
      catch (error) { setBusy(failureMessage(error, t("partners.couldNotImportTheKnowledgeDocument"))); await load().catch(() => undefined); return; }
    }
    setBusy(null);
    await load().catch(() => undefined);
    onChanged();
  };
  return <div className="kb-doc-list">
    {docs.map((doc) => <div className="kb-doc-row" key={doc.docId}><span>{doc.filename} · {(doc.bytes / 1024).toFixed(1)} KiB</span><button className="button ghost" onClick={() => void api.deleteKnowledgeDoc(partnerId, doc.docId).then(load).then(onChanged).catch(() => setBusy(t("partners.couldNotRemoveTheKnowledgeDocument")))} type="button">{t("home.remove2f752c")}</button></div>)}
    <label className="kb-upload">{t("partners.attachMarkdownDocumentsUpTo8EachUpTo")}<input accept=".md,.txt" aria-label={t("partners.attachKnowledgeDocument")} multiple onChange={(event) => void upload(event)} type="file" /></label>
    {busy === null ? null : <small className="kb-busy">{busy}</small>}
  </div>;
}

function PartnerEditor({ api, engineStatuses, onDone, onManageProviders, partner, sources }: {
  api: DigitalLifeApi;
  engineStatuses: Record<string, EngineStatus>;
  onDone: (message: string, partnerId?: string) => void;
  onManageProviders?: () => void;
  partner: PartnerDto | null;
  sources: ModelSourceDto[];
}) {
  useI18n();
  const [kind, setKind] = useState<"local-pi" | "a2a">(partner?.kind ?? "local-pi");
  const [tab, setTab] = useState<"advanced" | "basic">("basic");
  const [engine, setEngine] = useState<PartnerEngineDto>(partner?.engine ?? "pi-core");
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [loadedSkillCatalogKey, setLoadedSkillCatalogKey] = useState<string | null>(null);
  const initialSelectedSkills = partner?.skills ?? [];
  const [selectedSkills, setSelectedSkills] = useState<string[]>(partner?.skills ?? []);
  const [selectedTools, setSelectedTools] = useState<string[]>(partner?.tools ?? []);
  const [toolPolicyMode, setToolPolicyMode] = useState<ToolPolicyModeDto>(partner?.toolPolicyMode ?? (partner === null || partner.tools.length === 0 ? "ALL" : "CUSTOM"));
  const [codexPermissions, setCodexPermissions] = useState<CodexPermissionsDto>(partner?.codexPermissions ?? {
    approvalPolicy: "never",
    networkAccessEnabled: true,
    sandboxMode: "workspace-write",
    webSearchMode: "live",
  });
  const [modelIdOverride, setModelIdOverride] = useState(partner?.modelIdOverride ?? "");
  const [modelSourceId, setModelSourceId] = useState(partner?.modelSourceId ?? "");
  const [notice, setNotice] = useNotice();
  const [promptDraft, setPromptDraft] = useState("");
  const [promptMode, setPromptMode] = useState<"APPEND" | "REPLACE">("REPLACE");
  const [promptTouched, setPromptTouched] = useState(false);
  const [promptRevealState, setPromptRevealState] = useState<"failed" | "hidden" | "loading" | "visible">("hidden");
  const [revealedPrompt, setRevealedPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "local-pi") return;
    let cancelled = false;
    const catalogKey = `${kind}:${engine}`;
    const timer = setTimeout(() => void api.engineSkills(engine)
      .then((page) => { if (!cancelled) { setSkills(page.items); setLoadedSkillCatalogKey(catalogKey); } })
      .catch(() => { if (!cancelled) { setSkills([]); setLoadedSkillCatalogKey(catalogKey); } }), 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, engine, kind]);

  const handleEngineChange = (next: PartnerEngineDto) => {
    setEngine(next);
    setSelectedTools([]);
    setToolPolicyMode("ALL");
    setSelectedSkills([]);
  };

  const revealPrompt = async () => {
    if (partner === null) return;
    setPromptRevealState("loading");
    try {
      const result = await api.revealPartnerPrompt(partner.partnerId);
      setRevealedPrompt(result.prompt);
      setPromptDraft(result.prompt ?? "");
      setPromptMode("REPLACE");
      setPromptTouched(false);
      setPromptRevealState("visible");
    } catch {
      setPromptRevealState("failed");
    }
  };

  const selectPromptMode = (next: "APPEND" | "REPLACE") => {
    setPromptMode(next);
    setPromptDraft(next === "REPLACE" ? (revealedPrompt ?? "") : "");
    setPromptTouched(false);
  };

  const submitLocal = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const description = textValue(form.get("description"));
    const engineModelId = textValue(form.get("engineModelId"));
    const normalizedModelId = modelIdOverride.trim();
    const normalizedSourceId = modelSourceId.trim();
    const prompt = partner === null ? textValue(form.get("prompt")) : promptTouched ? textValue(promptDraft) : undefined;
    const fields = {
      displayName: fieldName(form.get("displayName")),
      // Always carry the engine. The registry derives it from the payload
      // (`input.engine ?? current.engine`), so omitting it for Pi core silently kept the
      // partner's previous engine: switching Codex/Claude Code back to Pi core never stuck.
      engine,
      skills: selectedSkills,
      ...(engine === "codex" ? {} : { toolPolicyMode }),
      tools: selectedTools,
      ...(engine === "codex" ? { codexPermissions } : {}),
      ...(description === undefined ? {} : { description }),
      ...(prompt === undefined ? {} : { prompt }),
    };
    try {
      if (partner === null) {
        const created = await api.createPartner({
          ...fields,
          ...(engine === "pi-core"
            ? {
              ...(normalizedModelId === "" ? {} : { modelIdOverride: normalizedModelId }),
              ...(normalizedSourceId === "" ? {} : { modelSourceId: normalizedSourceId }),
            }
            : engineModelId === undefined ? {} : { engineModelId }),
          kind: "local-pi",
        });
        onDone(t("partners.partnerRegisteredAddKnowledgeDocumentsBeforeHandingItTo"), created.partnerId);
      } else {
        await api.updatePartner(partner.partnerId, {
          ...fields,
          ...(prompt === undefined ? {} : { promptMode }),
          ...(engine === "pi-core"
            ? {
              modelIdOverride: normalizedModelId === "" ? null : normalizedModelId,
              modelSourceId: normalizedSourceId === "" ? null : normalizedSourceId,
            }
            : { engineModelId: engineModelId ?? null }),
        });
        onDone(t("partners.changesSavedAsANewPartnerRevision"), partner.partnerId);
      }
    } catch (error) { setNotice(failureMessage(error, t("partners.partnerCouldNotBeSaved"))); }
  };

  const submitA2a = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const agent = await api.addAgent(fieldName(form.get("cardUrl")), fieldName(form.get("token")));
      onDone(t("partners.remotePartnerRegisteredYouCanAddADescriptionAnd"), `partner_${agent.agentConnectionId}`);
    } catch (error) { setNotice(failureMessage(error, t("partners.remotePartnerCouldNotBeRegistered"))); }
  };

  const engineStatus = engineStatuses[engine];
  const availableSkillIds = new Set(skills.map((skill) => skill.id));
  const skillsLoading = kind === "local-pi" && loadedSkillCatalogKey !== `${kind}:${engine}`;
  const invalidSelectedSkills = kind !== "local-pi" || skillsLoading ? [] : selectedSkills.filter((skill) => !availableSkillIds.has(skill));
  const missingReadForSkills = engine === "pi-core" && selectedSkills.length > 0 && toolPolicyMode === "CUSTOM" && !selectedTools.includes("read");
  const skillSelectionChanged = selectedSkills.length !== initialSelectedSkills.length
    || selectedSkills.some((skill, index) => initialSelectedSkills[index] !== skill);
  const persistedConfigurationNeedsSkillChange = partner?.configuration?.reasonCodes.some((code) => code.startsWith("partner_skill_") && code !== "partner_skill_requires_read") ?? false;
  const unchangedPersistedConfiguration = partner?.configuration?.status === "ACTION_REQUIRED"
    && persistedConfigurationNeedsSkillChange && !skillSelectionChanged && !missingReadForSkills;
  const cannotSave = (skillsLoading && selectedSkills.length > 0) || invalidSelectedSkills.length > 0 || missingReadForSkills || unchangedPersistedConfiguration;
  const skillContent = skillsLoading
    ? <small className="field-hint">{t("partners.loadingInstalledSkillsForTheCurrentEngine")}</small>
    : skills.length === 0
      ? <small className="field-hint">{t("partners.noSelectableSkillsForThisEngineYet")}</small>
      : <div className="chip-group">{skills.map((skill) => <label className="chip" key={skill.id}><input checked={selectedSkills.includes(skill.id)} onChange={() => setSelectedSkills((current) => toggle(current, skill.id))} type="checkbox" />{skill.displayName}</label>)}</div>;
  const localEngineReason = engine !== "pi-core" && engineStatus !== undefined && !engineStatus.available ? (engineStatus.reason ?? t("partners.thisLocalEngineWasNotDetected")) : null;
  const header = partner === null
    ? <header className="page-title-row"><div><p className="eyebrow">{t("partners.addPartner")}</p><h1>{t("partners.whereWillThisPartnerRun")}</h1><p>{t("partners.localPartnersWorkAlongsideJoiRemotePartnersCollaborateOver")}</p></div><button className="button ghost" onClick={() => onDone(t("partners.returnedToThePartnerList"))} type="button">{t("common.back")}</button></header>
    : <header className="page-title-row"><div><p className="eyebrow">{t("partners.editPartner")}</p><h1>{partner.displayName}</h1><p>{t("partners.changesCreateANewRevisionWorkAlreadyInProgress")}</p></div><button className="button ghost" onClick={() => onDone(t("partners.returnedToThePartnerList"))} type="button">{t("common.back")}</button></header>;

  return <div className="partner-editor">
    {header}
    {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
    {partner?.configuration?.status === "ACTION_REQUIRED" ? <p className="inline-notice warning" role="alert">{configurationMessage(partner.configuration.reasonCodes)}</p> : null}
    {partner === null ? <div className="mode-cards">
      <button aria-pressed={kind === "local-pi"} className={`mode-card ${kind === "local-pi" ? "selected" : ""}`} onClick={() => setKind("local-pi")} type="button"><strong>{t("home.localPartner")}</strong><span>{t("partners.aPartnerRunningOnThisComputerJoiDispatchesWork")}</span></button>
      <button aria-pressed={kind === "a2a"} className={`mode-card ${kind === "a2a" ? "selected" : ""}`} onClick={() => setKind("a2a")} type="button"><strong>{t("partners.remoteA2a")}</strong><span>{t("partners.aRemoteAgentConnectedThroughAnAgentCardFor")}</span></button>
    </div> : null}
    {partner !== null && partner.kind === "a2a" ? <p className="inline-notice info">{t("partners.remoteCapabilitiesComeFromTheAgentCardTheseDetails")}</p> : null}
    {partner === null && kind === "a2a" ? <form className="partner-form" onSubmit={(event) => void submitA2a(event)}>
      <label>{t("partners.remoteAgentCardUrl")}<input name="cardUrl" required type="url" /></label>
      <label>{t("partners.remoteBearerToken")}<input autoComplete="off" name="token" type="password" /></label>
      <button className="button primary" type="submit">{t("partners.registerRemotePartner")}</button>
    </form> : <form className="partner-form partner-editor-form" onSubmit={(event) => void submitLocal(event)}>
      <div className="tab-row" role="tablist">
        <button aria-selected={tab === "basic"} className={tab === "basic" ? "selected" : ""} onClick={() => setTab("basic")} role="tab" type="button">{t("partners.basic")}</button>
        <button aria-selected={tab === "advanced"} className={tab === "advanced" ? "selected" : ""} onClick={() => setTab("advanced")} role="tab" type="button">{t("partners.advanced")}</button>
      </div>
      <div className="tab-panel" style={tab === "basic" ? undefined : { display: "none" }}>
        <div className="partner-basic-grid">
          <label>{t("automation.name")}<input defaultValue={partner?.displayName} name="displayName" placeholder={t("partners.capabilityNameEGCodingPartner")} required /></label>
          <label>{t("partners.descriptionForJoi")}<textarea defaultValue={partner?.description} name="description" placeholder={t("partners.describeItsStrengthsInOneSentenceWithoutRepeatingWorkspace")} rows={3} /></label>
          {partner === null ? <label>{t("partners.partnerPrompt")}<textarea name="prompt" placeholder={t("partners.instructionsSentWithItsWorkStoredLocallyOnly")} rows={5} /></label> : <div className="prompt-editor-field">
            <div className="prompt-editor-heading">
              <span>{t("partners.partnerPrompt")}</span>
              <button className="button ghost" disabled={promptRevealState === "loading"} onClick={() => void revealPrompt()} type="button">{promptRevealState === "loading" ? t("home.loading") : promptRevealState === "visible" ? t("home.reload") : t("automation.viewPrompt")}</button>
            </div>
            <small className="field-hint">{partner.promptConfigured ? t("partners.configuredAndHiddenByDefaultRevealToReplaceOr") : t("partners.noPromptConfiguredRevealToAddOne")}</small>
            {promptRevealState === "failed" ? <p className="inline-notice warning" role="alert">{t("partners.couldNotLoadThePromptTryAgain")}</p> : null}
            {promptRevealState === "visible" ? <>
              <div aria-label={t("partners.promptEditMode")} className="prompt-mode-row" role="radiogroup">
                <label><input checked={promptMode === "REPLACE"} name="promptMode" onChange={() => selectPromptMode("REPLACE")} type="radio" />{t("partners.replace")}</label>
                <label><input checked={promptMode === "APPEND"} name="promptMode" onChange={() => selectPromptMode("APPEND")} type="radio" />{t("partners.append")}</label>
              </div>
              {promptMode === "APPEND" && revealedPrompt !== null ? <label>{t("partners.currentPrompt")}<textarea aria-label={t("partners.currentPrompt")} readOnly rows={5} value={revealedPrompt} /></label> : null}
              <label>{promptMode === "APPEND" ? t("partners.contentToAppend") : t("partners.replacementContent")}<textarea
                aria-label={promptMode === "APPEND" ? t("partners.contentToAppend") : t("partners.replacementContent")}
                onChange={(event) => { setPromptDraft(event.target.value); setPromptTouched(true); }}
                placeholder={promptMode === "APPEND" ? t("partners.enterContentToAppendToTheCurrentPrompt") : t("partners.enterTheCompleteNewPrompt")}
                rows={6}
                value={promptDraft}
              /></label>
              <small className="field-hint">{promptMode === "APPEND" ? t("partners.theAppendedContentIsSeparatedFromTheCurrentPrompt") : t("partners.savingReplacesTheCurrentPromptWithThisContentNo")}</small>
            </> : null}
          </div>}
        </div>
        <div className="kb-field"><span className="kb-field-label">{t("partners.knowledgeBase")}</span>{partner !== null && partner.kind === "local-pi" ? <KnowledgeDocList api={api} onChanged={() => undefined} partnerId={partner.partnerId} /> : <small>{t("partners.saveThePartnerBeforeAttachingMarkdownDocuments")}</small>}</div>
        <div className="skill-field"><span className="kb-field-label">{t("partners.skillsOptionalInstalledSkillsAreScannedByEngine")}</span>
          <small className="field-hint">{t("partners.uncheckedSkillsAreNotAttachedToThePartner")}</small>
          {invalidSelectedSkills.length > 0 ? <div className="inline-notice warning" role="alert">
            <span>{configurationMessage(["partner_skill_ref_invalid"])}  {t("partners.removeInvalidReferencesFirst")}</span>
            <div className="chip-group">{invalidSelectedSkills.map((skill) => <button className="chip" key={skill} onClick={() => setSelectedSkills((current) => current.filter((item) => item !== skill))} type="button">{skill} ×</button>)}</div>
          </div> : null}
          {skillContent}
        </div>
        <button className="button primary" disabled={cannotSave} type="submit">{partner === null ? t("partners.savePartner") : t("home.saveChanges")}</button>
      </div>
      <div className="tab-panel" style={tab === "advanced" ? undefined : { display: "none" }}>
        <label>{t("partners.partnerEngine")}<select name="engine" onChange={(event) => handleEngineChange(event.target.value as PartnerEngineDto)} value={engine}>
          {ENGINE_ORDER.map((id) => { const status = engineStatuses[id]; const suffix = id === "pi-core" ? "" : status === undefined ? "" : status.available ? t("partners.detected") : t("partners.notDetected"); return <option key={id} value={id}>{ENGINE_LABELS[id]}{suffix}</option>; })}
        </select></label>
        {localEngineReason === null ? null : <p className="inline-notice warning" role="status">{localEngineReason}  {t("partners.completeLocalSetupAsInstructedOrSwitchBackTo")}</p>}
        {engine === "pi-core" ? <>
          <label>{t("partners.modelName")}<input name="modelIdOverride" onChange={(event) => setModelIdOverride(event.target.value)} placeholder={t("partners.leaveBlankForTheGlobalPreferredModel")} value={modelIdOverride} /></label>
          <label>{t("partners.provider")}<span className="picker-field"><select name="modelSourceId" onChange={(event) => {
            const nextSourceId = event.target.value;
            setModelSourceId(nextSourceId);
            const selected = sources.find((source) => source.sourceId === nextSourceId);
            setModelIdOverride(selected?.activeModel.id ?? "");
          }} value={modelSourceId}><option value="">{t("partners.useTheGlobalPreferredModelConnection")}</option>{sources.map((source) => <option disabled={source.status !== "READY"} key={source.sourceId} value={source.sourceId}>{source.displayName}（{source.kind}）{source.status === "READY" ? "" : t("partners.notReady")}</option>)}</select><button className="button ghost" onClick={() => onManageProviders?.()} type="button">{t("partners.manageModelConnections")}</button></span></label>
        </> : <>
          <label>{t("partners.modelNameOptionalOverride")}<input defaultValue={partner?.engineModelId} name="engineModelId" placeholder={t("partners.leaveBlankForTheLocalClaudeCodexConfiguration")} /></label>
          <p className="field-hint">{engine === "claude-code"
            ? t("partners.claudeCodeUsesLocalClaudeConfigurationAndAuthenticationInvoking")
            : t("partners.codexUsesYourLocalCodexCliLoginAndConfiguration")}</p>
        </>}
        {engine === "codex" ? <div className="tool-field"><span className="kb-field-label">{t("partners.codexPermissions")}</span>
          <label>{t("partners.workspacePermissions")}<select aria-label={t("partners.codexWorkspacePermissions")} onChange={(event) => setCodexPermissions((current) => ({ ...current, sandboxMode: event.target.value as CodexPermissionsDto["sandboxMode"] }))} value={codexPermissions.sandboxMode}>
            <option value="workspace-write">{t("partners.writableWorkspace")}</option><option value="read-only">{t("partners.readOnly")}</option>
          </select></label>
          <label>{t("partners.webSearch")}<select aria-label={t("partners.codexWebSearch")} onChange={(event) => setCodexPermissions((current) => ({ ...current, webSearchMode: event.target.value as CodexPermissionsDto["webSearchMode"] }))} value={codexPermissions.webSearchMode}>
            <option value="disabled">{t("common.close")}</option><option value="cached">{t("partners.cachedResults")}</option><option value="live">{t("partners.liveSearch")}</option>
          </select></label>
          <label className="tool-choice"><input checked={codexPermissions.networkAccessEnabled} onChange={(event) => setCodexPermissions((current) => ({ ...current, networkAccessEnabled: event.target.checked }))} type="checkbox" /><span>{t("partners.allowNetworkAccess")}</span></label>
          <small className="field-hint">{t("partners.approvalPolicyIsFixedToNeverUnrestrictedAccessIs")}</small>
        </div> : <div className="tool-field"><span className="kb-field-label">{t("partners.toolPermissions")}</span>
          <div className="button-row"><button className="button ghost" onClick={() => { setToolPolicyMode("ALL"); setSelectedTools([]); }} type="button">{t("partners.enableAll")}</button><button className="button ghost" onClick={() => { setToolPolicyMode("CUSTOM"); setSelectedTools([]); }} type="button">{t("partners.disableAll")}</button></div>
          {(engineStatus?.tools.length ?? 0) === 0 ? <small className="field-hint">{t("partners.noSelectableToolsForThisEngine")}</small> : <div aria-label={t("partners.allowedTools")} className="tool-choice-grid" role="group">{(engineStatus?.tools ?? []).map((tool) => <label className="tool-choice" key={tool}><input checked={toolPolicyMode === "ALL" || selectedTools.includes(tool)} onChange={() => {
            if (toolPolicyMode === "ALL") {
              setToolPolicyMode("CUSTOM");
              setSelectedTools((engineStatus?.tools ?? []).filter((candidate) => candidate !== tool));
            } else setSelectedTools((current) => toggle(current, tool));
          }} type="checkbox" /><span>{tool}</span></label>)}</div>}
          <small className="field-hint">{toolPolicyMode === "ALL" ? t("partners.allToolsAreEnabledDisablingAnyToolSwitchesTo") : t("partners.customPermissionsValueEnabled", { p0: String(selectedTools.length) })}</small>
        </div>}
        {missingReadForSkills ? <p className="inline-notice warning" role="alert">{t("partners.skillsAreSelectedWithRestrictedToolsEnableReadBefore")}</p> : null}
        <button className="button primary" disabled={cannotSave} type="submit">{partner === null ? t("partners.savePartner") : t("home.saveChanges")}</button>
      </div>
    </form>}
  </div>;
}

function useScenarioCatalog(api: DigitalLifeApi, enabled: boolean, onInstalled: () => Promise<unknown>) {
  const [packs, setPacks] = useState<ScenarioPackDto[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installationInterrupted, setInstallationInterrupted] = useState(false);
  const installationPending = useRef(false);
  const generation = useRef(0);
  const [packNotice, setPackNotice] = useNotice();
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "failed">("loading");
  const loadPacks = useCallback(async () => {
    const request = ++generation.current;
    try {
      const page = await api.scenarioPacks();
      if (request !== generation.current) return;
      setPacks(page.items);
      setCatalogState("ready");
    } catch {
      if (request === generation.current) setCatalogState("failed");
    }
  }, [api]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => void loadPacks(), 0);
    return () => clearTimeout(timer);
  }, [enabled, loadPacks]);
  useEffect(() => () => { generation.current++; }, []);
  const install = async (packId: string, teamIds?: string[]) => {
    if (installationPending.current) return;
    installationPending.current = true;
    const key = teamIds?.[0] ?? "full";
    setInstalling(`${packId}:${key}`);
    setInstallationInterrupted(false);
    setPackNotice(null);
    try {
      const result = await api.installScenarioPack(packId, teamIds);
      const created = result.outcomes.filter((item) => item.outcome === "CREATED").length;
      const reused = result.outcomes.filter((item) => item.outcome === "REUSED").length;
      const actionRequired = result.outcomes.filter((item) => item.outcome === "ACTION_REQUIRED").length;
      setPackNotice(noticeMessage("partners.presetPackProcessedValueCreatedValueReusedValue", { p0: String(created), p1: String(reused), p2: (actionRequired === 0 ? "" : t("partners.valueNeedAttention", { p0: String(actionRequired) })) }));
    } catch (error) {
      setPackNotice(failureMessage(error, t("partners.couldNotInstallThePresetPackTryAgainLater")));
      setInstallationInterrupted(true);
    } finally {
      await Promise.allSettled([loadPacks(), onInstalled()]);
      installationPending.current = false;
      setInstalling(null);
    }
  };
  return { packs, installing, installationInterrupted, packNotice, catalogState, loadPacks, install };
}

function ScenarioGrid({ catalog }: { catalog: ReturnType<typeof useScenarioCatalog> }) {
  useI18n();
  const [expandedPackId, setExpandedPackId] = useState<string | null>(null);
  const { packs, installing, installationInterrupted, packNotice, catalogState, loadPacks, install } = catalog;
  if (catalogState === "loading") return <div aria-label={t("partners.loadingScenarioPacks")} className="scenario-pack-loading"><span /><span /><span /></div>;
  return <div className="scenario-catalog">
    {catalogState === "failed" ? <div className="inline-notice warning" role="alert"><span>{t("partners.couldNotLoadScenarioPacksTryAgainLater")}</span><button className="button ghost" onClick={() => void loadPacks()} type="button">{t("common.retry")}</button></div> : null}
    {catalogState === "ready" && packs.length === 0 ? <div className="plain-empty"><h2>{t("partners.noScenarioPacksYet")}</h2><p>{t("partners.youCanStillAddPartnersManuallyPacksAppearHere")}</p></div> : null}
    <section aria-label={t("partners.scenarioPacks")} className="scenario-pack-group">
      {packNotice === null ? null : <p className="inline-notice info" role="status">{packNotice}</p>}
      {installationInterrupted ? <p className="field-hint" role="status">{t("partners.partialInstallationPreserved")}</p> : null}
      {packs.map((pack) => {
        const expanded = expandedPackId === pack.id;
        const fullKey = `${pack.id}:full`;
        const builtinText = (value: string) => ["programming", "research-analysis", "ai-berkshire-value-research"].includes(pack.id) ? localizeProductText(value) : value;
        return <article className="scenario-pack" key={pack.id}>
          <button aria-expanded={expanded} className="scenario-pack-summary" onClick={() => setExpandedPackId(expanded ? null : pack.id)} type="button">
            <span><strong>{pack.id === "builtin-skills" ? localizeProductText(pack.title) : builtinText(pack.title)}</strong><small>{pack.id === "builtin-skills" ? localizeProductText(pack.blurb) : builtinText(pack.blurb)}</small></span>
            <span className={`scenario-pack-state ${pack.status.toLowerCase()}`}>{pack.totalRoleCount === 0 ? t("partners.nothingAvailable") : t("partners.valueValuePartners", { p0: String(pack.installedRoleCount), p1: String(pack.totalRoleCount) })} · {packStatusLabel(pack.status)}</span>
          </button>
          {expanded ? <div className="scenario-pack-body">
            <div className="scenario-pack-meta"><span>{t("partners.source")} {pack.source.repository}@{pack.source.revision}</span><span>{(pack.source.repository === "joi/builtin" || pack.id === "builtin-skills") ? localizeProductText(pack.source.license) : pack.source.license}</span></div>
            {pack.teams.length === 0 ? <div className="scenario-pack-empty"><strong>{t("partners.noInstallableSkillsYet")}</strong><p>{t("partners.installSkillsLocallyAndReopenThisPageRecentlyUsed")}</p></div> : <div className="scenario-team-grid">{pack.teams.map((team) => {
              const teamKey = `${pack.id}:${team.id}`;
              return <article className="scenario-team" key={team.id}>
                <div><strong>{builtinText(team.title)}</strong><p>{builtinText(team.blurb)}</p></div>
                <div aria-label={t("partners.valuePartner", { p0: builtinText(team.title) })} className="scenario-role-list">{team.roles.map((role) => <span className="scenario-role" key={role.id} title={role.reasonCode}><span>{builtinText(role.title)}</span><small className={`role-state ${role.status.toLowerCase()}`}>{roleStateLabel(role.status)}</small></span>)}</div>
                <button className="button ghost" disabled={installing !== null} onClick={() => void install(pack.id, [team.id])} type="button">{installing === teamKey ? t("partners.installing") : t("partners.installValue", { p0: builtinText(team.title) })}</button>
              </article>;
            })}</div>}
            <button className="button primary" disabled={installing !== null || pack.totalRoleCount === 0} onClick={() => void install(pack.id)} type="button">{installing === fullKey ? t("partners.installing") : pack.totalRoleCount === 0 ? t("partners.nothingToInstall") : t("partners.installFullPack")}</button>
          </div> : null}
        </article>;
      })}
    </section>
  </div>;
}

function packStatusLabel(status: ScenarioPackDto["status"]): string {
  if (status === "NOT_INSTALLED") return t("partners.notInstalled");
  if (status === "ACTIVE") return t("evolution.enabled");
  if (status === "OUTDATED") return t("partners.updateAvailable");
  return t("status.actionNeeded");
}

function roleStateLabel(status: ScenarioPackRoleStateDto): string {
  if (status === "NOT_INSTALLED") return t("partners.notInstalled");
  if (status === "ACTIVE") return t("evolution.enabled");
  if (status === "DISABLED") return t("status.disabled");
  if (status === "OUTDATED") return t("partners.updateAvailable");
  return t("status.actionNeeded");
}

export function PartnerPage({ api, onManageProviders, tab, onTabChange }: { api: DigitalLifeApi; onManageProviders?: () => void; tab?: "partners" | "scenarios"; onTabChange?: (tab: "partners" | "scenarios") => void }) {
  useI18n();
  const [partners, setPartners] = useState<PartnerDto[]>([]);
  const [sources, setSources] = useState<ModelSourceDto[]>([]);
  const [engineStatuses, setEngineStatuses] = useState<Record<string, EngineStatus>>({});
  const [view, setView] = useState<PartnerView>({ mode: "grid" });
  const [notice, setNotice] = useNotice();
  const [modelTests, setModelTests] = useState<Record<string, PartnerModelTestDto | "TESTING">>({});
  const loadGeneration = useRef({ value: 0 });
  const [partnersLoaded, setPartnersLoaded] = useState(false);
  const [catalogReadFailed, setCatalogReadFailed] = useState(false);
  const [sourceReadFailed, setSourceReadFailed] = useState(false);
  const [engineReadFailed, setEngineReadFailed] = useState(false);
  const load = useCallback(async () => {
    const request = ++loadGeneration.current.value;
    const current = () => request === loadGeneration.current.value;
    const partnerRead = api.listPartners().then(page => {
      if (current()) { setPartners(page.items); setPartnersLoaded(true); setCatalogReadFailed(false); }
      return page.items;
    }, (error: unknown) => { if (current()) setCatalogReadFailed(true); throw error; });
    const sourceRead = api.listModelSources().then(page => {
      if (current()) { setSources(page.items); setSourceReadFailed(false); }
    }, () => { if (current()) setSourceReadFailed(true); });
    const engineRead = api.engineCatalog().then(page => {
      if (!current()) return;
      const statuses: Record<string, EngineStatus> = {};
      for (const item of page.items) statuses[item.id] = { available: item.available, tools: item.tools, ...(item.reason === undefined ? {} : { reason: item.reason }) };
      setEngineStatuses(statuses);
      setEngineReadFailed(false);
    }, () => { if (current()) setEngineReadFailed(true); });
    void sourceRead;
    void engineRead;
    return partnerRead;
  }, [api]);
  useEffect(() => {
    const generation = loadGeneration.current;
    const timer = setTimeout(() => void load().catch(() => undefined), 0);
    return () => { clearTimeout(timer); generation.value++; };
  }, [load]);
  const currentTab = tab ?? "partners";
  const scenarioCatalog = useScenarioCatalog(api, currentTab === "scenarios", load);
  const finishEdit = (message: string, partnerId?: string) => {
    setNotice(message);
    if (partnerId === undefined) { setView({ mode: "grid" }); return; }
    void load().then((items) => {
      const target = items.find((item) => item.partnerId === partnerId);
      setView(target === undefined ? { mode: "grid" } : { mode: "editor", partner: target });
    }).catch(() => setView({ mode: "grid" }));
  };
  const testPartnerModel = (partnerId: string) => {
    setModelTests((current) => ({ ...current, [partnerId]: "TESTING" }));
    void api.testPartnerModel(partnerId)
      .then((result) => setModelTests((current) => ({ ...current, [partnerId]: result })))
      .catch(() => setModelTests((current) => ({
        ...current,
        [partnerId]: { partnerId, reasonCode: "partner_model_test_failed", status: "FAILED", testedAt: new Date().toISOString() },
      })));
  };
  const readNotice = catalogReadFailed || sourceReadFailed || engineReadFailed ? <div className="inline-notice warning" role="alert">
    {catalogReadFailed ? <span>{t("partners.couldNotLoadThePartnerCatalog")}</span> : null}
    {sourceReadFailed ? <span>{t("partners.modelConfigurationUnverified")}</span> : null}
    {engineReadFailed ? <span>{t("partners.engineConfigurationUnverified")}</span> : null}
    <button className="button ghost" onClick={() => void load().catch(() => undefined)} type="button">{t("common.retry")}</button>
  </div> : null;
  if (view.mode === "editor") {
    return <section className="partner-manager page-section">
      {readNotice}
      <PartnerEditor api={api} engineStatuses={engineStatuses} key={view.partner?.partnerRevisionId ?? "new"} onDone={finishEdit} {...(onManageProviders === undefined ? {} : { onManageProviders })} partner={view.partner} sources={sources} />
    </section>;
  }
  return <section className="partner-manager page-section">
    <header className="page-title-row"><div><p className="eyebrow">{t("partners.joiPartnerCatalog")}</p><h1>{t("common.partners")}</h1><p>{t("partners.buildAReusableTeamFromPacksOrRegisterPartner")}</p></div><button className="button primary" onClick={() => { setNotice(null); setView({ mode: "editor", partner: null }); }} type="button">{t("partners.addPartner")}</button></header>
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
    {readNotice}
    <div className="tab-row" role="tablist">
      <button aria-selected={currentTab === "scenarios"} className={currentTab === "scenarios" ? "selected" : ""} onClick={() => onTabChange?.("scenarios")} role="tab" type="button">{t("partners.scenarioPresets")}</button>
      <button aria-selected={currentTab === "partners"} className={currentTab === "partners" ? "selected" : ""} onClick={() => onTabChange?.("partners")} role="tab" type="button">{t("partners.partnerCatalog")}</button>
    </div>
    {currentTab === "scenarios" ? <>
      <p className="field-hint">{t("partners.expandAPackToInstallASubteamOrThe")}</p>
      <ScenarioGrid catalog={scenarioCatalog} />
    </> : <>
      {!partnersLoaded && !catalogReadFailed ? <p role="status">{t("partners.loadingPartnerCatalog")}</p> : null}
      {partnersLoaded && partners.length === 0 ? <div className="plain-empty"><h2>{t("partners.noPartnersYet")}</h2><p>{t("partners.create23LocalOrRemoteA2aPartnersSo")}</p><button className="button primary" onClick={() => setView({ mode: "editor", partner: null })} type="button">{t("partners.addYourFirstPartner")}</button></div> : null}
      {partners.length > 0 && partners.length < 2 ? <p className="inline-notice warning">{t("partners.startWith23PartnersSoJoiHasAlternatives")}</p> : null}
      <div className="partner-grid">{partners.map((partner) => <article className="partner-card" key={partner.partnerId}>
        <div className="partner-card-head"><strong>{partner.displayName}</strong>{partner.createdBy === "joi" ? <span className="badge-joi">{t("partners.createdByJoi")}</span> : null}<span className="engine-badge">{partner.kind === "local-pi" ? t("partners.local") : t("partners.remoteA2a")} · {ENGINE_LABELS[partner.engine]}</span></div>
        {partner.description === undefined ? <p className="partner-card-desc muted">{t("partners.noDescriptionYetAddASentenceSoJoiKnows")}</p> : <p className="partner-card-desc">{partner.description}</p>}
        {partner.configuration?.status === "ACTION_REQUIRED" ? <p className="inline-notice warning" role="alert">{configurationMessage(partner.configuration.reasonCodes)}</p> : null}
        <small>{[...partner.skills, ...partner.capabilities].join(" · ") || t("partners.noCapabilitiesDeclared")}{partner.knowledgeDocCount > 0 ? t("partners.valueKnowledgeDocuments", { p0: String(partner.knowledgeDocCount) }) : ""}</small>
        {partner.status === "DISABLED" && partner.inFlightCount > 0 ? <small>{t("partners.draining")} {String(partner.inFlightCount)}  {t("partners.workItemsInProgress")}</small> : null}
        {partner.kind === "local-pi" ? <PartnerModelStatus engine={partner.engine} result={modelTests[partner.partnerId] ?? (partner.engine === "pi-core" && !sourceReadFailed ? persistedModelTest(partner, sources) : undefined)} /> : null}
        <div className="partner-card-actions">
          <label className="switch"><input aria-label={t("partners.enableOrDisableValue", { p0: partner.displayName })} checked={partner.status === "ACTIVE"} onChange={() => void api.setPartnerEnabled(partner.partnerId, partner.status !== "ACTIVE").then(() => load()).catch(() => setNotice(noticeMessage("partners.partnerStatusCouldNotBeChanged")))} type="checkbox" /><span>{partner.status === "ACTIVE" ? t("evolution.enabled") : t("status.disabled")}</span></label>
          <button className="button ghost" onClick={() => void api.duplicatePartner(partner.partnerId).then(() => load()).then(() => setNotice(noticeMessage("partners.aNewPartnerHasBeenCopiedFromThisOne"))).catch(() => setNotice(noticeMessage("partners.couldNotCopyThePartner")))} type="button">{t("partners.copy")}</button>
          {partner.kind === "local-pi" ? <button className="button ghost" disabled={modelTests[partner.partnerId] === "TESTING"} onClick={() => testPartnerModel(partner.partnerId)} type="button">{partner.engine === "pi-core" ? t("partners.testModel") : t("partners.testAvailability")}</button> : null}
          <button className="button ghost" onClick={() => { setNotice(null); setView({ mode: "editor", partner }); }} type="button">{t("common.edit")}</button>
          {partner.status === "DISABLED" ? <button className="button danger-text" disabled={partner.inFlightCount > 0} onClick={() => void api.deletePartner(partner.partnerId).then(() => load()).catch(() => setNotice(noticeMessage("partners.thisPartnerCannotBeDeletedYet")))} type="button">{t("partners.deletePartner")}</button> : null}
        </div>
      </article>)}</div>
    </>}
  </section>;
}
