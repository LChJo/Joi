import type { CodexLoginDto, CodexLoginMethod, CodexLoginState } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import type { CodexAuthorizationPort, SubscriptionLoginFacts, SubscriptionLoginStageEvent } from "../ports/model-source-ports.js";
import type { IdGenerator } from "../ports/runtime-store.js";
import { subscriptionLoginReasonCode } from "../ports/runtime-diagnostics.js";
import type { ModelSourceService } from "./model-source-service.js";
import type { SubscriptionLoginDiagnostics, SubscriptionLoginRecorder } from "./subscription-login-diagnostics.js";
import { ANTIGRAVITY_REDIRECT_URI } from "../../../shared/antigravity-authorization.js";

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

export class SubscriptionLoginService {
  #attempt: LoginAttempt | undefined;
  #closed = false;

  constructor(private readonly dependencies: {
    provider?: "codex" | "antigravity";
    authorization: CodexAuthorizationPort;
    ids: IdGenerator;
    connect: ModelSourceService["connectCodex"];
    /** Antigravity-only sanitized diagnostics; codex sign-ins keep their exact previous shape. */
    diagnostics?: Pick<SubscriptionLoginDiagnostics, "start" | "latest">;
  }) {}

  #error(suffix: string, message: string): DomainError {
    return new DomainError(`${this.dependencies.provider ?? "codex"}_${suffix}`, message);
  }

  start(owner: string, method: CodexLoginMethod, sourceId?: string): CodexLoginDto {
    if (this.#closed) throw this.#error("login_unavailable", "Subscription sign-in is unavailable.");
    if (this.dependencies.provider === "antigravity" && method !== "browser") {
      throw this.#error("login_method_invalid", "Antigravity uses browser sign-in.");
    }
    const active = this.#attempt;
    if (active?.completion !== undefined) {
      if (!active.controller.signal.aborted && active.owner === owner && active.method === method && active.sourceId === sourceId) {
        return this.#dto(active);
      }
      throw this.#error("login_busy", "A subscription sign-in is already in progress.");
    }
    const attempt: LoginAttempt = {
      id: this.dependencies.ids.next(`${this.dependencies.provider ?? "codex"}_login`),
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
      throw this.#error("callback_unavailable", "This sign-in is no longer waiting for a callback.");
    }
    const redirect = URL.parse(value);
    const authState = new URL(attempt.state.url).searchParams.get("state");
    const expected = new URL(this.dependencies.provider === "antigravity" ? ANTIGRAVITY_REDIRECT_URI : "http://localhost:1455/auth/callback");
    if (redirect?.origin !== expected.origin
      || redirect.pathname !== expected.pathname || redirect.username !== "" || redirect.password !== ""
      || redirect.hash !== "" || redirect.searchParams.getAll("code").length !== 1
      || !redirect.searchParams.get("code") || redirect.searchParams.getAll("state").length !== 1
      || !authState || redirect.searchParams.get("state") !== authState) {
      throw this.#error("callback_invalid", "Paste the complete callback URL from this sign-in.");
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
    const diagnostics = this.dependencies.provider === "antigravity" ? this.dependencies.diagnostics : undefined;
    const recorder: SubscriptionLoginRecorder | undefined = diagnostics?.start("antigravity", attempt.id);
    const record = (event: SubscriptionLoginStageEvent): void => recorder?.record(event);
    const note = (facts: SubscriptionLoginFacts): void => recorder?.note(facts);
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
        ...(recorder === undefined ? {} : { onStage: record, onFacts: note }),
      });
      signal.throwIfAborted();
      clearTimeout(timer);
      attempt.state = { status: "validating" };
      let source: Awaited<ReturnType<ModelSourceService["connectCodex"]>>;
      try {
        source = await this.dependencies.connect(credential, signal, sourceId);
      } catch (error) {
        record({ stage: "credential_store", outcome: "failed", reasonCode: subscriptionLoginReasonCode(error) });
        throw error;
      }
      record({ stage: "credential_store", outcome: "ok" });
      if (!signal.aborted) attempt.state = { status: "completed", source };
      recorder?.finish("completed");
    } catch (error) {
      if (!signal.aborted) {
        attempt.state = recorder === undefined
          ? { status: "failed" }
          : { status: "failed", reasonCode: subscriptionLoginReasonCode(error) };
        recorder?.finish("failed");
      } else {
        recorder?.finish(attempt.state.status === "expired" ? "expired" : "canceled");
      }
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
      throw this.#error("login_not_found", "Subscription sign-in was not found.");
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

export class CodexLoginService extends SubscriptionLoginService {
  constructor(dependencies: {
    authorization: CodexAuthorizationPort;
    ids: IdGenerator;
    sources: Pick<ModelSourceService, "connectCodex">;
  }) {
    super({ authorization: dependencies.authorization, ids: dependencies.ids,
      connect: (credential, signal, id) => dependencies.sources.connectCodex(credential, signal, id) });
  }
}
