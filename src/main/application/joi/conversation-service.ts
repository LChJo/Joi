import { DomainError } from "../../domain/errors.js";
import { CONVERSATION_PI_EXTENSIONS,CONVERSATION_TITLE_MAX_LENGTH,isConversationPiExtensions,type SendConversationInput,type ConversationDto,type ConversationInheritanceDto } from "../../../shared/conversations.js";
import type { ConversationStore } from "../ports/conversations.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { WorkbenchCatalog, WorkbenchContextSnapshotStore, WorkbenchWorkspaceRepository } from "../ports/workbench-context.js";
import type { PartnerRegistryRepository } from "../ports/partner-registry.js";
import type { PartnerInstanceManager } from "../partners/partner-instance-manager.js";
import type { PartnerSkillCatalog } from "../ports/partner-skills.js";
import { normalizeAgentConversationEntries, sanitizeAgentConversationText, type AgentConversationDraft } from "../partners/agent-conversation-presentation.js";
import type { ConversationContextDto,ConversationTurnDto,ConversationUpdateDto } from "../../../shared/conversations.js";
import type { ConversationSubagentPort } from "../ports/conversation-subagents.js";
import { ConversationActivity } from "./conversation-activity.js";
import { partnerRunFailureFromError,partnerRunArtifactsFromError,wrapPartnerRunFailure } from "../partners/partner-run-failure.js";

const PUBLIC_FAILURE_CODES = new Set(["timeout","connection_error","connect","rate_limited","server_error","auth_forbidden","invalid_api_key","http_401","http_403","model_access_forbidden","region_forbidden",
  "invalid_model","unsupported_parameter","invalid_request","model_refused","context_too_large","model_context_budget_exhausted","partner_run_timed_out","partner_run_idle_timed_out",
  "partner_tool_timed_out","partner_run_stalled","workspace_write_forbidden","partner_tool_not_allowed","conversation_session_invalid","conversation_persistence_failed",
  "conversation_revision_missing","workbench_not_found","conversation_interrupted","conversation_cleanup_timed_out","partner_worker_exited","partner_worker_unavailable"]);

function conversationFailure(error: unknown) {
  const failure = partnerRunFailureFromError(error);
  const reasonCode = failure.reasonCode === "http_408" ? "timeout" : failure.reasonCode === "http_429" ? "rate_limited"
    : /^http_5\d\d$/u.test(failure.reasonCode) ? "server_error" : PUBLIC_FAILURE_CODES.has(failure.reasonCode) ? failure.reasonCode
    : /^(?:E(?:CONN|NET|HOST|AI_|TIMEDOUT|NOTFOUND)|UND_ERR_)/u.test(failure.reasonCode) ? "connection_error" : "conversation_execution_failed";
  return { phase: failure.phase,reasonCode,retryable: reasonCode !== "conversation_execution_failed" && failure.retryable,sideEffectState: failure.sideEffectState };
}

interface Lease { generation: number; workspaceRef: string; workId: string; }
export interface ConversationLeasePort {
  acquire(input: { accessMode: "READ" | "WRITE"; workId: string; workspaceRef: string }): Promise<Lease | null>;
  renew(input: Lease): Promise<Lease | null>;
  requestWrite(input: Lease): Promise<Lease | null>;
  release(workId: string, generation?: number): Promise<void>;
  cancelWait(workId: string): Promise<void>;
}
export interface ConversationInheritancePort {
  read(workbenchId: string, partnerId: string, networkId: string): Promise<ConversationInheritanceDto & { instructions: string }>;
}
interface Network { sourceId: string; displayName: string;activeSourceRevisionId?: string; activeModel: { id: string;revisionId?: string }; status: string; }

function identity(value: string): void {
  if (!/^[a-z0-9_-]{1,160}$/iu.test(value)) throw new DomainError("conversation_identity_invalid", "Conversation identity is invalid.");
}

