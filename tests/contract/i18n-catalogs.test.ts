import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { catalogStats, generatedFiles, loadCatalogs, runMaintenance, type CatalogData } from "../../scripts/i18n.mjs";

const fixture = (): CatalogData => ({
  manifest: { source: "en", languages: [{ code: "en", name: "English", enabled: true }, { code: "zh-CN", name: "简体中文", enabled: true }, { code: "fr", name: "Français", enabled: false }] },
  definitions: { "common.hello": { message: "Hello {name}", description: "Greeting", placeholders: { name: "string" } }, "common.count": { message: "{count, plural, one {{count} item} other {{count} items}}", placeholders: { count: "number" } }, "common.empty": { message: "Empty" } },
  catalogs: { en: { "common.hello": "Hello {name}", "common.count": "{count, plural, one {{count} item} other {{count} items}}", "common.empty": "Empty" }, "zh-CN": { "common.hello": "你好，{name}", "common.count": "{count} 项", "common.empty": "空" }, fr: { "common.hello": "Bonjour {other}", "common.empty": "", "other.orphan": "Extra" } },
});

describe("AC-I18N-01 catalog maintenance", () => {
  it("maintains locales and keys in an isolated project and retires generated aliases", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "joi-i18n-cli-"));
    try {
      for (const locale of ["en", "zh-CN"]) {
        await mkdir(path.join(project, "resources/locales", locale), { recursive: true });
        await writeFile(path.join(project, "resources/locales", locale, "common.json"), JSON.stringify({ hello: locale === "en" ? { message: "Hello" } : "你好" }));
      }
      await writeFile(path.join(project, "resources/locales/manifest.json"), JSON.stringify({ source: "en", languages: [{ code: "en", name: "English", enabled: true }, { code: "zh-CN", name: "简体中文", enabled: true }] }));
      await runMaintenance(["generate"], project);
      await runMaintenance(["locale", "add", "fr", "Français"], project);
      await expect(runMaintenance(["locale", "enable", "fr"], project)).rejects.toThrow("Complete translations");
      await runMaintenance(["locale", "remove", "zh-CN"], project);
      await expect(readFile(path.join(project, "apps/joi_mobile/l10n/app_zh.arb"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(runMaintenance(["locale", "remove", "en"], project)).rejects.toThrow("Cannot remove");
      await runMaintenance(["key", "add", "common.welcome", "Hello {name}"], project);
      expect((await loadCatalogs(path.join(project, "resources/locales"))).definitions["common.welcome"]?.placeholders).toEqual({ name: "string" });
      await mkdir(path.join(project, "src/main"), { recursive: true });
      await writeFile(path.join(project, "src/main/use.ts"), 'translate(locale, "common.welcome", { name: "test" });');
      await expect(runMaintenance(["key", "remove", "common.welcome"], project)).rejects.toThrow("still referenced");
      await runMaintenance(["generate"], project);
      await writeFile(path.join(project, "src/main/use.ts"), 'const label = t("common.missing");');
      await expect(runMaintenance(["check"], project)).rejects.toThrow("Unknown message reference");
    } finally { await rm(project, { recursive: true, force: true }); }
  });
  it("counts actual valid translations without counting fallback as translated", () => {
    const stats = catalogStats(fixture());
    expect(stats[0]).toMatchObject({ total: 3, translated: 3, coverage: 100 });
    expect(stats[1]).toMatchObject({ total: 3, translated: 3, coverage: 100 });
    expect(stats[2]).toMatchObject({ translated: 0, coverage: 0, missing: ["common.count"], empty: ["common.empty"], invalid: ["common.hello"], extra: ["other.orphan"] });
  });
  it("rejects incompatible ICU constructs and malformed messages", () => {
    for (const message of ["{broken", "{count, number}", "{name, date}", "<b>{name}</b>", "{count, plural, one {# item} other {# items}}", "{count, plural, offset:1 one {item} other {items}}", "{name, plural, one {item} other {items}}"] ) {
      const data = fixture();
      if (data.catalogs.fr !== undefined) data.catalogs.fr["common.hello"] = message;
      expect(catalogStats(data)[2]?.invalid).toContain("common.hello");
    }
  });
  it("generates only enabled languages with Flutter region fallbacks and typed parameters", () => {
    const files = generatedFiles(fixture());
    const output = files.get("src/shared/i18n/generated.ts");
    expect(output).toContain('"count": number');
    expect(output).not.toContain('"code": "fr"');
    expect(files.has("apps/joi_mobile/l10n/app_zh.arb")).toBe(true);
    expect(JSON.parse(files.get("apps/joi_mobile/l10n/app_zh_CN.arb") ?? "{}")).toMatchObject({ commonCount: "{count} 项" });
    expect(files.get("apps/joi_mobile/lib/i18n_messages.dart")).toContain("parameters[\"count\"] as num");
  });
  it("loads resource folders and refuses duplicate or unsafe locale registration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "joi-catalog-"));
    try {
      await mkdir(path.join(directory, "en"));
      await writeFile(path.join(directory, "en/common.json"), JSON.stringify({ title: { message: "Title" } }));
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ source: "en", languages: [{ code: "en", name: "English", enabled: true }] }));
      expect((await loadCatalogs(directory)).definitions["common.title"]?.message).toBe("Title");
      for (const code of ["../outside", "en"]) {
        await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ source: "en", languages: [{ code: "en", name: "English", enabled: true }, { code, name: "Invalid", enabled: false }] }));
        await expect(loadCatalogs(directory)).rejects.toThrow("Invalid or duplicate");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps committed translations complete and generated artifacts in sync", async () => {
    const data = await loadCatalogs();
    for (const report of catalogStats(data).filter((report) => report.enabled)) expect(report).toMatchObject({ coverage: 100, invalid: [], extra: [] });
    for (const [file, content] of generatedFiles(data)) expect(await readFile(path.resolve(file), "utf8"), file).toBe(content);
  });
});
