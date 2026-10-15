import { noticeMessage, t, useI18n, useNotice } from "./i18n";
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
import { LanguageSelector } from "./LanguageSelector";

function FieldError({ message }: { message: string | null }) {
  useI18n();
  return message === null ? null : <p className="form-error" role="alert">{message}</p>;
}

export function AccessScreen({ api, onAuthenticated }: { api: DigitalLifeApi; onAuthenticated: () => void }) {
  useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useNotice();
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
      setError(reason instanceof ApiError ? reason.displayMessage : noticeMessage("onboarding.verificationFailedTryAgain"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="access-layout">
      <section className="access-story" aria-label={t("onboarding.aboutJoi")}>
        <div className="wordmark"><span className="wordmark-symbol">JOI</span><strong>joi</strong></div>
        <div>
          <p className="eyebrow">{t("onboarding.joiIsHere")}</p>
          <h1>{t("onboarding.welcomeBackJoiIsHere")}</h1>
          <p>{t("onboarding.enterYourPasswordToPickUpWhereYouLeft")}</p>
        </div>
        <p className="security-note"><LockKeyIcon aria-hidden size={17} />  {t("onboarding.yourPasswordStaysOnTheComputerRunningJoiAnd")}</p>
      </section>
      <form className="access-form" onSubmit={(event) => void submit(event)}>
        <LanguageSelector />
        <p className="eyebrow">{t("onboarding.backToJoi")}</p>
        <h2>{t("onboarding.confirmItIsYou")}</h2>
        <p>{t("onboarding.enterTheAdminPasswordSavedDuringSetup")}</p>
        <label>{t("onboarding.adminPassword")}<input autoFocus autoComplete="current-password" minLength={ADMIN_PASSWORD_MIN_LENGTH} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
        <FieldError message={error} />
        <button className="button primary wide" disabled={busy} type="submit">{busy ? t("onboarding.joiIsChecking") : t("onboarding.backToJoi")}</button>
      </form>
    </main>
  );
}

export function SetupJourney({ api, onComplete }: { api: DigitalLifeApi; onComplete: () => void }) {
  useI18n();
  const [step, setStep] = useState(1);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useNotice();
  const [busy, setBusy] = useState(false);

  const savePassword = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmation) { setError(noticeMessage("onboarding.thePasswordsDoNotMatch")); return; }
    setBusy(true); setError(null);
    try { await api.setup(password); setStep(2); }
    catch (reason) { setError(reason instanceof ApiError ? reason.displayMessage : noticeMessage("onboarding.couldNotSaveThePasswordTryAgain")); }
    finally { setBusy(false); }
  };
  // The model network form reports back after every save attempt, including drafts that failed
  // validation. The runtime status decides whether the final
  // button reads as "done" or still skippable.
  const refreshConnection = async () => {
    try { setConnected((await api.joiRuntime()).configured); }
    catch { setConnected(false); }
  };

  return (
    <main className="setup-layout">
      <header className="setup-header">
        <LanguageSelector />
        <div className="wordmark"><span className="wordmark-symbol">JOI</span><strong>joi</strong></div>
        <ol className="setup-progress" aria-label={t("onboarding.setupProgress")}>
          {[t("onboarding.setPassword"), t("onboarding.chooseAccess"), t("onboarding.connectAModel")].map((label, index) => <li aria-current={step === index + 1 ? "step" : undefined} className={step > index + 1 ? "done" : ""} key={label}><span>{step > index + 1 ? <CheckCircleIcon aria-hidden /> : index + 1}</span>{label}</li>)}
        </ol>
      </header>
      <section className="setup-stage">
        {step === 1 ? <form className="setup-copy form-stack" onSubmit={(event) => void savePassword(event)}>
          <LockKeyIcon className="stage-icon" aria-hidden size={30} />
          <p className="eyebrow">{t("onboarding.protectJoiFirst")}</p>
          <h1>{t("onboarding.setAPasswordForJoiFirst")}</h1>
          <p>{t("onboarding.aPasswordLetsDevicesOnTheSameNetworkAccess")}</p>
          <div className="two-fields">
            <label>{t("onboarding.adminPassword")}<input autoFocus minLength={ADMIN_PASSWORD_MIN_LENGTH} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
            <label>{t("onboarding.confirmPassword")}<input minLength={ADMIN_PASSWORD_MIN_LENGTH} onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} /></label>
          </div>
          <FieldError message={error} />
          <button className="button primary" disabled={busy} type="submit">{busy ? t("settings.saving") : t("onboarding.saveAndContinue")}<ArrowRightIcon aria-hidden /></button>
        </form> : null}
        {step === 2 ? <div className="setup-copy">
          <NetworkIcon className="stage-icon" aria-hidden size={30} />
          <p className="eyebrow">{t("onboarding.chooseWhoCanAccessJoi")}</p>
          <h1>{t("onboarding.shouldOtherDevicesBeAbleToReachJoi")}</h1>
          <p>{t("onboarding.keepingItOffIsSafestYouCanEnableA")}</p>
          <div className="notice-row"><strong>{t("onboarding.current")}</strong><span className="status-dot muted">{t("settings.localAccessOnly")}</span><small>{t("onboarding.changeThisAnytimeInSettings")}</small></div>
          <div className="button-row"><button className="button ghost" onClick={() => setStep(1)} type="button"><ArrowLeftIcon aria-hidden />{t("common.back")}</button><button className="button primary" onClick={() => setStep(3)} type="button">{t("onboarding.useThisComputerOnly")}<ArrowRightIcon aria-hidden /></button></div>
        </div> : null}
        {step === 3 ? <div className="setup-copy setup-model-network">
          <ModelSourceSetup api={api} changed={refreshConnection} />
          <div className="button-row">
            <button className="button ghost" onClick={() => setStep(2)} type="button"><ArrowLeftIcon aria-hidden />{t("common.back")}</button>
            <button className={connected ? "button primary" : "button quiet"} onClick={onComplete} type="button">{connected ? t("onboarding.enterJoi") : t("onboarding.skipForNow")}</button>
          </div>
        </div> : null}
      </section>
    </main>
  );
}
