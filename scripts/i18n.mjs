import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";

const root = path.resolve(import.meta.dirname, "..");
const directory = path.join(root, "resources/locales");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = async (file, data) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(data, null, 2)}\n`); };
const identifier = (key) => key.replace(/\.([a-z])/g, (_, letter) => letter.toUpperCase());

function parameters(message, contract) {
  const names = new Set();
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.type === TYPE.literal) continue;
      if (node.type === TYPE.pound || node.type === TYPE.tag || node.type === TYPE.date || node.type === TYPE.time || node.type === TYPE.number || (node.type === TYPE.plural && (node.offset !== 0 || node.pluralType !== "cardinal"))) throw new Error("Use the shared ICU subset: arguments, cardinal plural, select");
      names.add(node.value);
      if (contract && node.type === TYPE.plural && contract[node.value] !== "number") throw new Error("Plural selectors require numeric parameters");
      if (contract && node.type === TYPE.select && contract[node.value] !== "string") throw new Error("Select selectors require string parameters");
      if (node.options) for (const option of Object.values(node.options)) visit(option.value);
    }
  };
  visit(parse(message));
  return [...names].sort();
}

export async function loadCatalogs(base = directory) {
  const manifest = await json(path.join(base, "manifest.json"));
  if (manifest.source !== "en" || !manifest.languages.some((item) => item.code === "en" && item.enabled)) throw new Error("English must remain the enabled source language");
  const codes = new Set();
  for (const language of manifest.languages) {
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language.code) || codes.has(language.code) || typeof language.name !== "string" || typeof language.enabled !== "boolean") throw new Error("Invalid or duplicate language registration");
    codes.add(language.code);
  }
  const catalogs = {};
  const definitions = {};
  for (const language of manifest.languages) {
    const messages = {};
    const languageDirectory = path.join(base, language.code);
    for (const filename of (await readdir(languageDirectory)).filter((file) => file.endsWith(".json")).sort()) {
      const namespace = filename.slice(0, -5);
      for (const [name, value] of Object.entries(await json(path.join(languageDirectory, filename)))) {
        const key = `${namespace}.${name}`;
        if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(key)) throw new Error(`Invalid key: ${key}`);
        messages[key] = typeof value === "string" ? value : value.message;
        if (typeof messages[key] !== "string") throw new Error(`Message must be a string: ${key}`);
        if (language.code === manifest.source) definitions[key] = typeof value === "string" ? { message: value } : value;
      }
    }
    catalogs[language.code] = messages;
  }
  return { manifest, catalogs, definitions };
}

export function catalogStats({ manifest, catalogs, definitions }) {
  const source = Object.keys(definitions);
  return manifest.languages.map((language) => {
    const messages = catalogs[language.code];
    const missing = source.filter((key) => messages[key] === undefined);
    const empty = source.filter((key) => messages[key] !== undefined && !messages[key].trim());
    const extra = Object.keys(messages).filter((key) => !definitions[key]);
    const invalid = [];
    for (const key of source) {
      if (!messages[key]?.trim()) continue;
      try {
        const contract = definitions[key].placeholders ?? {};
        const expected = Object.keys(contract).sort();
        if (Object.values(contract).some((type) => type !== "string" && type !== "number") || JSON.stringify(parameters(messages[key], contract)) !== JSON.stringify(expected)) invalid.push(key);
      } catch { invalid.push(key); }
    }
    const valid = source.filter((key) => !missing.includes(key) && !empty.includes(key) && !invalid.includes(key));
    const namespaces = {};
    for (const key of source) {
      const namespace = key.split(".")[0];
      namespaces[namespace] ??= { total: 0, translated: 0 };
      namespaces[namespace].total++;
      if (valid.includes(key)) namespaces[namespace].translated++;
    }
    return { locale: language.code, enabled: language.enabled, total: source.length, translated: valid.length, coverage: source.length ? Math.round(valid.length / source.length * 10000) / 100 : 100, missing, empty, extra, invalid, namespaces };
  });
}

export function generatedFiles({ manifest, catalogs, definitions }) {
  const enabled = manifest.languages.filter((language) => language.enabled);
  const output = new Map();
  const types = Object.entries(definitions).map(([key, definition]) => `  ${JSON.stringify(key)}: ${Object.keys(definition.placeholders ?? {}).length ? `{ ${Object.entries(definition.placeholders).map(([name, type]) => `${JSON.stringify(name)}: ${type === "number" ? "number" : "string"}`).join("; ")} }` : "undefined"};`).join("\n");
  const bundles = Object.fromEntries(enabled.map((language) => [language.code, Object.fromEntries(Object.keys(definitions).map((key) => [key, catalogs[language.code][key]?.trim() ? catalogs[language.code][key] : definitions[key].message]))]));
  const sourceKeys = Object.fromEntries(Object.entries(definitions).filter(([, value]) => !Object.keys(value.placeholders ?? {}).length).flatMap(([key, value]) => [[value.message.replaceAll("''", "'"), key], ...manifest.languages.flatMap((language) => catalogs[language.code][key] ? [[catalogs[language.code][key].replaceAll("''", "'"), key]] : []), ...(value.sourceText ? [[value.sourceText, key]] : [])]));
  const errorKeys = Object.fromEntries(Object.entries(definitions).filter(([, value]) => value.errorCode).map(([key, value]) => [value.errorCode, key]));
  output.set("src/shared/i18n/generated.ts", `// Generated by scripts/i18n.mjs. Edit resources/locales instead.\nexport const languages = ${JSON.stringify(enabled, null, 2)} as const;\nexport type LocaleCode = typeof languages[number]["code"];\nexport interface MessageParameters {\n${types}\n}\nexport type MessageKey = keyof MessageParameters;\nexport const catalogs: Record<LocaleCode, Record<MessageKey, string>> = ${JSON.stringify(bundles, null, 2)};\nexport const sourceKeys: Readonly<Record<string, MessageKey>> = ${JSON.stringify(sourceKeys, null, 2)};\nexport const errorKeys: Readonly<Record<string, MessageKey>> = ${JSON.stringify(errorKeys, null, 2)};\n`);
  const methodNames = Object.keys(definitions).map(identifier);
  if (new Set(methodNames).size !== methodNames.length) throw new Error("Dart message identifier collision");
  const dartString = (value) => JSON.stringify(value).replaceAll("$", "\\$");
  const cases = Object.entries(definitions).map(([key, definition]) => {
    const name = identifier(key);
    const args = Object.entries(definition.placeholders ?? {}).map(([parameter, type]) => `parameters[${dartString(parameter)}] as ${type === "number" ? "num" : "String"}`).join(", ");
    return `  Msg.${name} => localization.${name}${args ? `(${args})` : ""},`;
  }).join("\n");
  output.set("apps/joi_mobile/lib/i18n_messages.dart", `// Generated by scripts/i18n.mjs. Edit resources/locales instead.\nimport 'l10n/app_localizations.dart';\nenum Msg {\n${methodNames.map((name) => `  ${name},`).join("\n")}\n}\nconst uiLanguageNames = <String, String>{\n${enabled.map((language) => `  ${dartString(language.code)}: ${dartString(language.name)},`).join("\n")}\n};\nconst sourceMessageKeys = <String, Msg>{\n${Object.entries(sourceKeys).map(([source, key]) => `  ${dartString(source)}: Msg.${identifier(key)},`).join("\n")}\n};\nconst errorMessageKeys = <String, Msg>{\n${Object.entries(errorKeys).map(([code, key]) => `  ${dartString(code)}: Msg.${identifier(key)},`).join("\n")}\n};\nString formatUiMessage(AppLocalizations localization, Msg key, Map<String, Object> parameters) => switch(key) {\n${cases}\n};\n`);
  const arbLanguages = [...enabled];
  for (const language of enabled) {
    const base = language.code.split("-")[0];
    if (!arbLanguages.some((item) => item.code === base)) arbLanguages.push({ ...language, code: base, bundleCode: language.code });
  }
  for (const language of arbLanguages) {
    const arb = { "@@locale": language.code.replaceAll("-", "_") };
    for (const [key, definition] of Object.entries(definitions)) {
      const name = identifier(key);
      arb[name] = bundles[language.bundleCode ?? language.code][key];
      if (language.code === manifest.source) arb[`@${name}`] = { description: definition.description ?? key, placeholders: Object.fromEntries(Object.entries(definition.placeholders ?? {}).map(([parameter, type]) => [parameter, { type: type === "number" ? "num" : "String" }])) };
    }
    output.set(`apps/joi_mobile/l10n/app_${language.code.replaceAll("-", "_")}.arb`, `${JSON.stringify(arb, null, 2)}\n`);
  }
  return output;
}

