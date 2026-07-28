import { WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { createApi, type DigitalLifeApi } from "./api";
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
    <main className="gate-shell boot-gate" role="status" aria-label="joi 正在准备">
      <div className="pulse-orbit" aria-hidden><span /></div>
      <p className="eyebrow">joi 在这里</p>
      <h1>马上就好</h1>
      <p>joi 正在整理数据和状态。</p>
    </main>
  );
}

function BootError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <main className="gate-shell" role="alert">
      <WarningCircleIcon aria-hidden size={30} />
      <p className="eyebrow">joi 遇到了问题</p>
      <h1>出了点状况</h1>
      <p>{message}</p>
      <button className="button primary" onClick={retry} type="button">再试一次</button>
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
        : { api, kind: "error", message: "请在本机窗口完成首次设置。" });
    }).catch(() => {
      if (!current) return;
      setState({ kind: "error", message: "连不上本机服务，请确认 joi 还在运行。" });
    });
    return () => { current = false; };
  }, [attempt]);

  if (state.kind === "booting") return <Booting />;
  if (state.kind === "error") return <BootError message={state.message} retry={() => { setState({ kind: "booting" }); setAttempt((value) => value + 1); }} />;
  if (state.kind === "login") return <AccessScreen api={state.api} onAuthenticated={() => setState({ api: state.api, kind: "ready" })} />;
  if (state.kind === "setup") return <SetupJourney api={state.api} onComplete={() => setState({ api: state.api, kind: "ready" })} />;
  return <ConsoleApp api={state.api} />;
}
