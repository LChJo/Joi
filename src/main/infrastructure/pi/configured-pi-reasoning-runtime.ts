import type { AgentTool } from "@earendil-works/pi-agent-core";

import type {
  PrimaryReasoningRuntime,
  ReasoningSessionStore,
  StartReasoningTurnInput,
} from "../../application/ports/primary-reasoning-runtime.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import { PiReasoningRuntime } from "./pi-reasoning-runtime.js";

/** One global runtime facade whose individual Avatar sessions use their pinned source revision. */
export class ConfiguredPiReasoningRuntime implements PrimaryReasoningRuntime {
  readonly #runtimes = new Map<string, { runtime: PiReasoningRuntime; sourceRevisionId: string }>();

  constructor(private readonly dependencies: {
    resolver: PiConfiguredModelResolver;
    sessionStore: ReasoningSessionStore;
    tools: AgentTool[] | ((input: StartReasoningTurnInput) => AgentTool[]);
  }) {}

  async startTurn(input: StartReasoningTurnInput): Promise<void> {
    let selected = this.#runtimes.get(input.sessionId);
    if (selected?.sourceRevisionId !== input.sourceRevisionId) {
      const resolved = await this.dependencies.resolver.resolve(input);
      const runtime = new PiReasoningRuntime({
        model: resolved.model,
        models: resolved.models,
        sessionStore: this.dependencies.sessionStore,
        // Pass the factory through: PiReasoningRuntime refreshes per-turn tools on every startTurn,
        // so cached sessions never reuse a previous turn's tool closures.
        tools: this.dependencies.tools,
      });
      selected = { runtime, sourceRevisionId: input.sourceRevisionId };
      this.#runtimes.set(input.sessionId, selected);
    }
    await selected.runtime.startTurn(input);
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
