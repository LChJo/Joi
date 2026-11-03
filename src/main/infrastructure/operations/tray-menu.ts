import { resolveLocale, translate, type UiLocalePreference } from "../../../shared/i18n/index.js";

type TrayItem =
  | { type: "separator" }
  | { type: "normal"; label: string; click: () => void }
  | { type: "checkbox"; label: string; checked: boolean; click: (item: { checked: boolean }) => void };

export function trayMenuTemplate(preference: UiLocalePreference, systemLanguages: readonly string[], launchAtLogin: boolean, actions: {
  open: () => void; stop: () => void; quit: () => void; setLaunchAtLogin: (enabled: boolean) => void;
}): TrayItem[] {
  const locale = resolveLocale(preference, systemLanguages);
  return [
    { type: "normal", label: translate(locale, "common.trayOpen"), click: actions.open },
    { type: "separator" },
    { type: "normal", label: translate(locale, "common.trayStop"), click: actions.stop },
    { type: "checkbox", label: translate(locale, "common.trayLogin"), checked: launchAtLogin, click: (item) => actions.setLaunchAtLogin(item.checked) },
    { type: "separator" },
    { type: "normal", label: translate(locale, "common.trayQuit"), click: actions.quit },
  ];
}
