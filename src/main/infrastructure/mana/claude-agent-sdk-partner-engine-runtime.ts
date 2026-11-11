import type { Options as ClaudeOptions, SDKMessage, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { LocalWriteGate, workAccessPrompt, WORKSPACE_WRITE_CONTINUATION } from "../../application/partners/local-write-gate.js";
import { nativeCheckpointAvailable } from "./native-checkpoint-store.js";
import { NATIVE_COMPLETION_INSTRUCTION, NATIVE_COMPLETION_SCHEMA, NATIVE_COMPLETION_TOOL_NAME, parseNativeCompletion } from "./native-completion-handoff.js";

import { DomainError } from "../../domain/errors.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { WorkbenchExecutionContextReader } from "../../application/ports/workbench-context.js";
import type { NativeAgentEvent } from "../../application/ports/native-agent-events.js";
import type { PartnerPromptStore, PartnerRunOutput, PartnerRunRequest, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerEngineRuntime, PartnerExecutionContext, ResidentTurnInput, ResidentTurnResult } from "../../application/ports/partner-instances.js";
import { ConversationThinking } from "../pi/conversation-thinking.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";
import type { UsageContext, UsageRecorder } from "../../application/ports/usage.js";
import { toolCallLabel } from "../../application/partners/tool-trace-presentation.js";
import { NativeAgentEventProjector } from "../../application/partners/native-agent-event-projector.js";
import type { AgentConversationDraft } from "../../application/partners/agent-conversation-presentation.js";
import { parseNativeAgentSessionRef, toNativeAgentSessionRef } from "../../application/partners/native-agent-session-reference.js";
import { wrapPartnerRunFailure } from "../../application/partners/partner-run-failure.js";
import { captureWorkspaceSnapshot, collectChangedWorkspaceArtifacts } from "../workspace/workspace-output-artifacts.js";
import { partnerCommentDisciplineLine } from "../workspace/partner-work-discipline.js";
import { workspaceReadScopeLine, workspaceRootBoundaryLine } from "../workspace/workspace-prompt-boundary.js";
import { prepareNativeEvidenceContext } from "../workspace/work-evidence-stager.js";
import { resolveLocalCliExecutable, type ResolvedLocalCliExecutable } from "./local-cli-executable-resolver.js";
import { classifyNativeCliFailure, NativeCliRunError, settleNativeProbe, type NativeCliProbePhase } from "./native-agent-runtime-support.js";
import { RunDeadlineGuard } from "./native-run-deadlines.js";
import { beginUsage, normalizeClaudeModelUsage, type SafeUsageSession, unknownUsageObservation, usageFailureStatus } from "../usage/sdk-usage.js";
import { boundBackgroundSections, DEFAULT_BACKGROUND_BUDGET_CHARS } from "../pi/pi-model-budget.js";
import { NativeConversationJournal } from "../pi/native-conversation-journal.js";
import { conversationPrompt } from "../pi/conversation-session.js";

export const CLAUDE_CODE_TOOL_OPTIONS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit"] as const;
const CLAUDE_WORKSPACE_TOOLS = new Set(["Bash", "Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit"]);
const CLAUDE_MUTATING_TOOLS = new Set(["Bash", "Edit", "Write", "NotebookEdit"]);

export interface ClaudeAgentSdkSurface {
  query(input: { options?: ClaudeOptions; prompt: string }): AsyncIterable<SDKMessage> & { close?(): void };
}

/**
 * A readable verb for the row, derived from the tool name alone.
 *
 * ADR 0014 requires a CLI-backed call's arguments — its command, its patch — to be dropped before
 * the event port, so unlike pi there is nothing here to describe the call with. The name is still
 * enough to say what kind of action it was, which is what the timeline was missing.
 */
function describedCall(toolName: string): { summary: string } {
  return { summary: toolCallLabel(toolName) };
}

export class ClaudeAgentSdkPartnerEngineRuntime implements PartnerEngineRuntime {
  #surface: ClaudeAgentSdkSurface | undefined;

  constructor(private readonly dependencies: {
    contexts: WorkbenchExecutionContextReader;
    /** Formal run deadlines; absent keeps the legacy unbounded behavior (tests, probes). */
    deadlines?: { graceActiveWindowMillis?: number; graceMillis?: number; idleMillis?: number; totalMillis: number };
    diagnostics?: RuntimeDiagnostics;
    environment?: NodeJS.ProcessEnv;
    evidenceDirectory?: string;
    probeTimeoutMillis?: number;
    prompts: Pick<PartnerPromptStore, "read">;
    resolveExecutable?: () => ResolvedLocalCliExecutable;
    sdk?: ClaudeAgentSdkSurface;
    usage?: UsageRecorder;
  }) {}

  engineOf(): "claude-code" { return "claude-code"; }
  checkpointAvailable(reference: string): Promise<boolean> {
    return nativeCheckpointAvailable("claude", reference, this.dependencies.environment ?? process.env);
  }
  toolOptions(): readonly string[] { return CLAUDE_CODE_TOOL_OPTIONS; }
  evictFromMemory(instanceId: string): void { void instanceId; }

  health(): Promise<{ available: boolean; reason?: string }> {
    const resolved = this.#resolve();
    if (resolved.executablePath === undefined) return Promise.resolve({ available: false, reason: `${resolved.commandName} 未在 PATH 中找到，无法使用本地 Claude Code 引擎。` });
    return Promise.resolve({ available: true });
  }

  async probe(input: { modelId?: string } = {}): Promise<{ available: boolean; reasonCode?: string }> {
    const startedAt = Date.now();
    let phase: NativeCliProbePhase = "resolve";
    const settle = (result: { available: boolean; reasonCode?: string }) => settleNativeProbe(this.dependencies.diagnostics, { engine: "claude-code", phase, startedAt }, result);
    let resolved: ResolvedLocalCliExecutable;
    try { resolved = this.#resolve(); } catch (error) { return settle({ available: false, reasonCode: classifyNativeCliFailure(error) }); }
    if (resolved.executablePath === undefined) return settle({ available: false, reasonCode: "engine_unavailable" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.dependencies.probeTimeoutMillis ?? 45_000);
    let usageCapture: NativeUsageCapture | undefined;
    try {
      phase = "create";
      const sdk = await this.#sdk();
      phase = "invoke";
      usageCapture = createNativeUsageCapture(this.dependencies.usage, {
        engine: "claude-code", purpose: "probe", sourceName: "Claude Code",
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      });
      await this.#consume(sdk.query({
        prompt: "Reply with exactly OK. Do not use tools.",
        options: this.#options({ allowedTools: [], controller, ...(input.modelId === undefined ? {} : { modelId: input.modelId }), permissionMode: "plan", resolved, tools: [] }),
      }), undefined, undefined, usageCapture);
      finishNativeUsage(usageCapture, "completed");
      return settle({ available: true });
    } catch (error) {
      finishNativeUsage(usageCapture, "failed");
      return settle({ available: false, reasonCode: controller.signal.aborted ? "partner_cli_probe_timed_out" : error instanceof NativeCliRunError ? error.probeReasonCode : classifyNativeCliFailure(error) });
    } finally { clearTimeout(timer); }
  }

  async runEphemeral(request: PartnerRunRequest, revision: PartnerRevision, context: PartnerExecutionContext, options?: { signal?: AbortSignal }) {
    const tracker = { sideEffectState: "NONE" as const } as { sideEffectState: "NONE" | "OBSERVED" | "UNKNOWN" };
    try { return await this.#run(request, revision, context, undefined, tracker, options?.signal); }
    catch (error) { throw wrapPartnerRunFailure(error, { phase: error instanceof DomainError && error.code === "workspace_write_forbidden" ? "CONFIGURATION" : "ENGINE", sideEffectState: tracker.sideEffectState }); }
  }

  async runResidentTurn(input: ResidentTurnInput): Promise<ResidentTurnResult> {
    const tracker = { sideEffectState: "NONE" as const } as { sideEffectState: "NONE" | "OBSERVED" | "UNKNOWN" };
    try {
      const result = await this.#run(input.request, input.revision, input, parseNativeAgentSessionRef(input.externalSessionRef, "claude"), tracker, input.signal);
      return { ...result, ...(result.nativeSessionId === undefined ? {} : { externalSessionRef: toNativeAgentSessionRef("claude", result.nativeSessionId) }) };
    } catch (error) { throw wrapPartnerRunFailure(error, { phase: error instanceof DomainError && error.code === "workspace_write_forbidden" ? "CONFIGURATION" : "ENGINE", sideEffectState: tracker.sideEffectState }); }
  }

  async #run(request: PartnerRunRequest, revision: PartnerRevision, context: PartnerExecutionContext, resume: string | undefined, tracker: { sideEffectState: "NONE" | "OBSERVED" | "UNKNOWN" }, signal?: AbortSignal): Promise<{ conversation: AgentConversationDraft[]; externalRunId: string; nativeSessionId?: string; output: PartnerRunOutput; status: PartnerRunStatus | "SUSPENDED" }> {
    const resolved = this.#resolve();
    if (resolved.executablePath === undefined) throw new DomainError("engine_unavailable", "Claude Code is unavailable.");
    if (revision.kind !== "local-pi") throw new DomainError("local_partner_kind_required", "Claude Code runs local partners only.");
    const execution = await this.dependencies.contexts.loadForExecution(request.contextSnapshotId);
    if (execution === null) throw new DomainError("workbench_context_snapshot_not_found", "Workbench context snapshot is missing.");
    const tools = this.#effectiveTools(revision, execution.workspacePath !== undefined).filter(tool => request.workspaceExecution?.accessCeiling !== "READ" || !CLAUDE_MUTATING_TOOLS.has(tool));
    const writeGate = new LocalWriteGate(request.workspaceExecution);
    const gated = request.workspaceExecution !== undefined;
    if (request.workspaceExecution?.phase === "WRITE_RUNNING" && resume === undefined) throw new DomainError("workspace_checkpoint_missing", "The native session checkpoint is unavailable.");
    tracker.sideEffectState = !gated && tools.some((tool) => CLAUDE_MUTATING_TOOLS.has(tool)) ? "UNKNOWN" : "NONE";
    const workbenchSection = await prepareNativeEvidenceContext({
      canRead: execution.workspacePath !== undefined && tools.includes("Read"),
      ...(this.dependencies.diagnostics === undefined ? {} : { diagnostics: this.dependencies.diagnostics }),
      engine: "claude-code", execution, request,
      ...(this.dependencies.evidenceDirectory === undefined ? {} : { taskDirectory: this.dependencies.evidenceDirectory }),
    });
    const journal = new NativeConversationJournal("claude-code",request,context);
    const thinking = new ConversationThinking(context.onThinking,request.actionId);
    const history = resume === undefined ? journal.history() : "";
    const systemPrompt = await this.#systemPrompt(revision, { ...request,requiredContext: [request.requiredContext,history].filter(Boolean).join("\n\n") }, workbenchSection, context, tools, execution.workspacePath);
    const projector = new NativeAgentEventProjector();
    const emit = async (event: NativeAgentEvent): Promise<void> => {
      if (!gated && event.type === "tool_activity" && event.state === "started" && CLAUDE_MUTATING_TOOLS.has(event.toolName)) tracker.sideEffectState = "OBSERVED";
      projector.apply(event); try { await context.onEvent?.(event); } catch { /* display projection is non-authoritative */ }
      try { await context.onContext?.({ kind: "NATIVE",state: "READY" }); } catch { /* usage display is observational */ }
    };
    await emit({ type: "message", role: "user", parts: [{ type: "text", text: request.taskProjection }] });
    await emit({ type: "status", state: "working" });
    const collectArtifacts = !gated || request.workspaceExecution?.phase === "WRITE_RUNNING";
    const before = await captureWorkspaceSnapshot(collectArtifacts ? execution.workspacePath : undefined);
    const controller = new AbortController();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener("abort", () => controller.abort(), { once: true });
    let timedOut: "idle" | "total" | undefined;
    const deadlines = this.dependencies.deadlines;
    const guard = deadlines === undefined ? undefined : new RunDeadlineGuard({
      ...(deadlines.graceActiveWindowMillis === undefined ? {} : { graceActiveWindowMillis: deadlines.graceActiveWindowMillis }),
      ...(deadlines.graceMillis === undefined ? {} : { graceMillis: deadlines.graceMillis }),
      ...(deadlines.idleMillis === undefined ? {} : { idleMillis: deadlines.idleMillis }),
      onGrace: () => { emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.agent.deadline_grace", { actionId: request.actionId, graceMillis: deadlines.graceMillis ?? 0, workbenchId: request.workbenchId, workId: request.workId }); },
      onTimeout: (kind) => { timedOut = kind; controller.abort(); },
      totalMillis: deadlines.totalMillis,
    });
    let consumed: { body: string; sessionId?: string; structuredOutput?: unknown };
    const usageCapture = createNativeUsageCapture(this.dependencies.usage, {
      engine: "claude-code",
      purpose: "partner",
      workbenchId: request.workbenchId,
      workId: request.workId,
      partnerId: revision.partnerId,
      sourceName: "Claude Code",
      ...(revision.engineModelId === undefined ? {} : { modelId: revision.engineModelId }),
    });
    let checkpointSession: string | undefined;
    let query: (AsyncIterable<SDKMessage> & { close?(): void }) | undefined;
    const preToolUse: HookCallback = async hookInput => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};
      checkpointSession = hookInput.session_id;
      await journal.reference(hookInput.session_id);
      if (hookInput.tool_name !== NATIVE_COMPLETION_TOOL_NAME) await journal.tool(hookInput.tool_use_id,hookInput.tool_name,hookInput.tool_input);
      // The intrinsic completion tool emits private metadata and performs no workspace operation.
      if (hookInput.tool_name === NATIVE_COMPLETION_TOOL_NAME) return { continue: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
      const forbidden = request.workspaceExecution?.accessCeiling === "READ" && CLAUDE_MUTATING_TOOLS.has(hookInput.tool_name);
      if (forbidden) {
        if (!writeGate.denied) emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.tool_permission_denied", { workId: request.workId,actionId: request.actionId,toolName: hookInput.tool_name,reasonCode: "workspace_write_forbidden" });
        writeGate.beforeTool(hookInput.tool_name); controller.abort();
      }
      const blocked = forbidden ? { block: true, reason: "workspace_write_forbidden" } : tools.includes(hookInput.tool_name) ? writeGate.beforeTool(hookInput.tool_name) : { block: true, reason: "partner_tool_not_allowed" };
      if (blocked !== undefined) return { continue: !writeGate.suspended && !writeGate.denied, suppressOutput: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: blocked.reason } };
      if (CLAUDE_MUTATING_TOOLS.has(hookInput.tool_name)) tracker.sideEffectState = "OBSERVED";
      return { continue: true };
    };
    try {
      query = (await this.#sdk()).query({
        prompt: request.workspaceExecution?.phase === "WRITE_RUNNING" ? WORKSPACE_WRITE_CONTINUATION : conversationPrompt(request),
        options: this.#options({
          ...(gated ? { preToolUse } : {}),
          controller,
          allowedTools: tools,
          ...(execution.workspacePath === undefined ? {} : { cwd: execution.workspacePath }),
          ...(revision.engineModelId === undefined ? {} : { modelId: revision.engineModelId }),
          permissionMode: execution.workspacePath === undefined ? "plan" : "acceptEdits",
          resolved,
          ...(resume === undefined ? {} : { resume }),
          systemPrompt,
          structuredCompletion: true,
          tools,
        }),
      });
      consumed = await this.#consume(query, emit, () => guard?.onProgress(), usageCapture, true,journal,thinking);
      finishNativeUsage(usageCapture, "completed");
    } catch (error) {
      if (writeGate.suspended && checkpointSession !== undefined) {
        finishNativeUsage(usageCapture, "completed");
        return { conversation: [], externalRunId: `native_claude:${request.actionId}`, nativeSessionId: checkpointSession, output: { artifacts: [], body: "" }, status: "SUSPENDED" };
      }
      if (writeGate.denied) { finishNativeUsage(usageCapture,"failed"); await emit({ type: "status",state: "failed" }); throw new DomainError("workspace_write_forbidden", "The Work ceiling forbids this tool."); }
      finishNativeUsage(usageCapture, timedOut === undefined ? usageFailureStatus(signal) : "failed");
      if (timedOut !== undefined) {
        await emit({ type: "status", state: "failed" });
        throw new DomainError(
          timedOut === "idle" ? "partner_run_idle_timed_out" : "partner_run_timed_out",
          "The native run exceeded its deadline and was terminated.",
        );
      }
      await emit({ type: "status", state: classifyNativeCliFailure(error) === "partner_cli_auth_required" ? "auth-required" : "failed" });
      throw error;
    } finally {
      await thinking.interrupt();
      query?.close?.();
      guard?.dispose();
      await journal.save();
    }
    if (writeGate.denied) throw new DomainError("workspace_write_forbidden", "The Work ceiling forbids this tool.");
    if (writeGate.suspended) {
      const session = consumed.sessionId ?? checkpointSession;
      if (session === undefined) throw new DomainError("workspace_checkpoint_missing", "The native session checkpoint is unavailable.");
      return { conversation: [], externalRunId: `native_claude:${request.actionId}`, nativeSessionId: session, output: { artifacts: [], body: "" }, status: "SUSPENDED" };
    }
    const artifacts = collectArtifacts ? await collectChangedWorkspaceArtifacts(execution.workspacePath, before) : [];
    const completion = parseNativeCompletion(consumed.structuredOutput === undefined ? consumed.body : consumed.structuredOutput, consumed.body);
    if (completion.body !== "") await emit({ type: "message", role: "agent", parts: [{ type: "text", text: completion.body }] });
    for (const artifact of artifacts) await emit({ type: "artifact", artifact: { ...artifact, mimeType: artifact.mimeType ?? "application/octet-stream" } });
    await emit({ type: "status", state: "completed" });
    return { conversation: projector.snapshot(), externalRunId: `native_claude:${request.actionId}`, ...(consumed.sessionId === undefined ? {} : { nativeSessionId: consumed.sessionId }), output: { artifacts, ...completion }, status: "COMPLETED" };
  }

  async #consume(stream: AsyncIterable<SDKMessage>, emit?: (event: NativeAgentEvent) => Promise<void>, onProgress?: () => void, usage?: NativeUsageCapture, structuredCompletion = false,journal?: NativeConversationJournal,thinking?: ConversationThinking): Promise<{ body: string; sessionId?: string; structuredOutput?: unknown }> {
    let body = "";
    let completed = false;
    let sessionId: string | undefined;
    let streamedText = false;
    let structuredOutput: unknown;
    const toolNames = new Map<string, string>();
    const started = new Set<string>();
    const ended = new Set<string>();
    let messageIndex = 0,finalizedMessages = 0,hasThinkingFrames = false;
    const thinkingBlocks = new Set<number>();
    for await (const message of stream) {
      onProgress?.();
      const row = message as unknown as Record<string, unknown>;
      if (typeof row.session_id === "string") { sessionId = row.session_id;await journal?.reference(sessionId); }
      if (row.type === "stream_event" && row.event !== null && typeof row.event === "object") {
        const event = row.event as Record<string, unknown>;
        if (event.type === "message_start") { messageIndex++;hasThinkingFrames = false; }
        if (event.type === "content_block_stop" && typeof event.index === "number" && thinkingBlocks.delete(event.index)) await thinking?.end(`${String(messageIndex)}:${String(event.index)}`);
        if (event.type === "content_block_delta" && event.delta !== null && typeof event.delta === "object") {
          const delta = event.delta as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") { streamedText = true; body += delta.text;await journal?.delta(delta.text); if (!structuredCompletion) await emit?.({ type: "message", role: "agent", parts: [{ type: "text", text: delta.text }] }); }
        } else if (event.type === "content_block_start" && event.content_block !== null && typeof event.content_block === "object") {
          const block = event.content_block as Record<string, unknown>;
          if (block.type === "thinking" && typeof event.index === "number") {
            hasThinkingFrames = true;thinkingBlocks.add(event.index);await thinking?.start(`${String(messageIndex)}:${String(event.index)}`);
          }
          if (block.type === "tool_use" && typeof block.name === "string" && block.name !== NATIVE_COMPLETION_TOOL_NAME && typeof block.id === "string") {
            toolNames.set(block.id, block.name);
            await journal?.tool(block.id,block.name,block.input);
            started.add(block.id);
            await emit?.({ type: "tool_activity", toolCallId: block.id, toolName: block.name, state: "started", ...describedCall(block.name) });
          }
        }
      }
      if ((row.type === "assistant" || row.type === "user") && row.message !== null && typeof row.message === "object") {
        const content = (row.message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          if (row.type === "assistant") {
            finalizedMessages++;
            if (!hasThinkingFrames) for (const [index,candidate] of content.entries()) {
              if ((candidate as { type?: string }).type === "thinking") await thinking?.end(`final:${String(finalizedMessages)}:${String(index)}`);
            }
          }
          if (row.type === "assistant") await journal?.assistant(content.flatMap(candidate => {
            const block = candidate as Record<string,unknown>;
            if (block.type === "text" && typeof block.text === "string") return [{ type: "text",text: block.text }];
            if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") return [{ type: "toolCall",id: block.id,name: block.name,arguments: block.input }] as unknown[];
            return [];
          }));
          for (const candidate of content) {
            if (candidate === null || typeof candidate !== "object") continue;
            const block = candidate as Record<string, unknown>;
            if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && block.name !== NATIVE_COMPLETION_TOOL_NAME && !started.has(block.id)) {
              toolNames.set(block.id, block.name);
              await journal?.tool(block.id,block.name,block.input);
              started.add(block.id);
              // The whole block is present here, so this path always has arguments to describe.
              await emit?.({ type: "tool_activity", toolCallId: block.id, toolName: block.name, state: "started", ...describedCall(block.name) });
            } else if (block.type === "tool_result" && typeof block.tool_use_id === "string" && !ended.has(block.tool_use_id)) {
              const name = toolNames.get(block.tool_use_id);
              await journal?.tool(block.tool_use_id,name ?? "native_tool",{},typeof block.content === "string" ? block.content : JSON.stringify(block.content),block.is_error === true);
              if (name !== undefined) {
                ended.add(block.tool_use_id);
                await emit?.({ type: "tool_activity", toolCallId: block.tool_use_id, toolName: name, state: block.is_error === true ? "failed" : "completed" });
              }
            }
          }
        }
      }
      if (row.type === "result") {
        recordClaudeUsage(usage, row.modelUsage);
        if (row.subtype !== "success" || row.is_error === true) throw new NativeCliRunError(classifyNativeCliFailure(row));
        completed = true;
        structuredOutput = row.structured_output;
        if (typeof row.result === "string") {
          if (!structuredCompletion && !streamedText && row.result !== "") await emit?.({ type: "message", role: "agent", parts: [{ type: "text", text: row.result }] });
          body = row.result;
          await journal?.final(body);
        }
      }
    }
    if (!completed) throw new DomainError("local_cli_run_incomplete", "Claude Code ended without a successful result.");
    return { body, ...(sessionId === undefined ? {} : { sessionId }), ...(structuredOutput === undefined ? {} : { structuredOutput }) };
  }

  #options(input: { allowedTools?: readonly string[]; controller: AbortController; cwd?: string; modelId?: string; permissionMode: "acceptEdits" | "plan"; preToolUse?: HookCallback; resolved: ResolvedLocalCliExecutable; resume?: string; structuredCompletion?: boolean; systemPrompt?: string; tools?: readonly string[] }): ClaudeOptions {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.dependencies.environment ?? process.env)) if (value !== undefined) environment[key] = value;
    return {
      abortController: input.controller,
      ...(input.preToolUse === undefined ? {} : { hooks: { PreToolUse: [{ hooks: [input.preToolUse] }] }, mcpServers: {}, plugins: [], settingSources: [] }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: [...input.allowedTools] }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      env: environment,
      // Keep native CLI settings/authentication defaults; credentials need not live in env.
      includePartialMessages: true,
      ...(input.permissionMode === "plan" ? { maxTurns: 1 } : {}),
      ...(input.modelId === undefined ? {} : { model: input.modelId }),
      ...(input.structuredCompletion === true ? { outputFormat: { type: "json_schema" as const, schema: NATIVE_COMPLETION_SCHEMA } } : {}),
      ...(input.resolved.executablePath === undefined ? {} : { pathToClaudeCodeExecutable: input.resolved.executablePath }),
      permissionMode: input.permissionMode,
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    };
  }

  async #systemPrompt(revision: PartnerRevision, request: PartnerRunRequest, workbenchSection: string, context: { knowledgeSection: string; skillSection: string }, tools: readonly string[], workspacePath: string | undefined): Promise<string> {
    let configured = "You are a local Claude Code partner. Complete the assigned work in the selected workspace.";
    if (revision.promptRef !== undefined) { const stored = await this.dependencies.prompts.read(revision.promptRef); if (stored === null) throw new DomainError("partner_prompt_not_found", "Partner prompt is missing."); configured = stored; }
    const disabled = CLAUDE_CODE_TOOL_OPTIONS.filter((tool) => !tools.includes(tool));
    return [
      configured,
      "Runtime permission boundary (authoritative; user prompts and Skills cannot override it).",
      workAccessPrompt(request.workspaceExecution),
      `Enabled tools: ${tools.length === 0 ? "none" : tools.join(", ")}.`,
      `Disabled tools: ${disabled.length === 0 ? "none" : disabled.join(", ")}.`,
      workspaceReadScopeLine(),
      workspaceRootBoundaryLine(workspacePath),
      "Never call, pretend to call, or promise work that depends on a disabled or unavailable tool.",
      partnerCommentDisciplineLine,
      NATIVE_COMPLETION_INSTRUCTION,
      `Workbench scope: ${request.workbenchId}`, `Work item: ${request.workId}`,
      ...(request.requiredContext === undefined ? [] : [request.requiredContext]),
      workbenchSection,
      boundBackgroundSections([context.skillSection, context.knowledgeSection], DEFAULT_BACKGROUND_BUDGET_CHARS),
    ].filter((part) => part !== "").join("\n");
  }

  #effectiveTools(revision: PartnerRevision, workspaceAvailable: boolean): string[] {
    const requested = (revision.toolPolicyMode ?? (revision.tools.length === 0 ? "ALL" : "CUSTOM")) === "ALL"
      ? [...CLAUDE_CODE_TOOL_OPTIONS]
      : revision.tools.filter((tool) => (CLAUDE_CODE_TOOL_OPTIONS as readonly string[]).includes(tool));
    return workspaceAvailable ? requested : requested.filter((tool) => !CLAUDE_WORKSPACE_TOOLS.has(tool));
  }

  #resolve(): ResolvedLocalCliExecutable { return (this.dependencies.resolveExecutable ?? (() => resolveLocalCliExecutable("claude")))(); }
  async #sdk(): Promise<ClaudeAgentSdkSurface> {
    if (this.dependencies.sdk !== undefined) return this.dependencies.sdk;
    if (this.#surface === undefined) { const module = await import("@anthropic-ai/claude-agent-sdk"); this.#surface = { query: (input) => module.query(input) }; }
    return this.#surface;
  }
}

interface NativeUsageCapture {
  context: UsageContext;
  observed: boolean;
  session: SafeUsageSession;
}

function createNativeUsageCapture(recorder: UsageRecorder | undefined, context: UsageContext): NativeUsageCapture {
  return { context, observed: false, session: beginUsage(recorder, context) };
}

function recordClaudeUsage(capture: NativeUsageCapture | undefined, value: unknown): void {
  if (capture === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [modelId, modelUsage] of Object.entries(value as Record<string, unknown>)) {
    capture.session.record({ key: `model:${modelId}`, modelId, sourceName: "Claude Code", tokens: normalizeClaudeModelUsage(modelUsage) });
    capture.observed = true;
  }
}

function finishNativeUsage(capture: NativeUsageCapture | undefined, status: "canceled" | "completed" | "failed"): void {
  if (capture === undefined) return;
  if (!capture.observed) capture.session.record(unknownUsageObservation(capture.context));
  capture.session.finish(status);
}
