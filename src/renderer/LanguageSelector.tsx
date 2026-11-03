import { isLocalePreference } from "../shared/i18n/index.js";
import { languages, useI18n } from "./i18n";

export function LanguageSelector() {
  const { preference, setPreference, failed, t } = useI18n();
  return <div className="language-selector">
    <label>{t("common.language")}<select aria-label={t("common.language")} value={preference} onChange={(event) => {
      if (isLocalePreference(event.currentTarget.value)) void setPreference(event.currentTarget.value);
    }}><option value="system">{t("common.system")}</option>{languages.map((language) => <option key={language.code} value={language.code}>{language.name}</option>)}</select></label>
    {failed ? <p role="alert">{t("common.languageSaveFailed")}</p> : null}
  </div>;
}
