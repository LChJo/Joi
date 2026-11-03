// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { LanguageSelector } from "../../src/renderer/LanguageSelector";
import { ApiError } from "../../src/renderer/api";
import { configureLocale, connectDesktopLocale, localeVersion, setLocalePreference, t, useI18n, useNotice, noticeMessage } from "../../src/renderer/i18n";

function Example() {
  useI18n();
  return <><LanguageSelector /><input aria-label="draft" defaultValue="keep this draft" /><p>{t("common.itemCount", { count: 2 })}</p></>;
}

function NoticeExample() {
  const [notice, setNotice] = useNotice();
  return <><LanguageSelector /><button onClick={() => setNotice(noticeMessage("common.itemCount", { count: 2 }))}>notify</button><p role="status">{notice}</p></>;
}

describe("AC-I18N-03 live language selection", () => {
  it("explains model source URL and credential failures using safe localized messages", () => {
    configureLocale({ preference: "zh-CN" });
    const urlError = new ApiError("model_source_url_prohibited", "unapproved endpoint or secret", 400);
    expect(urlError.displayMessage).toBe("模型地址不受支持。请使用公网 HTTPS、本机 localhost/127.0.0.1，或明确的局域网 IPv4 地址（10.x、172.16–31.x、192.168.x）。");
    expect(new ApiError("model_source_key_required", "unapproved secret", 400).displayMessage).toBe("请填写 API Key；仅本机 localhost/127.0.0.1 可留空。");
    configureLocale({ preference: "en" });
    expect(urlError.displayMessage).toBe("Unsupported model URL. Use public HTTPS, localhost/127.0.0.1, or an explicit LAN IPv4 address (10.x, 172.16–31.x, 192.168.x).");
    expect(new ApiError("model_source_redirect_cross_origin", "unapproved redirect", 400).displayMessage).toBe("The model URL redirects to a different origin. Enter the final Base URL directly.");
  });

  it("AC-I18N-06 recognizes approved legacy messages without exposing arbitrary backend text", () => {
    configureLocale({ preference: "en" });
    expect(new ApiError("old_password_code", "当前密码不对。", 400).displayMessage).toBe("The current password is incorrect.");
    for (const code of ["unknown", "constructor", "toString", "__proto__"]) expect(new ApiError(code, "unapproved backend detail", 500).displayMessage).toBe("The request could not be completed. Please try again.");
  });
  it("keeps a language chosen while desktop authentication was in flight", async () => {
    const startupVersion = localeVersion();
    await setLocalePreference("en");
    const save = vi.fn(() => Promise.resolve());
    connectDesktopLocale({ preference: "zh-CN", systemLanguages: ["zh-CN"], save }, startupVersion);
    expect(t("common.language")).toBe("Language");
    expect(save).toHaveBeenCalledWith("en");
  });
  it("reformats an existing parameterized notice when language changes", () => {
    render(<NoticeExample />);
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(screen.getByRole("status")).toHaveTextContent("2 项");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
    expect(screen.getByRole("status")).toHaveTextContent("2 items");
  });
  it("shows failed persistence while preserving the selected language", async () => {
    configureLocale({ preference: "zh-CN", save: () => Promise.reject(new Error("offline")) });
    render(<Example />);
    await act(async () => { await setLocalePreference("en"); });
    expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.getByRole("combobox")).toHaveValue("en");
  });
  it("syncs browser tabs and system language without changing explicit choices", () => {
    render(<Example />);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "joi.uiLocale", newValue: "en" })); });
    expect(screen.getByText("2 items")).toBeInTheDocument();
    const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
    act(() => { window.dispatchEvent(new Event("languagechange")); });
    expect(screen.getByText("2 items")).toBeInTheDocument();
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "joi.uiLocale", newValue: "system" })); });
    expect(screen.getByRole("combobox")).toHaveValue("system");
    expect(screen.getByText("2 项")).toBeInTheDocument();
    languages.mockRestore();
  });
  it("updates text without remounting the draft", () => {
    configureLocale({ preference: "zh-CN", systemLanguages: ["en-US"] });
    render(<Example />);
    const draft = screen.getByRole("textbox");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(draft).toHaveValue("keep this draft");
    expect(document.documentElement.lang).toBe("en");
  });
  it("keeps the latest selection when persistence completes out of order", async () => {
    const saves: (() => void)[] = [];
    configureLocale({ preference: "zh-CN", systemLanguages: ["en"], save: () => new Promise<void>((resolve) => saves.push(resolve)) });
    let first: Promise<void>;
    let second: Promise<void>;
    act(() => { first = setLocalePreference("en"); second = setLocalePreference("zh-CN"); });
    saves[1]?.();
    await act(async () => { await second; });
    saves[0]?.();
    await act(async () => { await first; });
    expect(t("common.language")).toBe("语言");
  });
});
