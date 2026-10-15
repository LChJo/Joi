import { t, useI18n, noticeMessage, translateNotice, type MessageNotice } from "./i18n";
import { LanguageSelector } from "./LanguageSelector";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { createApi, type DigitalLifeApi } from "./api";
import { ConsoleApp } from "./Console";
import { AccessScreen, SetupJourney } from "./Onboarding";

type BootState =
  | { kind: "booting" }
  | { api?: DigitalLifeApi; kind: "error"; message: MessageNotice }
  | { api: DigitalLifeApi; kind: "login" }
  | { api: DigitalLifeApi; kind: "setup" }
  | { api: DigitalLifeApi; kind: "ready" };

function Booting() {
  useI18n();
  return (
    <main className="gate-shell boot-gate" role="status" aria-label={t("onboarding.joiIsGettingReady")}>
      <div className="pulse-orbit" aria-hidden><span /></div>
      <p className="eyebrow">{t("onboarding.joiIsHere")}</p>
      <h1>{t("onboarding.almostReady")}</h1>
      <p>{t("onboarding.joiIsPreparingYourDataAndStatus")}</p>
    </main>
  );
}

function BootError({ message, retry }: { message: MessageNotice; retry: () => void }) {
  useI18n();
  return (
    <main className="gate-shell" role="alert">
      <WarningCircleIcon aria-hidden size={30} />
      <p className="eyebrow">{t("onboarding.joiNeedsAHand")}</p>
      <h1>{t("onboarding.somethingWentWrong")}</h1>
      <p>{translateNotice(message)}</p>
      <button className="button primary" onClick={retry} type="button">{t("onboarding.tryAgain")}</button>
    </main>
  );
}

export function App() {
  useI18n();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BootState>({ kind: "booting" });

  useEffect(() => {
    let current = true;
    void createApi().then(({ api, configured, desktop }) => {
      if (!current) return;
      setState(configured ? (desktop ? { api, kind: "ready" } : { api, kind: "login" }) : desktop
        ? { api, kind: "setup" }
        : { api, kind: "error", message: noticeMessage("onboarding.completeTheInitialSetupInTheDesktopWindow") });
    }).catch(() => {
      if (!current) return;
      setState({ kind: "error", message: noticeMessage("onboarding.cannotConnectToTheLocalServiceMakeSureJoi") });
    });
    return () => { current = false; };
  }, [attempt]);

  if (state.kind === "booting") return <><div className="gate-language"><LanguageSelector /></div><Booting /></>;
  if (state.kind === "error") return <><div className="gate-language"><LanguageSelector /></div><BootError message={state.message} retry={() => { setState({ kind: "booting" }); setAttempt((value) => value + 1); }} /></>;
  if (state.kind === "login") return <AccessScreen api={state.api} onAuthenticated={() => setState({ api: state.api, kind: "ready" })} />;
  if (state.kind === "setup") return <SetupJourney api={state.api} onComplete={() => setState({ api: state.api, kind: "ready" })} />;
  return <ConsoleApp api={state.api} />;
}
