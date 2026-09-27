import type { AgentTool } from "@earendil-works/pi-agent-core";

import type {
  PrimaryReasoningRuntime,
  ReasoningSessionStore,
  StartReasoningTurnInput,
} from "../../application/ports/primary-reasoning-runtime.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { JoiSkillContext } from "./joi-skill-runtime.js";
import { PiReasoningRuntime } from "./pi-reasoning-runtime.js";
import type { UsageRecorder } from "../../application/ports/usage.js";

/** One global runtime facade whose individual Workbench sessions use their pinned source revision. */
export class ConfiguredPiReasoningRuntime implements PrimaryReasoningRuntime {
  readonly #skillTools = new Map<string, AgentTool[]>();
  readonly #runtimes = new Map<string, { runtime: PiReasoningRuntime; sourceRevisionId: string }>();

  constructor(private readonly dependencies: {
    usage?: UsageRecorder;
    resolver: PiConfiguredModelResolver;
    skills?: { prepare(): Promise<JoiSkillContext> };
    sessionStore: ReasoningSessionStore;
    tools: AgentTool[] | ((input: StartReasoningTurnInput) => AgentTool[]);
  }) {}

  async startTurn(input: StartReasoningTurnInput): Promise<void> {
    if (this.isRunning(input.sessionId)) throw new Error("reasoning_session_busy");
    const skills = await this.dependencies.skills?.prepare();
    let selected = this.#runtimes.get(input.sessionId);
    if (selected?.sourceRevisionId !== input.sourceRevisionId) {
      const resolved = await this.dependencies.resolver.resolve(input);
      const runtime = new PiReasoningRuntime({
        ...(this.dependencies.usage === undefined ? {} : { usage: this.dependencies.usage }),
        // The one compaction field the settings page owns; the runtime fills the rest with its
        // defaults. A cache miss here is guaranteed to pick the new value up: `#runtimes` is keyed
        // by sourceRevisionId, and editing a model source always mints a new revision.
        ...(resolved.compactionThresholdPercent === undefined ? {} : {
          compaction: { compactAtPercent: resolved.compactionThresholdPercent },
        }),
        model: resolved.model,
        models: resolved.models,
        sessionStore: this.dependencies.sessionStore,
        // Pass the factory through: PiReasoningRuntime refreshes per-turn tools on every startTurn,
        // so cached sessions never reuse a previous turn's tool closures.
        tools: (turn) => [
          ...(typeof this.dependencies.tools === "function" ? this.dependencies.tools(turn) : this.dependencies.tools),
          ...(this.#skillTools.get(turn.sessionId) ?? []),
        ],
      });
      selected = { runtime, sourceRevisionId: input.sourceRevisionId };
      this.#runtimes.set(input.sessionId, selected);
    }
    this.#skillTools.set(input.sessionId, skills?.tools ?? []);
    try {
      await selected.runtime.startTurn({ ...input, systemPrompt: [input.systemPrompt, skills?.promptSection].filter(Boolean).join("\n\n") });
    } finally { this.#skillTools.delete(input.sessionId); }
  }

  abort(sessionId: string): void { this.#runtimes.get(sessionId)?.runtime.abort(sessionId); }
  followUp(sessionId: string, text: string): void { this.#require(sessionId).followUp(sessionId, text); }
  isRunning(sessionId: string): boolean { return this.#runtimes.get(sessionId)?.runtime.isRunning(sessionId) ?? false; }
  restore(_sessionId: string): Promise<boolean> { return Promise.resolve(false); }
  steer(sessionId: string, text: string): void { this.#require(sessionId).steer(sessionId, text); }
  async waitForIdle(sessionId: string): Promise<void> { await this.#runtimes.get(sessionId)?.runtime.waitForIdle(sessionId); }

  #require(sessionId: string): PiReasoningRuntime {
    const selected = this.#runtimes.get(sessionId);
    if (selected === undefined) throw new Error("reasoning_session_not_found");
    return selected.runtime;
  }
}
