import type { CodexLoginDto, CodexLoginMethod, CodexLoginState } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import type { CodexAuthorizationPort } from "../ports/model-source-ports.js";
import type { IdGenerator } from "../ports/runtime-store.js";
import type { ModelSourceService } from "./model-source-service.js";

const LOGIN_TIMEOUT_MS = 15 * 60_000;

interface LoginAttempt {
  id: string;
  owner: string;
  method: CodexLoginMethod;
  sourceId: string | undefined;
  controller: AbortController;
  state: CodexLoginState;
  submitCallback?: (url: string) => void;
  completion?: Promise<void>;
}

export class CodexLoginService {
  #attempt: LoginAttempt | undefined;
  #closed = false;

  constructor(private readonly dependencies: {
    authorization: CodexAuthorizationPort;
    ids: IdGenerator;
    sources: Pick<ModelSourceService, "connectCodex">;
  }) {}

  start(owner: string, method: CodexLoginMethod, sourceId?: string): CodexLoginDto {
    if (this.#closed) throw new DomainError("codex_login_unavailable", "Codex sign-in is unavailable.");
    const active = this.#attempt;
    if (active?.completion !== undefined) {
      if (!active.controller.signal.aborted && active.owner === owner && active.method === method && active.sourceId === sourceId) {
        return this.#dto(active);
      }
      throw new DomainError("codex_login_busy", "A Codex sign-in is already in progress.");
    }
    const attempt: LoginAttempt = {
      id: this.dependencies.ids.next("codex_login"),
      owner,
      method,
      sourceId,
      controller: new AbortController(),
      state: { status: "starting" },
    };
    this.#attempt = attempt;
    attempt.completion = this.#run(attempt, method, sourceId).finally(() => {
      delete attempt.completion;
    });
    return this.#dto(attempt);
  }

  status(owner: string, id: string): CodexLoginDto {
    return this.#dto(this.#get(owner, id));
  }

  submitCallback(owner: string, id: string, value: string): void {
    const attempt = this.#get(owner, id);
    if (attempt.state.status !== "browser" || attempt.submitCallback === undefined) {
      throw new DomainError("codex_callback_unavailable", "This sign-in is no longer waiting for a callback.");
    }
    const redirect = URL.parse(value);
    const authState = new URL(attempt.state.url).searchParams.get("state");
    if (redirect?.origin !== "http://localhost:1455"
      || redirect.pathname !== "/auth/callback" || redirect.username !== "" || redirect.password !== ""
      || redirect.hash !== "" || redirect.searchParams.getAll("code").length !== 1
      || !redirect.searchParams.get("code") || redirect.searchParams.getAll("state").length !== 1
      || !authState || redirect.searchParams.get("state") !== authState) {
      throw new DomainError("codex_callback_invalid", "Paste the complete Codex callback URL from this sign-in.");
    }
    attempt.submitCallback(redirect.href);
  }

  cancel(owner: string, id: string): void {
    const attempt = this.#get(owner, id);
    if (attempt.completion !== undefined && attempt.state.status !== "validating") this.#abort(attempt, "canceled");
  }

  async close(): Promise<void> {
    this.#closed = true;
    const attempt = this.#attempt;
    if (attempt?.completion !== undefined) {
      this.#abort(attempt, "canceled");
      await attempt.completion;
    }
  }

  async #run(attempt: LoginAttempt, method: CodexLoginMethod, sourceId: string | undefined): Promise<void> {
    const signal = attempt.controller.signal;
    const timer = setTimeout(() => this.#abort(attempt, "expired"), LOGIN_TIMEOUT_MS);
    try {
      const credential = await this.dependencies.authorization.authorize({
        method,
        signal,
        showBrowser: (url) => {
          if (!signal.aborted) attempt.state = { status: "browser", url, acceptsCallback: false };
        },
        showDeviceCode: (url, userCode) => {
          if (!signal.aborted) attempt.state = { status: "device_code", url, userCode };
        },
        waitForCallback: (promptSignal) => this.#waitForCallback(attempt, promptSignal),
      });
      signal.throwIfAborted();
      clearTimeout(timer);
      attempt.state = { status: "validating" };
      const source = await this.dependencies.sources.connectCodex(credential, signal, sourceId);
      if (!signal.aborted) attempt.state = { status: "completed", source };
    } catch {
      if (!signal.aborted) attempt.state = { status: "failed" };
    } finally {
      clearTimeout(timer);
      delete attempt.submitCallback;
    }
  }

  #waitForCallback(attempt: LoginAttempt, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const finish = (value?: string) => {
        signal.removeEventListener("abort", abort);
        delete attempt.submitCallback;
        if (attempt.state.status === "browser") attempt.state = { ...attempt.state, acceptsCallback: false };
        if (value === undefined) reject(new Error("codex_callback_canceled"));
        else resolve(value);
      };
      const abort = () => finish();
      if (signal.aborted || attempt.controller.signal.aborted || attempt.state.status !== "browser") {
        abort();
        return;
      }
      attempt.submitCallback = finish;
      attempt.state = { ...attempt.state, acceptsCallback: true };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  #get(owner: string, id: string): LoginAttempt {
    const attempt = this.#attempt;
    if (attempt?.id !== id || attempt.owner !== owner) {
      throw new DomainError("codex_login_not_found", "Codex sign-in was not found.");
    }
    return attempt;
  }

  #dto(attempt: LoginAttempt): CodexLoginDto {
    return { attemptId: attempt.id, ...attempt.state };
  }

  #abort(attempt: LoginAttempt, status: "canceled" | "expired") {
    attempt.state = { status };
    attempt.controller.abort();
  }
}
