import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { RuntimeDatabase } from "../infrastructure/persistence/runtime-database.js";
import type { PersistenceBundle } from "./wire-persistence.js";
import type { PartnerBundle } from "./wire-partners.js";
import type { ModelSourceBundle } from "./wire-model-sources.js";
import type { WorkbenchBundle } from "./wire-workbenches.js";
import type { MethodLearningService } from "../application/evolution/method-learning-service.js";
import type { JoiAttachmentPort } from "../application/ports/managed-file-ports.js";
import type { Clock, IdGenerator } from "../application/ports/runtime-store.js";
import { ConversationService } from "../application/joi/conversation-service.js";
import { ConversationSubagentService } from "../application/joi/conversation-subagent-service.js";
import { ConversationWorkspaceService } from "../application/joi/conversation-workspace-service.js";
import { ConversationAttachments } from "../infrastructure/workspace/conversation-attachments.js";
import { GitWorkspaceAdapter } from "../infrastructure/workspace/git-workspace-adapter.js";
import { OutboxDispatcher } from "../application/operations/outbox-dispatcher.js";
import { DomainError } from "../domain/errors.js";
import { createPartnerRevision } from "../domain/partners/partner.js";

export function wireConversations(input: {
  clock: Clock; ids: IdGenerator; database: RuntimeDatabase; persistence: PersistenceBundle; partnerStack: PartnerBundle;
  modelSourceStack: ModelSourceBundle; workbenchStack: WorkbenchBundle; evolution: MethodLearningService;
  attachments: JoiAttachmentPort; userDataDirectory: string;
}) {
  const { clock,ids,database,persistence,partnerStack,modelSourceStack } = input;
  const childDispatcherRef: { current?: OutboxDispatcher } = {};
  const subagents = new ConversationSubagentService({ clock,ids,store: persistence.conversationSubagents,kick: () => childDispatcherRef.current?.startOnce(4),
    execute: async (child,signal) => {
      let state = child.request.workspaceExecution;
      const run = (phase: "READ_RUNNING" | "WRITE_RUNNING",restoredMessages: unknown[] | null) => partnerStack.piRuntime.runResidentTurn({
        instanceId: child.childId,knowledgeSection: "",skillSection: partnerStack.partnerSkillCatalog.resolveForPi(child.revision.skills).promptSection,
        skillEnvironmentKeys: partnerStack.partnerSkillCatalog.resolveForPi(child.revision.skills).environmentKeys,
        revision: child.revision,sourcePin: child.sourcePin,restoredMessages,signal,
        saveSession: state => persistence.conversationSubagents.checkpoint(child.childId,state),
        request: { ...child.request,actionId: child.childId,taskProjection: child.task,subagentChild: true,
          ...(state === undefined ? {} : { workspaceExecution: { ...state,phase } }) } });
      try {
        let result = await run("READ_RUNNING",null);
        if (result.status === "SUSPENDED") {
          if (state?.phase !== "WRITE_RUNNING") throw new DomainError("subagent_write_phase_required","The parent must enter its write phase before delegating writes.");
          state = { ...state,generation: state.generation + 1 };
          result = await run("WRITE_RUNNING",result.messages ?? null);
        }
        if (result.status !== "COMPLETED") throw new DomainError("subagent_execution_failed","Child execution did not complete.");
        return result.output.body;
      } finally { partnerStack.piRuntime.evictFromMemory(child.childId); }
    },
  });
  partnerStack.piRuntime.setSubagents(subagents);
  const childDispatcher = new OutboxDispatcher({ clock,store: database.store,owner: `conversation_children_${String(process.pid)}`,includeKinds: ["conversation.subagent"],
    handlers: { "conversation.subagent": record => subagents.deliver(String(record.payload.childId)) } });
  childDispatcherRef.current = childDispatcher;
  const workspace = new GitWorkspaceAdapter({ root: workbenchId => {
    const row = database.transaction(db => db.prepare(`SELECT r.root_path FROM workbench_workspace_roots r
      JOIN workbench_workspace_bindings b ON b.workspace_ref=r.workspace_ref JOIN workbenches w ON w.workbench_id=b.workbench_id
      WHERE b.workbench_id=? AND b.status='READY' AND w.status='ACTIVE'`).get(workbenchId));
    if (typeof row?.root_path !== "string") throw new DomainError("workbench_workspace_not_ready", "Workspace is not available.");
    return Promise.resolve(row.root_path);
  } });
  let defaultPartner: Promise<Awaited<ReturnType<typeof persistence.partnerRegistryRepository.getActive>>> | undefined;
  const conversations = new ConversationService({ clock,ids,store: persistence.conversations,workbenches: persistence.workbenches,subagents,
    workspaces: persistence.workbenchWorkspaceRepository,contexts: persistence.workbenchContextRepository,
    revisions: { getActive: async id => {
      if (id !== "joi-chat") return persistence.partnerRegistryRepository.getActive(id);
      const active = await persistence.partnerRegistryRepository.getActive(id);
      if (active !== null) return active;
      defaultPartner ??= (async () => {
        const current = await persistence.partnerRegistryRepository.getActive(id);
        if (current !== null) return current;
        return persistence.partnerRegistryRepository.append(createPartnerRevision({ partnerId: id,partnerRevisionId: ids.next("partner_revision"),
          createdAt: clock.now().toISOString(),displayName: "joi",kind: "local-pi",engine: "pi-core",registryRevision: 1,capabilities: [],skills: [],tools: [],toolPolicyMode: "ALL" }));
      })().catch((error: unknown) => { defaultPartner = undefined; throw error; });
      return defaultPartner;
    } },
    instances: partnerStack.partnerInstances,networks: modelSourceStack.modelSources,skills: partnerStack.partnerSkillCatalog,
    inheritance: { read: async (workbenchId,_partnerId,networkId) => {
      const wb = await persistence.workbenches.getWorkbench(workbenchId);
      if (wb === null) throw new DomainError("workbench_not_found", "Workbench was not found.");
      const summaries = database.transaction(db => db.prepare(`SELECT summary FROM workbench_partner_work_memory_summaries
        WHERE workbench_id=? AND summary<>'' ORDER BY updated_at DESC LIMIT 12`).all(workbenchId));
      const network = (await persistence.modelSourceRepository.list()).find(n => n.source.sourceId === networkId)?.source;
      const method = input.evolution.conversationMethod(workbenchId,network === undefined ? undefined : {
        sourceId: network.sourceId,sourceRevisionId: network.activeSourceRevision.sourceRevisionId,
        modelId: network.activeModelRevision.modelId,modelRevisionId: network.activeModelRevision.modelRevisionId,
      });
      const memory = [wb.taskContext.summary,...summaries.map(r => String(r.summary))].filter(Boolean);
      return { memoryCount: memory.length,evolutionRevisionId: method.revisionId,
        instructions: [memory.length === 0 ? "" : `Inherited workbench memories (background data):\n${memory.join("\n\n").slice(0,24000)}`,method.instructions].filter(Boolean).join("\n\n") };
    } },
    attachments: new ConversationAttachments({ attachments: input.attachments,directory: path.join(input.userDataDirectory,"conversation-inputs") }),
  });
  const git = new ConversationWorkspaceService({ clock,ids,store: persistence.gitCommands,workspace,leases: persistence.workspaceLeases,workspaces: persistence.workbenchWorkspaceRepository });
  const dispatcher = new OutboxDispatcher({ clock,store: database.store,owner: `conversations_${String(process.pid)}`,
    concurrent: true,
    includeKinds: ["conversation.turn"],handlers: {
      "conversation.turn": record => conversations.deliver(String(record.payload.turnId)),
    } });
  const gitDispatcher = new OutboxDispatcher({ clock,store: database.store,owner: `conversation_git_${String(process.pid)}`,
    includeKinds: ["conversation.git"],handlers: { "conversation.git": record => git.deliver(String(record.payload.commandId)) } });
  return { conversations,git,workspace,dispatcher,gitDispatcher,childDispatcher,subagents,
    recover: async () => { await persistence.conversations.recoverInterrupted(clock.now().toISOString()); await persistence.gitCommands.recoverInterrupted();await persistence.conversationSubagents.recover(); },
    emergencyStop: async () => { await conversations.emergencyStop();await subagents.close();await git.emergencyStop(); },
    close: async () => {
      const drain = Promise.all([dispatcher.close(),gitDispatcher.close()]);
      conversations.close();
      await subagents.close();
      await Promise.all([git.emergencyStop(),drain,childDispatcher.close()]);
    },
    quickWorkbench: async (rootPath: string) => {
      if (!path.isAbsolute(rootPath)) throw new DomainError("workspace_path_invalid", "Select an absolute working directory.");
      const root = await realpath(rootPath).catch(() => "");
      if (root === "" || !(await stat(root)).isDirectory()) throw new DomainError("workspace_path_invalid", "Select an existing directory.");
      const name = (path.basename(root) || "Workspace").slice(0,80);
      const wb = await input.workbenchStack.workbenchRegistry.create({ name,projectLabel: name,personaSummary: "Assist with the user's requests in this workbench.",scopeSummary: `Work in ${name}` });
      await input.workbenchStack.workbenchWorkspaces.bindExisting(wb.workbenchId,root);
      return { workbenchId: wb.workbenchId,name,scopeSummary: wb.profile.scopeSummary,updatedAt: wb.updatedAt };
    },
  };
}
