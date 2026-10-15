import { IntlMessageFormat } from "intl-messageformat";
import { catalogs, languages, sourceKeys, type LocaleCode, type MessageKey, type MessageParameters } from "./generated.js";

export { languages, type LocaleCode, type MessageKey, type MessageParameters } from "./generated.js";
export type UiLocalePreference = "system" | LocaleCode;
export interface UiMessage { code: string; params?: Record<string, string | number> }

export function isLocalePreference(value: unknown): value is UiLocalePreference {
  return value === "system" || languages.some((language) => language.code === value);
}

export function resolveLocale(preference: unknown, systemLanguages: readonly string[] = []): LocaleCode {
  if (preference !== "system" && languages.some((language) => language.code === preference)) return preference as LocaleCode;
  const primary = systemLanguages[0]?.toLowerCase() ?? "en";
  return languages.find((language) => language.code.toLowerCase() === primary)?.code
    ?? languages.find((language) => language.code.toLowerCase().split("-")[0] === primary.split("-")[0])?.code
    ?? "en";
}

const cache = new Map<string, IntlMessageFormat>();
export function translate<K extends MessageKey>(locale: LocaleCode, key: K, ...args: keyof MessageParameters[K] extends never ? [params?: MessageParameters[K]] : [params: MessageParameters[K]]): string {
  const message = catalogs[locale][key] || catalogs.en[key];
  const cacheKey = `${locale}:${key}`;
  let formatter = cache.get(cacheKey);
  if (formatter === undefined) { formatter = new IntlMessageFormat(message, locale); cache.set(cacheKey, formatter); }
  return String(formatter.format(args[0]));
}

/** Product-origin legacy notices are resolved at display time; user content never passes here. */
export function translateSource(locale: LocaleCode, source: string): string {
  const key = Object.hasOwn(sourceKeys, source) ? sourceKeys[source] : undefined;
  return key === undefined ? source : String(new IntlMessageFormat(catalogs[locale][key] || catalogs.en[key], locale).format());
}
