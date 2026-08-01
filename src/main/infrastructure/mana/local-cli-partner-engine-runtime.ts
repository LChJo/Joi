import type {
  AgentConversation,
  ConversationOptions,
  ConversationStore,
  Query,
  QueryInput,
} from "@rd-efficiency/agentsdk";

import { DomainError } from "../../domain/errors.js";
import type { PartnerEngine, PartnerRevision } from "../../domain/partners/partner.js";
import type { PartnerPromptStore, PartnerRunRequest, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerEngineRuntime, ResidentTurnInput, ResidentTurnResult } from "../../application/ports/partner-instances.js";
import { resolveLocalCliExecutable, type LocalCliProtocol, type ResolvedLocalCliExecutable } from "./local-cli-executable-resolver.js";

/** Curated native tool names offered in the per-engine whitelist picker. */
export const CLAUDE_CODE_TOOL_OPTIONS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit"] as const;
export const CODEX_TOOL_OPTIONS = ["shell", "apply_patch", "web_search"] as const;

/** Injectable SDK seam so contract tests never touch the real CLI binary. */
export interface LocalCliSdkSurface {
  createConversation(options?: ConversationOptions): Promise<AgentConversation>;
  query(input: QueryInput): Query;
  resumeConversation(conversationId: string, options?: ConversationOptions): Promise<AgentConversation>;
}

/**
 * Local CLI partner engine: drives the user's installed Claude Code / Codex via
 * the same-source Agent SDK, using the CLI's own login / forwarding / subscription
 * config (no provider is injected). A tool whitelist, when set, is enforced through
 * the SDK's allowedTools. Resident turns keep a warm conversation per instance and
 * resume across restarts via the persisted conversation id + ConversationStore.
 */
export class LocalCliPartnerEngineRuntime implements PartnerEngineRuntime {
  readonly #warm = new Map<string, AgentConversation>();
  #surface: LocalCliSdkSurface | null = null;

  constructor(private readonly dependencies: {
    maxWarmConversations?: number;
    prompts: Pick<PartnerPromptStore, "read">;
    protocol: LocalCliProtocol;
    resolveExecutable?: (protocol: LocalCliProtocol) => ResolvedLocalCliExecutable;
    sdk?: LocalCliSdkSurface;
    store: ConversationStore;
  }) {}

