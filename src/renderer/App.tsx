import { WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { ApiError, createApi, type DigitalLifeApi } from "./api";
import { ConsoleApp } from "./Console";
import { AccessScreen, SetupJourney } from "./Onboarding";

type BootState =
  | { kind: "booting" }
  | { api?: DigitalLifeApi; kind: "error"; message: string }
  | { api: DigitalLifeApi; kind: "login" }
  | { api: DigitalLifeApi; kind: "setup" }
  | { api: DigitalLifeApi; kind: "ready" };

function Booting() {
  return (
    <main className="gate-shell boot-gate" role="status" aria-label="正在连接本机 Runtime">
      <div className="pulse-orbit" aria-hidden><span /></div>
      <p className="eyebrow">LOCAL RUNTIME</p>
      <h1>正在唤醒控制台</h1>
      <p>验证本机数据库、会话与事件流。</p>
    </main>
  );
}

function BootError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <main className="gate-shell" role="alert">
      <WarningCircleIcon aria-hidden size={30} />
      <p className="eyebrow">RUNTIME UNAVAILABLE</p>
      <h1>暂时无法连接本机 Runtime</h1>
      <p>{message}</p>
      <button className="button primary" onClick={retry} type="button">重新连接</button>
    </main>
  );
}

export function App() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BootState>({ kind: "booting" });

  useEffect(() => {
    let current = true;
    void createApi().then(({ api, configured, desktop }) => {
      if (!current) return;
      setState(configured ? (desktop ? { api, kind: "ready" } : { api, kind: "login" }) : desktop
        ? { api, kind: "setup" }
        : { api, kind: "error", message: "首次设置只能在 joi 桌面窗口完成。" });
    }).catch((error: unknown) => {
      if (!current) return;
      const message = error instanceof ApiError ? `${error.message}（${error.code}）` : "Runtime 没有响应，请确认应用仍在运行。";
      setState({ kind: "error", message });
    });
    return () => { current = false; };
  }, [attempt]);

  if (state.kind === "booting") return <Booting />;
  if (state.kind === "error") return <BootError message={state.message} retry={() => { setState({ kind: "booting" }); setAttempt((value) => value + 1); }} />;
  if (state.kind === "login") return <AccessScreen api={state.api} onAuthenticated={() => setState({ api: state.api, kind: "ready" })} />;
  if (state.kind === "setup") return <SetupJourney api={state.api} onComplete={() => setState({ api: state.api, kind: "ready" })} />;
  return <ConsoleApp api={state.api} />;
}

export { LifeHome } from "./Console";
