import { useState, useSyncExternalStore } from "react";
import { IntlMessageFormat } from "intl-messageformat";
import { catalogs, errorKeys, sourceKeys } from "../shared/i18n/generated.js";
import { isLocalePreference, languages, resolveLocale, translate, translateSource, type LocaleCode, type MessageKey, type MessageParameters, type UiLocalePreference } from "../shared/i18n/index.js";

const STORAGE_KEY = "joi.uiLocale";
const listeners = new Set<() => void>();
let preference: UiLocalePreference = "system";
let systemLanguages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages;
let savePreference: ((value: UiLocalePreference) => Promise<void>) | undefined;
let failure = false;
let revision = 0;
let requestRevision = 0;
try { const saved = localStorage.getItem(STORAGE_KEY); if (isLocalePreference(saved)) preference = saved; } catch { /* Storage is optional in restricted browser contexts. */ }

export function currentLocale(): LocaleCode { return resolveLocale(preference, systemLanguages); }
if (typeof document !== "undefined") document.documentElement.lang = currentLocale();
function notify() {
  revision++;
  if (typeof document !== "undefined") document.documentElement.lang = currentLocale();
  for (const listener of listeners) listener();
}

export function configureLocale(input: { preference?: unknown; systemLanguages?: readonly string[]; save?: (value: UiLocalePreference) => Promise<void> }) {
  preference = isLocalePreference(input.preference) ? input.preference : "system";
  systemLanguages = input.systemLanguages ?? systemLanguages;
  savePreference = input.save;
  failure = false;
  requestRevision++;
  notify();
}

export function localeVersion(): number { return requestRevision; }
export function connectDesktopLocale(input: { preference?: unknown; systemLanguages: readonly string[]; save: (value: UiLocalePreference) => Promise<void> }, startedAt: number) {
  const changedDuringStartup = startedAt !== requestRevision;
  configureLocale({ ...input, preference: changedDuringStartup ? preference : input.preference });
  if (changedDuringStartup) void setLocalePreference(preference);
}

export async function setLocalePreference(value: UiLocalePreference): Promise<void> {
  if (!isLocalePreference(value)) return;
  const request = ++requestRevision;
  preference = value;
  failure = false;
  notify();
  try {
    if (savePreference !== undefined) {
      await savePreference(value);
      if (request === requestRevision) {
        try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Desktop settings are the durable authority. */ }
      }
    } else if (request === requestRevision) localStorage.setItem(STORAGE_KEY, value);
  } catch { if (request === requestRevision) { failure = true; notify(); } }
}

export function t<K extends MessageKey>(key: K, ...args: keyof MessageParameters[K] extends never ? [params?: MessageParameters[K]] : [params: MessageParameters[K]]): string {
  return translate(currentLocale(), key, ...args);
}
export function localizeProductText(value: string): string { return translateSource(currentLocale(), value); }
export interface MessageNotice { key: MessageKey; params?: Record<string, string | number> }
export function errorNotice(code: string, approvedSource?: string): MessageNotice {
  const knownCode = Object.hasOwn(errorKeys, code) ? errorKeys[code] : undefined;
  const knownText = approvedSource !== undefined && Object.hasOwn(sourceKeys, approvedSource) ? sourceKeys[approvedSource] : undefined;
  return { key: knownCode ?? knownText ?? "common.requestFailed" };
}
export function noticeMessage<K extends MessageKey>(key: K, ...args: keyof MessageParameters[K] extends never ? [params?: MessageParameters[K]] : [params: MessageParameters[K]]): MessageNotice {
  return { key, ...(args[0] === undefined ? {} : { params: args[0] }) };
}
export function useNotice() {
  useI18n();
  const [notice, setNotice] = useState<MessageNotice | string | null>(null);
  const rendered = notice === null ? null : typeof notice === "string" ? localizeProductText(notice) : translateNotice(notice);
  return [rendered, setNotice] as const;
}
export function translateNotice(notice: MessageNotice): string {
  return String(new IntlMessageFormat(catalogs[currentLocale()][notice.key], currentLocale()).format(notice.params));
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string { return new Intl.NumberFormat(currentLocale(), options).format(value); }
export function useI18n() {
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision, () => revision);
  return { locale: currentLocale(), preference, failed: failure, t, setPreference: setLocalePreference };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (savePreference === undefined && event.key === STORAGE_KEY) {
      preference = isLocalePreference(event.newValue) ? event.newValue : "system";
      notify();
    }
  });
  window.addEventListener("languagechange", () => {
    systemLanguages = navigator.languages;
    if (preference === "system") notify();
  });
}
export { languages };
