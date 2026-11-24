import type { AgentTool } from "@earendil-works/pi-agent-core";

import type {
  PrimaryReasoningRuntime,
  ReasoningSessionStore,
  StartReasoningTurnInput,
} from "../../application/ports/primary-reasoning-runtime.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { JoiSkillContext } from "./joi-skill-runtime.js";
import { PiReasoningRuntime } from "./pi-reasoning-runtime.js";
import type { RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import type { PiNativeSessionStore } from "./pi-native-session-store.js";
import type { HistoricalMemoryReader } from "../../application/ports/historical-memory.js";

/** One global runtime facade whose individual Workbench sessions use their pinned source revision. */
export class ConfiguredPiReasoningRuntime implements PrimaryReasoningRuntime {
  readonly #skillTools = new Map<string, AgentTool[]>();
  readonly #runtimes = new Map<string, { runtime: PiReasoningRuntime; revision: string }>();
  readonly #starting = new Set<string>();
  readonly #canceledStartup = new Set<string>();

  constructor(private readonly dependencies: {
    diagnostics?: RuntimeDiagnostics;
    recordEvidenceContext?: (turnId: string, toolCallIds: string[]) => void;
    usage?: UsageRecorder;
    nativeSessions?: PiNativeSessionStore;
    resolver: PiConfiguredModelResolver;
    skills?: { prepare(): Promise<JoiSkillContext> };
    memory?: HistoricalMemoryReader;
    sessionStore: ReasoningSessionStore;
    tools: AgentTool[] | ((input: StartReasoningTurnInput) => AgentTool[]);
  }) {}

  async startTurn(input: StartReasoningTurnInput): Promise<void> {
    if (this.isRunning(input.sessionId)) throw new Error("reasoning_session_busy");
    this.#starting.add(input.sessionId);
    try { await this.#startTurn(input); } finally { this.#starting.delete(input.sessionId); this.#canceledStartup.delete(input.sessionId); }
  }

  async #startTurn(input: StartReasoningTurnInput): Promise<void> {
    const skills = await this.dependencies.skills?.prepare();
    if (this.#canceledStartup.has(input.sessionId)) return;
    let selected = this.#runtimes.get(input.sessionId);
    const revision = `${input.sourceRevisionId}:${input.modelRevisionId}`;
    if (selected?.revision !== revision) {
      const resolved = await this.dependencies.resolver.resolve(input);
      if (this.#canceledStartup.has(input.sessionId)) return;
      const runtime = new PiReasoningRuntime({
        ...(this.dependencies.memory === undefined ? {} : { memory: this.dependencies.memory }),
        ...(this.dependencies.nativeSessions === undefined ? {} : { nativeSessions: this.dependencies.nativeSessions }),
        ...(this.dependencies.diagnostics === undefined ? {} : { diagnostics: this.dependencies.diagnostics }),
        ...(this.dependencies.recordEvidenceContext === undefined ? {} : { recordEvidenceContext: this.dependencies.recordEvidenceContext }),
        ...(this.dependencies.usage === undefined ? {} : { usage: this.dependencies.usage }),
        model: resolved.model,
        ...(resolved.compactionThresholdPercent === undefined ? {} : { compactionThresholdPercent: resolved.compactionThresholdPercent }),
        ...(resolved.sourceName === undefined ? {} : { sourceName: resolved.sourceName }),
        models: resolved.models,
        sessionStore: this.dependencies.sessionStore,
        thinkingLevel: resolved.thinkingLevel,
        // Pass the factory through: PiReasoningRuntime refreshes per-turn tools on every startTurn,
        // so cached sessions never reuse a previous turn's tool closures.
        tools: (turn) => [
          ...(typeof this.dependencies.tools === "function" ? this.dependencies.tools(turn) : this.dependencies.tools),
          ...(this.#skillTools.get(turn.sessionId) ?? []),
        ],
      });
      selected = { runtime, revision };
      this.#runtimes.set(input.sessionId, selected);
    }
    this.#skillTools.set(input.sessionId, skills?.tools ?? []);
    try {
      await selected.runtime.startTurn({ ...input, ...(skills?.promptSection ? { skillContext: skills.promptSection } : {}) });
    } finally { this.#skillTools.delete(input.sessionId); }
  }

  abort(sessionId: string): void { if (this.#starting.has(sessionId)) this.#canceledStartup.add(sessionId);this.#runtimes.get(sessionId)?.runtime.abort(sessionId); }
  followUp(sessionId: string, text: string): void { this.#require(sessionId).followUp(sessionId, text); }
  isRunning(sessionId: string): boolean { return this.#starting.has(sessionId) || (this.#runtimes.get(sessionId)?.runtime.isRunning(sessionId) ?? false); }
  // Rollback requires a checkpoint owned by the current runtime; a source replacement
  // cannot infer a rollback boundary from persisted history alone.
  async rollbackTurn(sessionId: string, turnId: string): Promise<boolean> {
    return await this.#runtimes.get(sessionId)?.runtime.rollbackTurn(sessionId, turnId) ?? false;
  }
  restore(_sessionId: string): Promise<boolean> { return Promise.resolve(false); }
  steer(sessionId: string, text: string): void { this.#require(sessionId).steer(sessionId, text); }
  async waitForIdle(sessionId: string): Promise<void> { await this.#runtimes.get(sessionId)?.runtime.waitForIdle(sessionId); }

  #require(sessionId: string): PiReasoningRuntime {
    const selected = this.#runtimes.get(sessionId);
    if (selected === undefined) throw new Error("reasoning_session_not_found");
    return selected.runtime;
  }
}
