// @vitest-environment jsdom
/* React act waits for the form's asynchronous handlers. */
/* eslint-disable @typescript-eslint/require-await */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CodexSubscriptionForm } from "../../src/renderer/CodexSubscriptionForm.js";
import { ModelSourceSetup } from "../../src/renderer/JoiHome.js";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import { ANTIGRAVITY_AUTHORIZATION_WINDOW } from "../../src/shared/antigravity-authorization.js";

describe("Antigravity subscription form", () => {
  it("uses Google authorization and submits the callback to its own API", async () => {
    vi.useFakeTimers();
    const api = new DigitalLifeApi("", true);
    const start = vi.spyOn(api, "startAntigravityLogin").mockResolvedValue({
      attemptId: "anti-login", status: "browser", acceptsCallback: true, url: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
    });
    const status = vi.spyOn(api, "antigravityLoginStatus").mockResolvedValue({ attemptId: "anti-login", status: "failed" });
    const submit = vi.spyOn(api, "completeAntigravityCallback").mockResolvedValue(undefined);
    const cancel = vi.spyOn(api, "cancelAntigravityLogin").mockResolvedValue(undefined);
    const view = render(<CodexSubscriptionForm provider="antigravity" api={api} onCancel={() => undefined} onConnected={() => Promise.resolve()} />);
    try {
      expect(screen.queryByRole("button", { name: "使用设备码" })).toBeNull();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "使用 Google 登录" })); });
      expect(start).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(screen.getByRole("link")).toHaveAttribute("target", ANTIGRAVITY_AUTHORIZATION_WINDOW);
      const callback = "http://localhost:51121/oauth-callback?code=fixture&state=fixture";
      fireEvent.change(screen.getByLabelText("回调网址（仅在浏览器无法返回时粘贴）"), { target: { value: callback } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "提交回调网址" })); });
      expect(submit).toHaveBeenCalledExactlyOnceWith("anti-login", callback);
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(status).toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent("反重力登录失败");
    } finally { view.unmount(); vi.useRealTimers(); }
    expect(cancel).not.toHaveBeenCalled();
  });

  it("adds a specific hint for a bounded reason code and falls back without one", async () => {
    vi.useFakeTimers();
    const api = new DigitalLifeApi("", true);
    vi.spyOn(api, "startAntigravityLogin").mockResolvedValue({
      attemptId: "anti-login", status: "browser", acceptsCallback: true, url: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
    });
    const status = vi.spyOn(api, "antigravityLoginStatus");
    status.mockResolvedValue({ attemptId: "anti-login", status: "failed", reasonCode: "token_exchange_rejected" });
    const view = render(<CodexSubscriptionForm provider="antigravity" api={api} onCancel={() => undefined} onConnected={() => Promise.resolve()} />);
    try {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "使用 Google 登录" })); });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(screen.getByRole("status")).toHaveTextContent("Google 拒绝了授权凭据");
      expect(screen.queryByText(/synthetic|private-/u)).toBeNull();
      view.unmount();

      const unmapped = render(<CodexSubscriptionForm provider="antigravity" api={api} onCancel={() => undefined} onConnected={() => Promise.resolve()} />);
      status.mockResolvedValue({ attemptId: "anti-login", status: "failed", reasonCode: "totally_unmapped_code" });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "使用 Google 登录" })); });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("alert")).toHaveTextContent("反重力登录失败");
      unmapped.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("offers subscription sign-in on desktop and omits it from LAN setup", () => {
    const changed = () => Promise.resolve();
    const desktop = render(<ModelSourceSetup api={new DigitalLifeApi("", true)} changed={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "连接 反重力订阅" }));
    expect(screen.getByRole("button", { name: "使用 Google 登录" })).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).toBeNull();
    desktop.unmount();
    render(<ModelSourceSetup api={new DigitalLifeApi("", false)} changed={changed} />);
    expect(screen.queryByRole("button", { name: "连接 反重力订阅" })).toBeNull();
  });
});