  #resolve(): ResolvedLocalCliExecutable {
    return (this.dependencies.resolveExecutable ?? resolveLocalCliExecutable)(this.dependencies.protocol);
  }

  engineOf(): PartnerEngine {
    return this.dependencies.protocol === "codex" ? "codex" : "claude-code";
  }

  toolOptions(): readonly string[] {
    return this.dependencies.protocol === "codex" ? CODEX_TOOL_OPTIONS : CLAUDE_CODE_TOOL_OPTIONS;
  }

  health(): Promise<{ available: boolean; reason?: string }> {
    const resolved = this.#resolve();
    return Promise.resolve(resolved.executablePath === undefined
      ? { available: false, reason: `${resolved.commandName} 未在 PATH 中找到，无法使用本地 ${this.dependencies.protocol === "codex" ? "Codex" : "Claude Code"} 引擎。` }
      : { available: true });
  }

  evictFromMemory(instanceId: string): void {
    const conversation = this.#warm.get(instanceId);
    this.#warm.delete(instanceId);
    if (conversation !== undefined) void conversation.close().catch(() => undefined);
  }

  async runEphemeral(request: PartnerRunRequest, revision: PartnerRevision, context: { knowledgeSection: string; skillSection: string }): Promise<{ externalRunId: string; status: PartnerRunStatus }> {
    const resolved = this.#resolve();
    const workspaceRef = this.#readyWorkspace(revision, resolved);
    const surface = await this.#sdkSurface();
    const systemPrompt = await this.#systemPrompt(revision, request, context);
    const status = await this.#drain(surface.query({
      options: this.#queryOptions(revision, systemPrompt, workspaceRef, resolved),
      prompt: request.taskProjection,
    }));
    return { externalRunId: `local_cli:${request.actionId}`, status };
  }

  async runResidentTurn(input: ResidentTurnInput): Promise<ResidentTurnResult> {
    const resolved = this.#resolve();
    const workspaceRef = this.#readyWorkspace(input.revision, resolved);
    const surface = await this.#sdkSurface();
    const systemPrompt = await this.#systemPrompt(input.revision, input.request, { knowledgeSection: input.knowledgeSection, skillSection: input.skillSection });
    let conversation = this.#warm.get(input.instanceId);
    if (conversation === undefined) {
      const options: ConversationOptions = {
        backend: "claude",
        cwd: workspaceRef,
        metadata: { instanceId: input.instanceId, surface: "joi-partner" },
        ...(input.revision.engineModelId === undefined ? {} : { model: input.revision.engineModelId }),
        projectKey: `joi:${input.revision.partnerId}`,
        queryOptions: this.#queryOptions(input.revision, systemPrompt, workspaceRef, resolved),
        store: this.dependencies.store,
        turns: "resident",
      };
      if (input.externalSessionRef !== undefined) {
        try {
          conversation = await surface.resumeConversation(input.externalSessionRef, options);
        } catch {
          conversation = undefined;
        }
      }
      conversation ??= await surface.createConversation(options);
      this.#trackWarm(input.instanceId, conversation);
    }
    const status = await this.#drain(conversation.send(input.request.taskProjection));
    const messages = await conversation.messages();
    return {
      externalRunId: `local_cli:${input.request.actionId}`,
      externalSessionRef: conversation.id,
      messages: [messages],
      status,
    };
  }

  /** Workspace invariant shared by both run modes (local CLI needs a cwd and a detected binary). */
  #readyWorkspace(revision: PartnerRevision, resolved: ResolvedLocalCliExecutable): string {
    if (resolved.executablePath === undefined) {
      throw new DomainError("engine_unavailable", `${resolved.commandName} 未在 PATH 中找到，无法使用本地 ${this.dependencies.protocol === "codex" ? "Codex" : "Claude Code"} 引擎。`);
    }
    if (revision.kind !== "local-pi") throw new DomainError("local_partner_kind_required", "Local CLI engines run local partners only.");
    if (revision.workspaceRef === undefined) throw new DomainError("partner_workspace_required", "Local CLI partners need a workspace path.");
    return revision.workspaceRef;
  }

  async #sdkSurface(): Promise<LocalCliSdkSurface> {
    if (this.dependencies.sdk !== undefined) return this.dependencies.sdk;
    this.#surface ??= await import("@rd-efficiency/agentsdk");
    return this.#surface;
  }

  async #systemPrompt(revision: PartnerRevision, request: PartnerRunRequest, context: { knowledgeSection: string; skillSection: string }): Promise<string> {
    const engineLabel = this.dependencies.protocol === "codex" ? "Codex" : "Claude Code";
    let configuredPrompt = `You are a local ${engineLabel} coding partner. Work only inside the assigned workspace and complete the requested work.`;
    if (revision.promptRef !== undefined) {
      const stored = await this.dependencies.prompts.read(revision.promptRef);
      if (stored === null) throw new DomainError("partner_prompt_not_found", "Partner prompt is missing.");
      configuredPrompt = stored;
    }
    return [
      configuredPrompt,
      "Never access paths outside the assigned workspace.",
      `Avatar scope: ${request.avatarId}`,
      `Work item: ${request.workId}`,
      ...(context.skillSection === "" ? [] : [context.skillSection]),
      ...(context.knowledgeSection === "" ? [] : [context.knowledgeSection]),
    ].join("\n");
  }

  #queryOptions(revision: PartnerRevision, systemPrompt: string, workspaceRef: string, resolved: ResolvedLocalCliExecutable): Record<string, unknown> {
    const options: Record<string, unknown> = {
      cwd: workspaceRef,
      permissionMode: "acceptEdits",
      protocol: this.dependencies.protocol,
      systemPrompt,
    };
    if (resolved.executablePath !== undefined) {
      options.pathToAgentExecutable = resolved.executablePath;
      if (this.dependencies.protocol === "claude") options.pathToClaudeCodeExecutable = resolved.executablePath;
    }
    if (revision.engineModelId !== undefined) options.model = revision.engineModelId;
    if (revision.tools.length > 0) options.allowedTools = [...revision.tools];
    return options;
  }

  async #drain(stream: AsyncIterable<{ subtype?: string; type: string }>): Promise<PartnerRunStatus> {
    let status: PartnerRunStatus = "COMPLETED";
    for await (const message of stream) {
      if (message.type === "result" && message.subtype !== "success") status = "FAILED";
    }
    return status;
  }

  #trackWarm(instanceId: string, conversation: AgentConversation): void {
    this.#warm.set(instanceId, conversation);
    const max = this.dependencies.maxWarmConversations ?? 8;
    while (this.#warm.size > max) {
      const oldest = this.#warm.keys().next();
      if (oldest.done) break;
      const evicted = this.#warm.get(oldest.value);
      this.#warm.delete(oldest.value);
      if (evicted !== undefined) void evicted.close().catch(() => undefined);
    }
  }
}
