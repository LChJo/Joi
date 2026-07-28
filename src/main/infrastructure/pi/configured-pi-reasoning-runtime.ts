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
  readonly #runtimes = new Map<string, PiReasoningRuntime>();

  constructor(private readonly dependencies: {
    resolver: PiConfiguredModelResolver;
    sessionStore: ReasoningSessionStore;
    tools: AgentTool[] | ((input: StartReasoningTurnInput) => AgentTool[]);
  }) {}

  async startTurn(input: StartReasoningTurnInput): Promise<void> {
    let runtime = this.#runtimes.get(input.sessionId);
    if (runtime === undefined) {
      const resolved = await this.dependencies.resolver.resolve(input);
      runtime = new PiReasoningRuntime({
        model: resolved.model,
        models: resolved.models,
        sessionStore: this.dependencies.sessionStore,
        tools: typeof this.dependencies.tools === "function" ? this.dependencies.tools(input) : this.dependencies.tools,
      });
      this.#runtimes.set(input.sessionId, runtime);
    }
    await runtime.startTurn(input);
  }

  abort(sessionId: string): void { this.#runtimes.get(sessionId)?.abort(sessionId); }
  followUp(sessionId: string, text: string): void { this.#require(sessionId).followUp(sessionId, text); }
  isRunning(sessionId: string): boolean { return this.#runtimes.get(sessionId)?.isRunning(sessionId) ?? false; }
  restore(_sessionId: string): Promise<boolean> { return Promise.resolve(false); }
  steer(sessionId: string, text: string): void { this.#require(sessionId).steer(sessionId, text); }
  async waitForIdle(sessionId: string): Promise<void> { await this.#runtimes.get(sessionId)?.waitForIdle(sessionId); }

  #require(sessionId: string): PiReasoningRuntime {
    const runtime = this.#runtimes.get(sessionId);
    if (runtime === undefined) throw new Error("reasoning_session_not_found");
    return runtime;
  }
}
