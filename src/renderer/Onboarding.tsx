import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  LockKeyIcon,
  NetworkIcon,
  RobotIcon,
} from "@phosphor-icons/react";
import { type SyntheticEvent, useState } from "react";

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
      setError(reason instanceof ApiError ? reason.message : "登录未完成，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="access-layout">
      <section className="access-story" aria-label="joi 介绍">
        <div className="wordmark"><span className="wordmark-symbol">JOI</span><strong>joi</strong></div>
        <div>
          <p className="eyebrow">TRUSTED LAN CONSOLE</p>
          <h1>回到持续存在的生命现场。</h1>
          <p>这里连接的是你信任局域网中的本机 Hub。Agent Token 不会进入浏览器。</p>
        </div>
        <p className="security-note"><LockKeyIcon aria-hidden size={17} /> 会话使用 HttpOnly Cookie、Origin 与 CSRF 三重约束。</p>
      </section>
      <form className="access-form" onSubmit={(event) => void submit(event)}>
        <p className="eyebrow">ADMIN ACCESS</p>
        <h2>管理员登录</h2>
        <p>输入桌面首次设置时创建的管理员口令。</p>
        <label>管理员口令<input autoFocus autoComplete="current-password" minLength={10} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
        <FieldError message={error} />
        <button className="button primary wide" disabled={busy} type="submit">{busy ? "正在验证…" : "进入控制台"}</button>
      </form>
    </main>
  );
}

export function SetupJourney({ api, onComplete }: { api: DigitalLifeApi; onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [cardUrl, setCardUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const savePassword = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmation) { setError("两次输入的口令不一致。"); return; }
    setBusy(true); setError(null);
    try { await api.setup(password); setStep(2); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "口令设置未完成。"); }
    finally { setBusy(false); }
  };
  const saveAgent = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try { await api.addAgent(cardUrl, token); onComplete(); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "Agent 连接未完成。"); }
    finally { setBusy(false); }
  };

  return (
    <main className="setup-layout">
      <header className="setup-header">
        <div className="wordmark"><span className="wordmark-symbol">JOI</span><strong>joi</strong></div>
        <ol className="setup-progress" aria-label="首次设置进度">
          {["管理员", "局域网", "主 Agent"].map((label, index) => <li aria-current={step === index + 1 ? "step" : undefined} className={step > index + 1 ? "done" : ""} key={label}><span>{step > index + 1 ? <CheckCircleIcon aria-hidden /> : index + 1}</span>{label}</li>)}
        </ol>
      </header>
      <section className="setup-stage">
        {step === 1 ? <form className="setup-copy form-stack" onSubmit={(event) => void savePassword(event)}>
          <LockKeyIcon className="stage-icon" aria-hidden size={30} />
          <p className="eyebrow">STEP 01 · LOCAL ADMIN</p>
          <h1>先守住进入这里的门。</h1>
          <p>这个口令只用于可信局域网浏览器访问。它不能恢复加密的 Agent Token，也不会发送到云端。</p>
          <div className="two-fields">
            <label>管理员口令<input autoFocus minLength={10} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
            <label>确认口令<input minLength={10} onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} /></label>
          </div>
          <FieldError message={error} />
          <button className="button primary" disabled={busy} type="submit">{busy ? "正在保存…" : "保存并继续"}<ArrowRightIcon aria-hidden /></button>
        </form> : null}
        {step === 2 ? <div className="setup-copy">
          <NetworkIcon className="stage-icon" aria-hidden size={30} />
          <p className="eyebrow">STEP 02 · LAN ACCESS</p>
          <h1>桌面先运行，局域网稍后开放。</h1>
          <p>局域网 Listener 默认关闭。你可以在设置中选择明确的 RFC1918 地址；joi 不会绑定 0.0.0.0，也不会修改防火墙。</p>
          <div className="notice-row"><strong>当前状态</strong><span className="status-dot muted">已关闭</span><small>桌面功能不受影响</small></div>
          <div className="button-row"><button className="button ghost" onClick={() => setStep(1)} type="button"><ArrowLeftIcon aria-hidden />返回</button><button className="button primary" onClick={() => setStep(3)} type="button">保持关闭并继续<ArrowRightIcon aria-hidden /></button></div>
        </div> : null}
        {step === 3 ? <form className="setup-copy form-stack" onSubmit={(event) => void saveAgent(event)}>
          <RobotIcon className="stage-icon" aria-hidden size={30} />
          <p className="eyebrow">STEP 03 · PRIMARY AGENT</p>
          <h1>连接它未来思考的地方。</h1>
          <p>“测试并保存”会读取公开 Agent Card、验证协议并检查主 Agent readiness。Token 保存后不再回显。</p>
          <label>Agent Card URL<input autoFocus onChange={(event) => setCardUrl(event.target.value)} placeholder="http://192.168.1.20:8000/.well-known/agent-card.json" required type="url" value={cardUrl} /></label>
          <label>Bearer Token<input autoComplete="off" onChange={(event) => setToken(event.target.value)} required type="password" value={token} /></label>
          <FieldError message={error} />
          <div className="button-row"><button className="button ghost" onClick={() => setStep(2)} type="button"><ArrowLeftIcon aria-hidden />返回</button><button className="button quiet" onClick={onComplete} type="button">暂时跳过</button><button className="button primary" disabled={busy} type="submit">{busy ? "正在测试…" : "测试并保存"}</button></div>
        </form> : null}
      </section>
    </main>
  );
}
