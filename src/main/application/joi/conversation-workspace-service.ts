import type { GitCommandInput, GitCommandDto } from "../../../shared/conversations.js";
import { DomainError } from "../../domain/errors.js";
import type { ConversationWorkspacePort, GitCommandStore } from "../ports/conversation-workspace.js";
import type { WorkbenchWorkspaceRepository } from "../ports/workbench-context.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { ConversationLeasePort } from "./conversation-service.js";

export class ConversationWorkspaceService {
  #closed = false;
  readonly #active = new Map<string,AbortController>();
  constructor(private readonly dependencies: {
    clock: Clock; ids: IdGenerator; store: GitCommandStore;
    workspace: Pick<ConversationWorkspacePort, "execute">;
    leases: ConversationLeasePort;
    workspaces: Pick<WorkbenchWorkspaceRepository, "getWorkspace">;
  }) {}
  async submit(workbenchId: string,input: GitCommandInput) {
    if (this.#closed) throw new DomainError("git_stopped", "Git execution has been stopped.");
    if (!/^[a-z0-9_-]{1,160}$/iu.test(input.requestId) || !["STAGE","UNSTAGE","COMMIT","SWITCH","BRANCH","FETCH","PULL","PUSH"].includes(input.action)
      || (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.length > 500 || input.paths.some(p => typeof p !== "string" || p.length > 1024)))
      || (input.branch !== undefined && typeof input.branch !== "string") || (input.message !== undefined && (typeof input.message !== "string" || input.message.length > 4000))) throw new DomainError("git_request_invalid", "Git request is invalid.");
    const workspace = await this.dependencies.workspaces.getWorkspace(workbenchId);
    if (workspace?.status !== "READY") throw new DomainError("workbench_workspace_not_ready", "Bind a workspace first.");
    return this.dependencies.store.submit(workbenchId,input,this.dependencies.ids.next("git_command"),this.dependencies.clock.now().toISOString());
  }
  async get(id: string): Promise<GitCommandDto> {
    const record = await this.dependencies.store.get(id);
    if (record === null) throw new DomainError("git_command_not_found", "Git operation was not found.");
    return { commandId: record.commandId,status: record.status,...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }) };
  }
  async deliver(id: string) {
    if (this.#closed) return;
    const record = await this.dependencies.store.get(id);
    if (record?.status !== "QUEUED") return;
    const workspace = await this.dependencies.workspaces.getWorkspace(record.workbenchId);
    if (workspace?.status !== "READY") throw new DomainError("workbench_workspace_not_ready", "Workspace unavailable.");
    const lease = await this.dependencies.leases.acquire({ accessMode: "WRITE",workId: id,workspaceRef: workspace.workspaceRef });
    if (lease === null) throw new DomainError("workspace_busy", "Workspace is busy.");
    const controller = new AbortController();this.#active.set(id,controller);
    let renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      renewal ??= this.dependencies.leases.renew(lease).then(current => { if (current === null) controller.abort(); }).catch(() => controller.abort()).finally(() => { renewal = undefined; });
    },30_000);
    try {
      if (!await this.dependencies.store.begin(id)) return;
      try { await this.dependencies.workspace.execute(record.workbenchId,record.input,controller.signal);controller.signal.throwIfAborted(); await this.dependencies.store.finish(id); }
      catch (error) { await this.dependencies.store.finish(id,error instanceof DomainError ? error.code : "git_operation_failed"); }
    } finally { clearInterval(timer);await renewal;this.#active.delete(id);await this.dependencies.leases.release(id,lease.generation); }
  }
  async emergencyStop(): Promise<void> {
    this.#closed = true;for (const controller of this.#active.values()) controller.abort();await this.dependencies.store.stopQueued();
  }
}