async function generate(check, projectRoot = root) {
  const data = await loadCatalogs(path.join(projectRoot, "resources/locales"));
  const stats = catalogStats(data);
  if (stats.some((item) => item.enabled && (item.coverage !== 100 || item.extra.length))) throw new Error("Enabled languages must have valid, complete translations and no extra keys");
  const expected = generatedFiles(data);
  const arbDirectory = path.join(projectRoot, "apps/joi_mobile/l10n");
  for (const filename of await readdir(arbDirectory).catch((error) => { if (error.code === "ENOENT") return []; throw error; })) {
    if (!/^app_[A-Za-z0-9_]+\.arb$/.test(filename) || expected.has(`apps/joi_mobile/l10n/${filename}`)) continue;
    if (check) throw new Error(`Retired generated resource: ${filename}`);
    await rm(path.join(arbDirectory, filename));
  }
  for (const [filename, content] of expected) {
    const target = path.join(projectRoot, filename);
    if (check) { if (await readFile(target, "utf8").catch(() => "") !== content) throw new Error(`Generated resource differs: ${filename}`); }
    else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
  }
  if (check) {
    const dartKeys = new Set(Object.keys(data.definitions).map(identifier));
    const walk = async (folder) => {
      const entries = await readdir(folder, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      for (const entry of entries) {
        const target = path.join(folder, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "l10n") await walk(target); continue; }
        if (!/\.(tsx?|dart)$/.test(entry.name) || entry.name === "generated.ts" || entry.name === "i18n_messages.dart") continue;
        const source = await readFile(target, "utf8");
        const references = entry.name.endsWith(".dart")
          ? [...source.matchAll(/\bMsg\.(\w+)/g)].filter((match) => !dartKeys.has(match[1]))
          : [...source.matchAll(/\b(?:t|noticeMessage)\(\s*["']([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)["']/g)].filter((match) => !data.definitions[match[1]]);
        if (references.length) throw new Error(`Unknown message reference in ${path.relative(projectRoot, target)}: ${references[0][1]}`);
      }
    };
    await walk(path.join(projectRoot, "src"));
    await walk(path.join(projectRoot, "apps/joi_mobile/lib"));
  }
}

export async function runMaintenance(args, projectRoot = root) {
  const directory = path.join(projectRoot, "resources/locales");
  const [command, action, name] = args;
  if (command === "stats") {
    const stats = catalogStats(await loadCatalogs(directory));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    else for (const item of stats) process.stdout.write(`${item.locale}: ${item.translated}/${item.total} (${item.coverage}%) missing=${item.missing.length} empty=${item.empty.length} extra=${item.extra.length} invalid=${item.invalid.length}\n`);
    return;
  }
  if (command === "check" || command === "generate") { await generate(command === "check", projectRoot); return; }
  if (command === "locale") {
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(name ?? "")) throw new Error("Invalid locale");
    const data = await loadCatalogs(directory);
    const language = data.manifest.languages.find((item) => item.code === name);
    if (action === "add") {
      if (language) throw new Error("Language already registered");
      data.manifest.languages.push({ code: name, name: args[3] ?? name, enabled: false });
      for (const filename of await readdir(path.join(directory, "en"))) await save(path.join(directory, name, filename), Object.fromEntries(Object.keys(await json(path.join(directory, "en", filename))).map((key) => [key, ""])));
    } else if (action === "remove") {
      if (name === "en" || !language) throw new Error("Cannot remove the source or an unknown language");
      data.manifest.languages = data.manifest.languages.filter((item) => item.code !== name);
      const target = path.resolve(directory, name);
      if (path.dirname(target) !== path.resolve(directory)) throw new Error("Locale removal must stay inside the catalog directory");
      await rm(target, { recursive: true });
    } else if (action === "enable") {
      const report = catalogStats(data).find((item) => item.locale === name);
      if (!language || report?.coverage !== 100 || report.extra.length) throw new Error("Complete translations before enabling");
      language.enabled = true;
    } else throw new Error("Use locale add/remove/enable");
    await save(path.join(directory, "manifest.json"), data.manifest);
    await generate(false, projectRoot);
    return;
  }
  if (command === "sync") {
    const data = await loadCatalogs(directory);
    for (const language of data.manifest.languages.filter((item) => item.code !== "en")) for (const filename of await readdir(path.join(directory, "en"))) {
      const target = path.join(directory, language.code, filename);
      const current = await json(target).catch(() => ({}));
      for (const key of Object.keys(await json(path.join(directory, "en", filename)))) current[key] ??= "";
      await save(target, current);
    }
    return;
  }
  if (command === "key") {
    if (!/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(name ?? "")) throw new Error("Use namespace.camelCaseKey");
    const [namespace, key] = name.split(".");
    const data = await loadCatalogs(directory);
    if (action === "remove") {
      if (!data.definitions[name]) throw new Error("Unknown message key");
      const walk = async (folder) => {
        const entries = await readdir(folder, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
        for (const entry of entries) {
          const target = path.join(folder, entry.name);
          if (entry.isDirectory()) await walk(target);
          else if (/\.(tsx?|dart)$/.test(entry.name) && entry.name !== "generated.ts" && entry.name !== "i18n_messages.dart" && !entry.name.startsWith("app_localizations")) {
            const content = await readFile(target, "utf8");
            if (content.includes(name) || content.includes(`Msg.${identifier(name)}`) || data.definitions[name].sourceText && content.includes(data.definitions[name].sourceText)) throw new Error("Message is still referenced");
          }
        }
      };
      await walk(path.join(projectRoot, "src"));
      await walk(path.join(projectRoot, "apps/joi_mobile/lib"));
    } else if (action !== "add" || !args[3]) throw new Error("Use key add namespace.key English-message, or key remove namespace.key");
    for (const language of data.manifest.languages) {
      const target = path.join(directory, language.code, `${namespace}.json`);
      const current = await json(target).catch(() => ({}));
      if (action === "remove") delete current[key];
      else {
        if (current[key] !== undefined) throw new Error("Key already exists");
        const placeholders = Object.fromEntries(parameters(args[3]).map((parameter) => [parameter, "string"]));
        const visit = (nodes) => { for (const node of nodes) { if (node.type === TYPE.plural) placeholders[node.value] = "number"; if (node.options) for (const option of Object.values(node.options)) visit(option.value); } };
        visit(parse(args[3]));
        current[key] = language.code === "en" ? { message: args[3], description: name, ...(Object.keys(placeholders).length ? { placeholders } : {}) } : "";
      }
      await save(target, current);
    }
    return;
  }
  process.stdout.write("i18n: locale add <code> [name] | locale remove/enable <code> | key add <namespace.key> <English-message> | key remove <namespace.key> | sync | generate | stats [--json] | check\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await runMaintenance(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
