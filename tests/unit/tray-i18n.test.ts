import { trayMenuTemplate } from "../../src/main/infrastructure/operations/tray-menu.js";

describe("AC-I18N-04 native tray localization", () => {
  it("uses the current language while preserving actions and login state", () => {
    const actions = { open: vi.fn(), stop: vi.fn(), quit: vi.fn(), setLaunchAtLogin: vi.fn() };
    const english = trayMenuTemplate("en", ["zh-CN"], true, actions);
    expect(english.filter((item) => item.type !== "separator").map((item) => item.label)).toEqual(["Open joi", "Emergency stop all agents", "Launch at login", "Quit joi"]);
    const checkbox = english.find((item) => item.type === "checkbox");
    expect(checkbox?.checked).toBe(true);
    checkbox?.click({ checked: false });
    expect(actions.setLaunchAtLogin).toHaveBeenCalledWith(false);
    const chinese = trayMenuTemplate("zh-CN", ["en"], false, actions);
    expect(chinese.filter((item) => item.type !== "separator").map((item) => item.label)).toEqual(["打开 joi", "紧急停止全部智能体", "开机时启动", "退出 joi"]);
    for (const item of chinese) if (item.type === "normal") item.click();
    expect(actions.open).toHaveBeenCalledOnce();
    expect(actions.stop).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();
  });
});
