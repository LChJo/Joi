import type { ConversationChild,ConversationChildInput,ConversationSubagentStore,ConversationSubagentPort } from "../ports/conversation-subagents.js";
import type { Clock,IdGenerator } from "../ports/runtime-store.js";
import { DomainError } from "../../domain/errors.js";

/** Child effects are admitted once; parent settlement includes every admitted child. */
export class ConversationSubagentService implements ConversationSubagentPort {
  readonly #active = new Map<string,{ parentTurnId: string;controller: AbortController;done: Promise<void> }>();
  #closed = false;
  constructor(private readonly dependencies: { clock: Clock;ids: IdGenerator;store: ConversationSubagentStore;
    execute: (child: ConversationChild,signal: AbortSignal) => Promise<string>;kick?: () => void }) {}
  async start(input: ConversationChildInput): Promise<ConversationChild> {
    if (this.#closed) throw new DomainError("conversation_stopped","Conversation execution is closed.");
    if (input.task.trim() === "" || input.task.length > 64_000) throw new DomainError("subagent_task_invalid","Enter a bounded child task.");
    const child = await this.dependencies.store.enqueue({ ...input,childId: this.dependencies.ids.next("chat_child"),at: this.dependencies.clock.now().toISOString() });
    this.dependencies.kick?.();return child;
  }
  list(parentTurnId: string) { return this.dependencies.store.list(parentTurnId); }
  async cancel(parentTurnId: string,id?: string): Promise<void> {
    await this.dependencies.store.cancel(parentTurnId,id);
    for (const [childId,active] of this.#active) if (active.parentTurnId === parentTurnId && (id === undefined || id === childId)) active.controller.abort();
  }
  async deliver(id: string): Promise<void> {
    const child = await this.dependencies.store.get(id);
    if (child === null || this.#closed || this.#active.has(id)) return;
    const controller = new AbortController();
    const completion = Promise.withResolvers<undefined>();
    this.#active.set(id,{ parentTurnId: child.parentTurnId,controller,done: completion.promise });
    try {
      if (!await this.dependencies.store.claim(id)) return;
      await this.#execute(child,controller.signal);
    } finally { this.#active.delete(id);completion.resolve(undefined); }
  }
  async #execute(child: ConversationChild,signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      const body = await this.dependencies.execute(child,signal);
      await this.dependencies.store.finish(child.childId,signal.aborted ? "CANCELED" : "COMPLETED",body);
    } catch {
      await this.dependencies.store.finish(child.childId,signal.aborted ? "CANCELED" : "FAILED");
    }
  }
  async settle(parentTurnId: string): Promise<ConversationChild[]> {
    for (;;) {
      const children = await this.list(parentTurnId);
      const running = [...this.#active.values()].filter(active => active.parentTurnId === parentTurnId);
      if (running.length > 0) { await Promise.all(running.map(active => active.done));continue; }
      if (!children.some(child => child.status === "QUEUED" || child.status === "RUNNING")) return children;
      this.dependencies.kick?.();
      await new Promise<void>(resolve => setTimeout(resolve,50));
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const active of this.#active.values()) { await this.dependencies.store.cancel(active.parentTurnId);active.controller.abort(); }
    await Promise.all([...this.#active.values()].map(active => active.done));
    await this.dependencies.store.recover();
  }
}
