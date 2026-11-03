import type { MessagePort } from "node:worker_threads";
import { DomainError } from "../../domain/errors.js";

interface Request { kind: "request"; id: number; method: string; args: unknown[] }
interface Reply { kind: "reply"; id: number; value?: unknown; errorCode?: string }
type Handler = (...args: unknown[]) => unknown;

/** Private ports carry data and named commands; executable callbacks and SQL never cross them. */
export class WorkerRpc {
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #sequence = 0;
  #closed = false;

  constructor(private readonly port: MessagePort, private readonly handlers: Readonly<Record<string, Handler>> = {}) {
    port.on("message", this.#receive);
    port.on("close", this.#portClosed);
    port.on("messageerror", this.#portClosed);
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("runtime_worker_closed"));
    if (this.#pending.size >= 256) return Promise.reject(new Error("runtime_worker_overloaded"));
    const id = ++this.#sequence;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try { this.port.postMessage({ kind: "request", id, method, args } satisfies Request); }
      catch { this.#pending.delete(id); reject(new Error("runtime_worker_request_invalid")); }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const request of this.#pending.values()) request.reject(new Error("runtime_worker_closed"));
    this.#pending.clear();
    this.port.off("message", this.#receive);
    this.port.off("close", this.#portClosed);
    this.port.off("messageerror", this.#portClosed);
    this.port.close();
  }

  readonly #portClosed = (): void => { this.close(); };
  readonly #receive = (data: unknown): void => {
    if (this.#closed || data === null || typeof data !== "object" || !("id" in data) || !Number.isSafeInteger(data.id)) return;
    if (!("kind" in data) || (data.kind !== "request" && data.kind !== "reply")) return;
    const message = data as Request | Reply;
    if (message.kind === "reply") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.errorCode !== undefined) pending.reject(new DomainError(message.errorCode, message.errorCode));
      else pending.resolve(message.value);
      return;
    }
    if (!Array.isArray(message.args)) return;
    const handler = Object.hasOwn(this.handlers, message.method) ? this.handlers[message.method] : undefined;
    void Promise.resolve().then(() => {
      if (handler === undefined) throw new Error("runtime_worker_command_invalid");
      return handler(...message.args);
    }).then((value: unknown) => this.#reply({ kind: "reply", id: message.id, value }))
      .catch((error: unknown) => this.#reply({
        kind: "reply", id: message.id,
        errorCode: error instanceof DomainError && /^[a-z][a-z0-9_]{0,100}$/u.test(error.code)
          ? error.code : "runtime_worker_command_failed",
      }));
  };

  #reply(message: Reply): void {
    if (this.#closed) return;
    try { this.port.postMessage(message); }
    catch { this.port.postMessage({ kind: "reply", id: message.id, errorCode: "runtime_worker_response_invalid" } satisfies Reply); }
  }
}
