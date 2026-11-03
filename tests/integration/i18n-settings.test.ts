import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SystemSettingsService } from "../../src/main/infrastructure/operations/system-settings-service.js";

describe("AC-I18N-04 desktop language persistence", () => {
  it("persists language without applying LAN or login settings", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "joi-i18n-"));
    const apply = vi.fn();
    const reconfigureLan = vi.fn();
    const setLaunchAtLogin = vi.fn();
    const dependencies = { settingsPath: path.join(directory, "settings.json"), getLaunchAtLogin: () => false, setLaunchAtLogin, reconfigureLan, setUiLocale: apply };
    try {
      const service = new SystemSettingsService(dependencies);
      expect((await service.get()).uiLocale).toBe("system");
      await service.update({ uiLocale: "en" });
      expect((await new SystemSettingsService(dependencies).get()).uiLocale).toBe("en");
      expect(apply).toHaveBeenCalledWith("en");
      expect(reconfigureLan).not.toHaveBeenCalled();
      expect(setLaunchAtLogin).not.toHaveBeenCalled();
      await expect(service.update({ uiLocale: "unsupported" as "en" })).rejects.toMatchObject({ code: "ui_locale_invalid" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