export class ConversationService {
  readonly #active = new Map<string,{ controller: AbortController;done: Promise<undefined> }>();
  readonly #listeners = new Map<string,Set<(update: ConversationUpdateDto) => void>>();
  #closed = false;
  constructor(private readonly dependencies: {
    clock: Clock; ids: IdGenerator; store: ConversationStore;
    workbenches: WorkbenchCatalog;
    workspaces: Pick<WorkbenchWorkspaceRepository, "getWorkspace">;
    contexts: WorkbenchContextSnapshotStore;
    revisions: Pick<PartnerRegistryRepository, "getActive">;
    instances: Pick<PartnerInstanceManager, "dispatch"> & Partial<Pick<PartnerInstanceManager,"abandonSuspended">>;
    networks: { list(): Promise<Network[]> };
    skills: Pick<PartnerSkillCatalog, "validateRefs">;
    inheritance: ConversationInheritancePort;
    attachments?: { validate(ids: string[]): Promise<void>; stage(input: { ids: string[]; turnId: string }): Promise<string> };
    subagents?: Pick<ConversationSubagentPort,"list" | "cancel">;
  }) {}
  list(archived = false) { return this.dependencies.store.list(archived); }
  subscribe(id: string,listener: (update: ConversationUpdateDto) => void): () => void {
    identity(id);
    const listeners = this.#listeners.get(id) ?? new Set();
    listeners.add(listener);this.#listeners.set(id,listeners);
    return () => { listeners.delete(listener);if (listeners.size === 0) this.#listeners.delete(id); };
  }
  #publish(update: ConversationUpdateDto): void {
    for (const listener of this.#listeners.get(update.conversationId) ?? []) {
      try { listener(update); } catch { /* Observers cannot interrupt conversation execution. */ }
    }
  }
  async rename(id: string,title: string) {
    identity(id);
    if (typeof title !== "string" || title.trim() === "" || title.trim().length > CONVERSATION_TITLE_MAX_LENGTH || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)) {
      throw new DomainError("conversation_title_invalid","Enter a title of 1 to 80 characters on one line.");
    }
    return this.dependencies.store.rename(id,sanitizeAgentConversationText(title.trim()),this.dependencies.clock.now().toISOString());
  }
  page(id: string,cursor?: string,limit?: number) { return this.dependencies.store.page(id,cursor,limit); }
  events(id: string,cursor?: string) { return this.dependencies.store.events(id,cursor); }
  async cancelChild(id: string,childId: string) {
    const conversation = await this.get(id),parent = conversation.turns.at(-1);
    if (parent === undefined || !(await this.dependencies.subagents?.list(parent.turnId))?.some(child => child.childId === childId)) throw new DomainError("subagent_not_found","Child does not belong to this conversation turn.");
    await this.dependencies.subagents?.cancel(parent.turnId,childId);
  }
  async archive(id: string) { identity(id);await this.dependencies.store.setState(id,"ARCHIVED",this.dependencies.clock.now().toISOString()); }
  async restore(id: string) { identity(id);await this.dependencies.store.setState(id,"ACTIVE",this.dependencies.clock.now().toISOString()); }
  async delete(id: string) { identity(id);await this.dependencies.store.setState(id,"DELETED",this.dependencies.clock.now().toISOString()); }
  async get(id: string): Promise<ConversationDto> {
    const item = await this.dependencies.store.get(id);
    if (item === null) throw new DomainError("conversation_not_found", "Conversation was not found.");
    return item;
  }
  async inheritance(workbenchId: string, partnerId: string, networkId: string): Promise<ConversationInheritanceDto> {
    const value = await this.dependencies.inheritance.read(workbenchId,partnerId,networkId);
    return { memoryCount: value.memoryCount,evolutionRevisionId: value.evolutionRevisionId };
  }
  async send(input: SendConversationInput) {
    if (this.#closed) throw new DomainError("conversation_stopped", "Conversation execution has been stopped. Restart Joi to continue.");
    identity(input.conversationId); identity(input.requestId);
    if (typeof input.text !== "string" || input.text.trim() === "" || input.text.length > 64_000) throw new DomainError("conversation_text_invalid", "Enter a message of at most 64000 characters.");
    if (!Array.isArray(input.skills) || !Array.isArray(input.attachmentIds) || input.skills.length > 64 || input.attachmentIds.length > 16
      || [...input.skills,...input.attachmentIds].some(s => typeof s !== "string" || s.length > 240)) throw new DomainError("conversation_selection_invalid", "Conversation selections are invalid.");
    if (input.subagentsEnabled !== undefined && typeof input.subagentsEnabled !== "boolean") throw new DomainError("conversation_selection_invalid","Child agent selection is invalid.");
    if (input.piExtensions !== undefined && !isConversationPiExtensions(input.piExtensions)) throw new DomainError("conversation_selection_invalid","Pi extension selection is invalid.");
    const piExtensions = CONVERSATION_PI_EXTENSIONS.filter(id => input.piExtensions?.includes(id));
    const prior = await this.dependencies.store.request(input.requestId);
    if (prior !== null) {
      if (prior.conversation.conversationId !== input.conversationId || prior.conversation.workbenchId !== input.workbenchId || prior.text !== input.text.trim()
        || prior.turn.config.partnerId !== input.partnerId || prior.turn.config.networkId !== input.networkId
        || (prior.turn.config.subagentsEnabled ?? true) !== (input.subagentsEnabled ?? true)
        || JSON.stringify(CONVERSATION_PI_EXTENSIONS.filter(id => prior.turn.config.piExtensions?.includes(id))) !== JSON.stringify(piExtensions)
        || JSON.stringify(prior.turn.config.skills) !== JSON.stringify(input.skills) || JSON.stringify(prior.turn.config.attachmentIds) !== JSON.stringify(input.attachmentIds)) throw new DomainError("conversation_request_conflict", "Request identity is already in use.");
      return prior.conversation;
    }
    if (this.#active.has(input.conversationId)) throw new DomainError("conversation_busy","The preceding turn is still settling.");
    const existing = await this.dependencies.store.get(input.conversationId);
    if (existing !== null && existing.workbenchId !== input.workbenchId) throw new DomainError("conversation_workbench_locked", "The conversation workbench cannot be changed.");
    const revision = await this.dependencies.revisions.getActive(input.partnerId);
    if (revision?.status !== "ACTIVE" || revision.kind !== "local-pi") throw new DomainError("conversation_partner_unavailable", "Select an active local partner.");
    if (revision.engine !== "pi-core" && piExtensions.length > 0) throw new DomainError("conversation_selection_invalid","Pi extensions require a Pi partner.");
    const network = (await this.dependencies.networks.list()).find(n => n.sourceId === input.networkId);
    if (revision.engine === "pi-core" && network?.status !== "READY") throw new DomainError("model_source_not_ready", "Select a ready model network from Settings.");
    this.dependencies.skills.validateRefs(revision.engine,input.skills);
    if (input.attachmentIds.length > 0) {
      if (this.dependencies.attachments === undefined) throw new DomainError("conversation_attachments_unavailable", "Attachments are unavailable.");
      await this.dependencies.attachments.validate(input.attachmentIds);
    }
    const workspace = await this.dependencies.workspaces.getWorkspace(input.workbenchId);
    if (workspace?.status !== "READY") throw new DomainError("workbench_workspace_not_ready", "Bind a workbench working directory first.");
    // Removing the optional override enforces Settings as the sole owner of Pi model choice.
    const base = { ...revision };
    delete base.modelIdOverride; delete base.modelSourceId;
    return this.dependencies.store.submit({ conversationId: input.conversationId,workbenchId: input.workbenchId,
      turnId: this.dependencies.ids.next("chat_turn"),requestId: input.requestId,text: input.text.trim(),at: this.dependencies.clock.now().toISOString(),
      revision: { ...base,skills: [...input.skills],...(revision.engine === "pi-core" ? { modelSourceId: input.networkId } : {}) },
      config: { partnerId: revision.partnerId,partnerName: revision.displayName,
        networkId: revision.engine === "pi-core" ? input.networkId : "native",networkName: revision.engine === "pi-core" ? network?.displayName ?? "" : revision.engine,
        modelName: revision.engine === "pi-core" ? network?.activeModel.id ?? "" : revision.engineModelId ?? revision.engine,
        ...(revision.engine !== "pi-core" || network?.activeSourceRevisionId === undefined || network.activeModel.revisionId === undefined ? {} : { sourceRevisionId: network.activeSourceRevisionId,modelRevisionId: network.activeModel.revisionId }),
        subagentsEnabled: input.subagentsEnabled ?? true,piExtensions,skills: [...input.skills],attachmentIds: [...input.attachmentIds] } });
  }
  async stop(id: string) {
    await this.get(id);
    const active = this.#active.get(id);
    active?.controller.abort();
    await active?.done;
    await this.dependencies.store.stop(id);
    const conversation = await this.get(id),turn = conversation.turns.at(-1);
    if (turn !== undefined) this.#publish({ conversationId: id,turn,...(conversation.context === undefined ? {} : { context: conversation.context }) });
  }
  close(): void { this.#closed = true; for (const active of this.#active.values()) active.controller.abort(); }
  async emergencyStop(): Promise<void> { this.close();await Promise.all([...this.#active.values()].map(active => active.done));await this.dependencies.store.stopAll(); }

  async deliver(turnId: string): Promise<void> {
    const record = await this.dependencies.store.turn(turnId);
    if (record?.turn.status !== "QUEUED") return;
    const workspace = await this.dependencies.workspaces.getWorkspace(record.conversation.workbenchId);
    if (workspace?.status !== "READY") throw new DomainError("workbench_workspace_not_ready", "Workbench workspace is unavailable.");
    if (this.#closed || this.#active.has(record.conversation.conversationId)) return;
    const controller = new AbortController();
    const completion = Promise.withResolvers<undefined>();
    this.#active.set(record.conversation.conversationId,{ controller,done: completion.promise });
    let entries: ConversationTurnDto["entries"] = [];
    let baseEntries: ConversationTurnDto["entries"] = [];
    const activity = new ConversationActivity(turnId,() => this.dependencies.clock.now().toISOString());
    let acceptingActivity = true,writes = Promise.resolve();
    let artifacts: ConversationTurnDto["artifacts"] = [];
    let suspendedInstanceId: string | undefined;
    let lastFlush = 0;
    let pendingFlush: ReturnType<typeof setTimeout> | undefined;
    let currentContext: ConversationContextDto | undefined;
    const publish = (update: Pick<ConversationTurnDto,"entries" | "artifacts" | "status" | "errorCode" | "failure">,context = currentContext) => {
      this.#publish({ conversationId: record.conversation.conversationId,turn: { ...record.turn,...update },...(context === undefined ? {} : { context }) });
    };
    const flush = async (force = false): Promise<void> => {
      entries = activity.project(baseEntries);
      if (!acceptingActivity) return;
      const elapsed = this.dependencies.clock.now().getTime() - lastFlush;
      if (!force && elapsed < 100) {
        pendingFlush ??= setTimeout(() => { pendingFlush = undefined;void flush(true).catch(() => undefined); },100 - elapsed);
        return;
      }
      if (pendingFlush !== undefined) { clearTimeout(pendingFlush);pendingFlush = undefined; }
      lastFlush = this.dependencies.clock.now().getTime();
      if (currentContext !== undefined) { currentContext = { ...currentContext,activityAt: this.dependencies.clock.now().toISOString() };activity.context(currentContext);entries = activity.project(baseEntries); }
      const snapshot = entries,contextSnapshot = currentContext;
      writes = writes.catch(() => undefined).then(async () => {
        const update = { entries: snapshot,artifacts,status: "RUNNING" as const };
        await this.dependencies.store.update(turnId,update);
        if (contextSnapshot !== undefined) await this.dependencies.store.context(record.conversation.conversationId,turnId,contextSnapshot);
        publish(update,contextSnapshot);
      });
      await writes;
    };
    const progress = async (drafts: AgentConversationDraft[],force = false) => {
      baseEntries = normalizeAgentConversationEntries({ agentId: record.conversation.conversationId,runId: turnId,startedAt: record.turn.createdAt },drafts)
        .filter(e => e.role !== "USER").map(({ order,runId: _runId,artifact,...entry }) => ({ ...entry,sequence: order,
          ...(artifact === undefined ? {} : { artifact: { name: artifact.name,size: artifact.size,mimeType: artifact.mimeType,kind: "FILE" as const } }) }));
      await flush(force);
    };
    const settle = async (patch: Parameters<ConversationStore["update"]>[1]) => {
      try { await this.dependencies.store.update(turnId,patch); }
      catch { throw wrapPartnerRunFailure({ code: "conversation_persistence_failed" },{ phase: "RECOVERY",sideEffectState: "UNKNOWN" }); }
      publish(patch);
    };
    try {
      if (!await this.dependencies.store.begin(turnId)) return;
      publish({ entries,artifacts,status: "RUNNING" });
      controller.signal.throwIfAborted();
      if (record.revision === null) throw new DomainError("conversation_revision_missing", "Conversation configuration is unavailable.");
      const revision = record.revision;
      const wb = await this.dependencies.workbenches.getWorkbench(record.conversation.workbenchId);
      if (wb === null) throw new DomainError("workbench_not_found", "Workbench was not found.");
      const inherited = await this.dependencies.inheritance.read(wb.workbenchId,record.turn.config.partnerId,record.turn.config.networkId);
      const contextSnapshotId = this.dependencies.ids.next("chat_context");
      await this.dependencies.contexts.save({ contextSnapshotId,workbenchId: wb.workbenchId,workId: turnId,createdAt: record.turn.createdAt,
        personaRevisionId: wb.profile.personaRevisionId,memorySummaryRefs: [`workbench_memory:${wb.memory.namespaceId}`],workspaceRef: workspace.workspaceRef,
        safeContext: { activeWork: [],recentResults: [],workbenchName: wb.profile.name,projectLabel: wb.project.label,responsibility: wb.profile.scopeSummary,
          work: { accessMode: "WRITE",title: "Conversation",workId: turnId } } });
      let session = await this.dependencies.store.session(record.conversation.conversationId);
      const history = session === undefined ? await this.dependencies.store.history(record.conversation.conversationId,turnId) : undefined;
      const attachmentSection = await this.dependencies.attachments?.stage({ ids: record.turn.config.attachmentIds,turnId }) ?? "";
      const priorStatus = record.conversation.turns.filter(turn => turn.turnId !== turnId).at(-1)?.status;
      const requiredContext = ["Normal conversation: answer the user's current message directly. Do not create a task plan or expose internal task decomposition. Follow the partner's tool and safety policy.",
        `Workbench persona:\n${wb.profile.personaSummary}`,inherited.instructions,
        "Retain prior execution facts, including stopped or failed turns. Unrecorded tool results have unknown side effects: inspect current state before retrying any such action.",
        ...(priorStatus === undefined ? [] : [`The preceding conversation turn ended with status ${priorStatus}. This status is an execution fact, not authorization to replay its tools.`]),
        attachmentSection].filter(Boolean).join("\n\n");
      const run = (phase: "READ_RUNNING" | "WRITE_RUNNING", instanceId?: string) => {
        return this.dependencies.instances.dispatch({
        ...(instanceId === undefined ? {} : { instanceId }),signal: controller.signal,revision,
        session: { ...(session === undefined ? {} : { state: session }),save: async state => {
          await this.dependencies.store.saveSession(record.conversation.conversationId,turnId,state,this.dependencies.clock.now().toISOString());
          session = state;
        } },
        onThinking: async thinking => { if (acceptingActivity) { activity.thinking({ ...thinking,phaseId: `${phase}:${thinking.phaseId}` });await flush(true); } },
        onContext: async context => {
          if (!acceptingActivity) return;
          currentContext = { ...context,...(record.conversation.context?.missingHistory === true || history !== undefined && history.length > 0 ? { missingHistory: true } : {}),activityAt: this.dependencies.clock.now().toISOString() };
          activity.context(currentContext);
          await flush(true);
        },
        ...(record.turn.config.sourceRevisionId === undefined || record.turn.config.modelRevisionId === undefined ? {} : {
          expectedSource: { sourceId: record.turn.config.networkId,sourceRevisionId: record.turn.config.sourceRevisionId,modelRevisionId: record.turn.config.modelRevisionId },
        }),
        request: { actionId: turnId,workbenchId: wb.workbenchId,workId: turnId,contextSnapshotId,taskProjection: record.text,requiredContext,
          conversationId: record.conversation.conversationId,...(history === undefined ? {} : { conversationHistory: history }),
          conversationAttachmentContext: attachmentSection,
          subagentsEnabled: record.turn.config.subagentsEnabled ?? true,
          piExtensions: record.turn.config.piExtensions ?? [],
          workspaceExecution: { accessCeiling: "WRITE",generation: phase === "READ_RUNNING" ? 1 : 2,phase } },
        onConversation: p => progress(p.conversation()),
      }); };
      let result = await run("READ_RUNNING");
      if (result.status === "SUSPENDED") {
        if (result.instanceId === undefined || result.checkpointRef === undefined) throw new DomainError("workspace_checkpoint_missing", "Write checkpoint is unavailable.");
        suspendedInstanceId = result.instanceId;
        controller.signal.throwIfAborted();
        result = await run("WRITE_RUNNING",result.instanceId);
        suspendedInstanceId = undefined;
      }
      controller.signal.throwIfAborted();
      if (result.conversation !== undefined) await progress(result.conversation);
      if (!entries.some(e => e.kind === "MARKDOWN" && e.role === "AGENT") && result.body !== "") await progress([{ kind: "MARKDOWN",role: "AGENT",text: result.body }]);
      if (result.pendingQuestion !== undefined) await progress([{ kind: "MARKDOWN",role: "AGENT",text: result.pendingQuestion }]);
      artifacts = result.artifacts.map(a => ({ name: sanitizeAgentConversationText(a.name),size: a.size,...(a.mimeType === undefined ? {} : { mimeType: a.mimeType }) }));
      acceptingActivity = false;activity.interrupt();entries = activity.project(baseEntries);await writes.catch(() => undefined);
      await settle({ entries,artifacts,status: result.status === "COMPLETED" || result.status === "WAITING_INPUT" ? "COMPLETED" : "FAILED",
        ...(result.status === "COMPLETED" || result.status === "WAITING_INPUT" ? {} : { errorCode: "conversation_execution_failed" }) });
    } catch (error) {
      acceptingActivity = false;activity.interrupt();entries = activity.project(baseEntries);await writes.catch(() => undefined);
      const failure = conversationFailure(error);
      const retainFailure = !controller.signal.aborted || failure.reasonCode === "conversation_cleanup_timed_out" || failure.reasonCode === "conversation_persistence_failed";
      const partial = partnerRunArtifactsFromError(error).map(a => ({ name: sanitizeAgentConversationText(a.name),size: a.size,...(a.mimeType === undefined ? {} : { mimeType: a.mimeType }) }));
      artifacts = [...artifacts,...partial.filter(item => !artifacts.some(existing => existing.name === item.name))];
      await settle({ entries,artifacts,status: controller.signal.aborted ? "STOPPED" : "FAILED",
        errorCode: retainFailure ? failure.reasonCode : "conversation_stopped",...(retainFailure ? { failure } : {}) });
    } finally {
      if (pendingFlush !== undefined) clearTimeout(pendingFlush);
      try {
        if (suspendedInstanceId !== undefined) await this.dependencies.instances.abandonSuspended?.({ workbenchId: record.conversation.workbenchId,instanceId: suspendedInstanceId });
      } finally { this.#active.delete(record.conversation.conversationId);completion.resolve(undefined); }
    }
  }
}
