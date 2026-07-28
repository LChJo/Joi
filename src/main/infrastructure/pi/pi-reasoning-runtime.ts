/* Pi hooks require Promise-returning callbacks. */
/* eslint-disable @typescript-eslint/require-await */
import { Agent, generateSummary, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

import type {
  JoiReasoningSessionSnapshot,
  PrimaryReasoningEvent,
  PrimaryReasoningRuntime,
  ReasoningSessionStore,
  StartReasoningTurnInput,
} from "../../application/ports/primary-reasoning-runtime.js";

export const JOI_REASONING_TOOL_NAMES = [
  "avatar.list_summaries",
  "avatar.select",
  "avatar.create",
  "avatar.suggest_merge",
  "avatar.suggest_archive",
  "partner.list_available",
  "partner.inspect_revision",
  "work.create",
  "work.add_dependency",
  "work.dispatch",
  "work.wait",
  "work.cancel",
  "work.reassign",
  "memory.search",
  "memory.append_candidate",
  "schedule.plan",
  "user.ask",
] as const;

const allowedToolNames = new Set<string>(JOI_REASONING_TOOL_NAMES);

interface PiReasoningRuntimeOptions {
  compaction?: {
    keepRecentMessages: number;
    maxMessages: number;
    maxSummaryCharacters: number;
  };
  model: Model<Api>;
  models: Models;
  sessionStore: ReasoningSessionStore;
  tools: AgentTool[];
}

interface SessionRuntime {
  agent: Agent;
  current: StartReasoningTurnInput | undefined;
  metadata: Omit<JoiReasoningSessionSnapshot, "messages" | "updatedAt">;
}

const DEFAULT_COMPACTION = {
  keepRecentMessages: 80,
  maxMessages: 200,
  maxSummaryCharacters: 12_000,
} as const;

type CompactionOptions = NonNullable<PiReasoningRuntimeOptions["compaction"]>;

function roleOf(message: AgentMessage): string | undefined {
  return "role" in message
    && typeof message.role === "string" ? message.role : undefined;
}

function fallbackSummary(messages: AgentMessage[], maxCharacters: number): string {
  const lines = messages.map((message) => {
    const record = message as unknown as Record<string, unknown>;
    const content = typeof record.content === "string"
      ? record.content
      : JSON.stringify(record.content);
    return `${typeof record.role === "string" ? record.role : "event"}: ${content}`;
  });
  return lines.join("\n").slice(0, maxCharacters);
}

function isCheckpoint(message: AgentMessage | undefined): boolean {
  if (message === undefined) return false;
  const record = message as unknown as Record<string, unknown>;
  return typeof record.content === "string" && record.content.startsWith("[joi session checkpoint]");
}

export class PiReasoningRuntime implements PrimaryReasoningRuntime {
  readonly #model: Model<Api>;
  readonly #models: Models;
  readonly #compaction: CompactionOptions;
  readonly #sessionStore: ReasoningSessionStore;
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #tools: AgentTool[];

  constructor(options: PiReasoningRuntimeOptions) {
    const unsafeTool = options.tools.find((tool) => !allowedToolNames.has(tool.name));
    if (unsafeTool !== undefined) throw new Error("unsafe_reasoning_tool");
    this.#model = options.model;
    this.#models = options.models;
    this.#compaction = options.compaction ?? DEFAULT_COMPACTION;
    if (this.#compaction.keepRecentMessages < 2
      || this.#compaction.maxMessages <= this.#compaction.keepRecentMessages
      || this.#compaction.maxSummaryCharacters < 80) throw new Error("reasoning_compaction_invalid");
    this.#sessionStore = options.sessionStore;
    this.#tools = [...options.tools];
  }

  async startTurn(input: StartReasoningTurnInput): Promise<void> {
    let session = this.#sessions.get(input.sessionId);
    if (session === undefined) {
      await this.restore(input.sessionId);
      session = this.#sessions.get(input.sessionId) ?? this.#createSession({
        avatarId: input.avatarId,
        modelRevisionId: input.modelRevisionId,
        sessionId: input.sessionId,
        sourceRevisionId: input.sourceRevisionId,
        systemPrompt: input.systemPrompt,
      }, []);
    }
    if (session.agent.state.isStreaming) throw new Error("reasoning_session_busy");
    if (session.metadata.avatarId !== input.avatarId) throw new Error("reasoning_session_avatar_mismatch");

    session.current = input;
    session.metadata = {
      avatarId: input.avatarId,
      compaction: session.metadata.compaction,
      modelRevisionId: input.modelRevisionId,
      sessionId: input.sessionId,
      sourceRevisionId: input.sourceRevisionId,
      systemPrompt: input.systemPrompt,
    };
    session.agent.state.systemPrompt = input.systemPrompt;
    session.agent.state.model = this.#model;
    input.onEvent?.({ type: "turn_started", turnId: input.turnId });
    try {
      await session.agent.prompt(input.prompt);
    } finally {
      await this.#compactAndSave(session);
      input.onEvent?.({ type: "turn_finished", turnId: input.turnId });
      session.current = undefined;
    }
  }

  steer(sessionId: string, text: string): void {
    const session = this.#requireSession(sessionId);
    session.agent.steer({ role: "user", content: text, timestamp: Date.now() });
  }

  followUp(sessionId: string, text: string): void {
    const session = this.#requireSession(sessionId);
    session.agent.followUp({ role: "user", content: text, timestamp: Date.now() });
  }

  abort(sessionId: string): void {
    this.#sessions.get(sessionId)?.agent.abort();
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.#sessions.get(sessionId)?.agent.waitForIdle();
  }

  isRunning(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.agent.state.isStreaming ?? false;
  }

  async restore(sessionId: string): Promise<boolean> {
    if (this.#sessions.has(sessionId)) return true;
    const snapshot = await this.#sessionStore.load(sessionId);
    if (snapshot === null) return false;
    this.#createSession({
      avatarId: snapshot.avatarId,
      compaction: snapshot.compaction,
      modelRevisionId: snapshot.modelRevisionId,
      sessionId: snapshot.sessionId,
      sourceRevisionId: snapshot.sourceRevisionId,
      systemPrompt: snapshot.systemPrompt,
    }, snapshot.messages as AgentMessage[]);
    return true;
  }

  #createSession(
    metadata: Omit<JoiReasoningSessionSnapshot, "messages" | "updatedAt">,
    messages: AgentMessage[],
  ): SessionRuntime {
    const agent = new Agent({
      beforeToolCall: async ({ toolCall }) => allowedToolNames.has(toolCall.name)
        ? undefined
        : { block: true, reason: "tool_not_allowed" },
      followUpMode: "one-at-a-time",
      initialState: {
        messages,
        model: this.#model,
        systemPrompt: metadata.systemPrompt,
        tools: this.#tools,
      },
      sessionId: metadata.sessionId,
      steeringMode: "one-at-a-time",
      streamFn: this.#models.streamSimple.bind(this.#models),
      toolExecution: "parallel",
    });
    const runtime: SessionRuntime = { agent, current: undefined, metadata };
    agent.subscribe(async (event) => {
      this.#emit(runtime, event);
    });
    this.#sessions.set(metadata.sessionId, runtime);
    return runtime;
  }

  async #compactAndSave(runtime: SessionRuntime): Promise<void> {
    const currentMessages = runtime.agent.state.messages;
    if (currentMessages.length > this.#compaction.maxMessages) {
      const targetIndex = Math.max(1, currentMessages.length - this.#compaction.keepRecentMessages);
      let firstKeptIndex = targetIndex;
      while (firstKeptIndex > 0) {
        const candidate = currentMessages[firstKeptIndex];
        if (candidate !== undefined && roleOf(candidate) === "user") break;
        firstKeptIndex -= 1;
      }
      if (firstKeptIndex > 0) {
        const previous = runtime.metadata.compaction;
        const prefix = currentMessages.slice(0, firstKeptIndex);
        const withoutCheckpoint = previous !== undefined && isCheckpoint(prefix[0])
          ? prefix.slice(1)
          : prefix;
        let generatedSummary: string | undefined;
        if (withoutCheckpoint.length > 0) {
          try {
            const generated = await generateSummary(
              withoutCheckpoint,
              this.#models,
              this.#model,
              Math.max(256, Math.ceil(this.#compaction.maxSummaryCharacters / 4)),
              undefined,
              "Preserve user intent, decisions, work status, identifiers, constraints, and unresolved questions. Do not invent facts.",
              previous?.summary,
            );
            if (generated.ok) generatedSummary = generated.value;
          } catch {
            // A provider failure must not prevent a bounded local checkpoint from being saved.
          }
        }
        const summary = (generatedSummary ?? fallbackSummary(prefix, this.#compaction.maxSummaryCharacters))
          .slice(0, this.#compaction.maxSummaryCharacters);
        const lastCompactedAt = new Date().toISOString();
        runtime.metadata.compaction = {
          compactedMessages: (previous?.compactedMessages ?? 0) + withoutCheckpoint.length,
          count: (previous?.count ?? 0) + 1,
          lastCompactedAt,
          summary,
        };
        runtime.agent.state.messages = [{
          content: `[joi session checkpoint]\n${summary}`,
          role: "user",
          timestamp: Date.parse(lastCompactedAt),
        }, ...currentMessages.slice(firstKeptIndex)];
      }
    }
    await this.#sessionStore.save({
      ...runtime.metadata,
      messages: runtime.agent.state.messages,
      updatedAt: new Date().toISOString(),
    });
  }

  #emit(runtime: SessionRuntime, event: Parameters<Parameters<Agent["subscribe"]>[0]>[0]): void {
    const active = runtime.current;
    if (active?.onEvent === undefined) return;
    let mapped: PrimaryReasoningEvent | undefined;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      mapped = { type: "text_delta", delta: event.assistantMessageEvent.delta, turnId: active.turnId };
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      mapped = { type: "thinking_delta", delta: event.assistantMessageEvent.delta, turnId: active.turnId };
    } else if (event.type === "tool_execution_start") {
      mapped = { type: "tool_started", toolCallId: event.toolCallId, toolName: event.toolName, turnId: active.turnId };
    } else if (event.type === "tool_execution_end") {
      mapped = { type: "tool_finished", isError: event.isError, toolCallId: event.toolCallId, toolName: event.toolName, turnId: active.turnId };
    }
    if (mapped !== undefined) active.onEvent(mapped);
  }

  #requireSession(sessionId: string): SessionRuntime {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error("reasoning_session_not_found");
    return session;
  }
}
