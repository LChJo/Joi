import { resolveLocale, translate } from "../../src/shared/i18n/index.js";

describe("AC-I18N-01/02 message resources and locale resolution", () => {
  it("uses explicit preferences before system language and defaults to English", () => {
    expect(resolveLocale("system", ["zh-TW"])).toBe("zh-CN");
    expect(resolveLocale("system", ["fr-FR"])).toBe("en");
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("removed", ["zh-CN"])).toBe("zh-CN");
  });
  it("formats parameters and English plurals using the selected locale", () => {
    expect(translate("en", "common.itemCount", { count: 1 })).toBe("1 item");
    expect(translate("en", "common.itemCount", { count: 2 })).toBe("2 items");
    expect(translate("zh-CN", "common.itemCount", { count: 2 })).toBe("2 项");
  });
});
