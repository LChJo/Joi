import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  LockKeyIcon,
  NetworkIcon,
} from "@phosphor-icons/react";
import { type SyntheticEvent, useState } from "react";

import { ADMIN_PASSWORD_MIN_LENGTH } from "../shared/product";
import { ModelSourceSetup } from "./JoiHome";
import { ApiError, type DigitalLifeApi } from "./api";

function FieldError({ message }: { message: string | null }) {
  return message === null ? null : <p className="form-error" role="alert">{message}</p>;
}

export function AccessScreen({ api, onAuthenticated }: { api: DigitalLifeApi; onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const grant = await api.login(password);
      api.setCsrfToken(grant.csrfToken);
      onAuthenticated();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "没验证成功，再试一次。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="access-layout">
      <section className="access-story" aria-label="joi 介绍">
        <div className="wordmark"><span className="wordmark-symbol">JOI</span><strong>joi</strong></div>
        <div>
          <p className="eyebrow">joi 在这里</p>
          <h1>欢迎回来，joi 一直在。</h1>
          <p>输入密码，接着之前的事继续。</p>
        </div>
        <p className="security-note"><LockKeyIcon aria-hidden size={17} /> 密码只存在运行 joi 的电脑上，不会交给浏览器。</p>
      </section>
      <form className="access-form" onSubmit={(event) => void submit(event)}>
        <p className="eyebrow">回到 joi</p>
        <h2>确认是你</h2>
        <p>请输入首次设置时保存的管理密码。</p>
        <label>管理密码<input autoFocus autoComplete="current-password" minLength={ADMIN_PASSWORD_MIN_LENGTH} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
        <FieldError message={error} />
        <button className="button primary wide" disabled={busy} type="submit">{busy ? "joi 确认中…" : "回到 joi"}</button>
      </form>
    </main>
  );
}

export function SetupJourney({ api, onComplete }: { api: DigitalLifeApi; onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const savePassword = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmation) { setError("两次密码不一致。"); return; }
    setBusy(true); setError(null);
    try { await api.setup(password); setStep(2); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "密码没存上，再试一次。"); }
    finally { setBusy(false); }
  };
  // The model network form reports back after every save attempt, including drafts that failed
  // validation. The runtime status — not the form's own notice — decides whether the final
  // button reads as "done" or still skippable.
  const refreshConnection = async () => {
    try { setConnected((await api.joiRuntime()).configured); }
    catch { setConnected(false); }
  };

  return (
    <main className="setup-layout">
      <header className="setup-header">
        <div className="wordmark"><span className="wordmark-symbol">JOI</span><strong>joi</strong></div>
        <ol className="setup-progress" aria-label="首次设置进度">
          {["设密码", "选择访问范围", "连接模型网络"].map((label, index) => <li aria-current={step === index + 1 ? "step" : undefined} className={step > index + 1 ? "done" : ""} key={label}><span>{step > index + 1 ? <CheckCircleIcon aria-hidden /> : index + 1}</span>{label}</li>)}
        </ol>
      </header>
      <section className="setup-stage">
        {step === 1 ? <form className="setup-copy form-stack" onSubmit={(event) => void savePassword(event)}>
          <LockKeyIcon className="stage-icon" aria-hidden size={30} />
          <p className="eyebrow">先保护 joi</p>
          <h1>先帮 joi 设个密码。</h1>
          <p>有了密码，同一网络里的设备就能找到 joi。密码只存本机，忘了只能重置。</p>
          <div className="two-fields">
            <label>管理密码<input autoFocus minLength={ADMIN_PASSWORD_MIN_LENGTH} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
            <label>确认密码<input minLength={ADMIN_PASSWORD_MIN_LENGTH} onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} /></label>
          </div>
          <FieldError message={error} />
          <button className="button primary" disabled={busy} type="submit">{busy ? "保存中…" : "保存并继续"}<ArrowRightIcon aria-hidden /></button>
        </form> : null}
        {step === 2 ? <div className="setup-copy">
          <NetworkIcon className="stage-icon" aria-hidden size={30} />
          <p className="eyebrow">选择谁能找到 joi</p>
          <h1>其他设备也要来找 joi 吗？</h1>
          <p>现在关着最安全。之后需要时，可以在设置里选一个局域网地址开放。joi 不会自动改防火墙。</p>
          <div className="notice-row"><strong>当前</strong><span className="status-dot muted">仅限本机</span><small>随时可在设置中更改</small></div>
          <div className="button-row"><button className="button ghost" onClick={() => setStep(1)} type="button"><ArrowLeftIcon aria-hidden />返回</button><button className="button primary" onClick={() => setStep(3)} type="button">先只用本机<ArrowRightIcon aria-hidden /></button></div>
        </div> : null}
        {step === 3 ? <div className="setup-copy setup-model-network">
          <ModelSourceSetup api={api} changed={refreshConnection} />
          <div className="button-row">
            <button className="button ghost" onClick={() => setStep(2)} type="button"><ArrowLeftIcon aria-hidden />返回</button>
            <button className={connected ? "button primary" : "button quiet"} onClick={onComplete} type="button">{connected ? "进入 joi" : "暂时跳过"}</button>
          </div>
        </div> : null}
      </section>
    </main>
  );
}
