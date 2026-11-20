import { useEffect, useEffectEvent, useRef, useState, type SubmitEvent } from "react";
import { CODEX_AUTHORIZATION_WINDOW, isCodexAuthorizationUrl } from "../shared/codex-authorization";
import type { CodexLoginDto, CodexLoginMethod } from "../shared/joi";
import { ApiError, type DigitalLifeApi } from "./api";
import { t, useI18n } from "./i18n";

export function CodexSubscriptionForm({ api, sourceId, onCancel, onConnected }: {
  api: DigitalLifeApi;
  sourceId?: string;
  onCancel: () => void;
  onConnected: () => Promise<void>;
}) {
  useI18n();
  const [attempt, setAttempt] = useState<CodexLoginDto>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [statusError, setStatusError] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const activeAttempt = useRef<string | undefined>(undefined);
  const submitting = useRef(false);
  const connected = useEffectEvent(onConnected);
  const attemptId = attempt?.attemptId;
  const waiting = attempt?.status === "starting" || attempt?.status === "browser" || attempt?.status === "device_code" || attempt?.status === "validating";

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (activeAttempt.current !== undefined) void api.cancelCodexLogin(activeAttempt.current).catch(() => undefined);
      activeAttempt.current = undefined;
    };
  }, [api]);

  useEffect(() => {
    if (attemptId === undefined || !waiting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.codexLoginStatus(attemptId, controller.signal);
        if (controller.signal.aborted) return;
        setStatusError(false);
        setAttempt(next);
        if (next.status === "completed") {
          activeAttempt.current = undefined;
          await connected();
          return;
        }
        if (next.status === "failed" || next.status === "expired" || next.status === "canceled") {
          activeAttempt.current = undefined;
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatusError(true);
        if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) {
          activeAttempt.current = undefined;
          setAttempt(undefined);
          return;
        }
      }
      timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, attemptId, waiting]);

  const start = async (method: CodexLoginMethod) => {
    const signal = lifetime.current?.signal;
    if (submitting.current || signal === undefined) return;
    submitting.current = true;
    setWorking(true);
    setError(undefined);
    setStatusError(false);
    try {
      const result = await api.startCodexLogin(method, sourceId);
      if (signal.aborted) {
        void api.cancelCodexLogin(result.attemptId).catch(() => undefined);
        return;
      }
      activeAttempt.current = result.attemptId;
      setAttempt(result);
    } catch (error) {
      if (!signal.aborted) setError(t(error instanceof ApiError && error.code === "codex_login_busy" ? "home.codexLoginBusy" : "home.codexLoginFailed"));
    } finally {
      submitting.current = false;
      if (!signal.aborted) setWorking(false);
    }
  };

  const submitCallback = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (attemptId === undefined || submitting.current) return;
    const form = event.currentTarget;
    const callbackUrl = new FormData(form).get("callbackUrl");
    if (typeof callbackUrl !== "string") return;
    submitting.current = true;
    setWorking(true);
    setError(undefined);
    try {
      await api.completeCodexCallback(attemptId, callbackUrl.trim());
      form.reset();
    } catch {
      setError(t("home.codexCallbackInvalid"));
    } finally {
      submitting.current = false;
      setWorking(false);
    }
  };

  const authorizationUrl = (attempt?.status === "browser" || attempt?.status === "device_code")
    && isCodexAuthorizationUrl(attempt.url, attempt.status) ? attempt.url : undefined;
  return <section className="model-source-form" aria-label={t("home.codexSubscription")}>
    <h2>{t("home.codexSubscription")}</h2>
    {!waiting && attempt?.status !== "completed" ? <>
      <p>{t("home.codexSubscriptionHint")}</p>
      <div className="row-actions">
        <button className="button primary" disabled={working} onClick={() => void start("browser")} type="button">{t("home.codexBrowserSignIn")}</button>
        <button className="button quiet" disabled={working} onClick={() => void start("device_code")} type="button">{t("home.codexDeviceSignIn")}</button>
      </div>
    </> : null}
    {attempt?.status === "device_code" ? <p>{t("home.codexEnterDeviceCode")} <code>{attempt.userCode}</code></p> : null}
    {authorizationUrl === undefined ? null : <div className="row-actions">
      <a className="button primary" href={authorizationUrl} rel="noopener noreferrer" target={CODEX_AUTHORIZATION_WINDOW}>{t("home.codexOpenAuthorization")}</a>
    </div>}
    {attempt?.status === "browser" && attempt.acceptsCallback ? <form onSubmit={(event) => void submitCallback(event)}>
      <label>{t("home.codexCallbackUrl")}<input autoComplete="off" name="callbackUrl" required type="url" /></label>
      <button className="button quiet" disabled={working} type="submit">{t("home.codexSubmitCallback")}</button>
    </form> : null}
    {waiting ? <p role="status">{t(attempt.status === "validating" ? "home.checkingTheConnectionThisMayIncurASmallModel" : "home.codexWaitingForAuthorization")}</p> : null}
    {attempt?.status === "completed" ? <p role="status">{t(attempt.source.status === "READY" ? "home.connectedJoiIsReadyToThink" : "home.codexSavedNeedsValidation")}</p> : null}
    {attempt?.status === "failed" || attempt?.status === "expired" ? <p role="alert">{t(attempt.status === "failed" ? "home.codexLoginFailed" : "home.codexLoginExpired")}</p> : null}
    {error === undefined ? null : <p role="alert">{error}</p>}
    {statusError ? <p role="alert">{t("home.codexStatusFailed")}</p> : null}
    {attempt?.status === "validating" ? null : <div className="row-actions"><button className="button ghost" onClick={onCancel} type="button">{t(attempt?.status === "completed" ? "home.collapse" : "common.cancel")}</button></div>}
  </section>;
}
