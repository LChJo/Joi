// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api";
import { AccessScreen, SetupJourney } from "../../src/renderer/Onboarding";
import type { AgentDto } from "../../src/renderer/types";

const onboarded: AgentDto = { agentConnectionId: "agent_1", name: "Mana", readiness: true, status: "ACTIVE", updatedAt: "2026-07-15T12:00:00Z" };

function formFor(element: HTMLElement) {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Expected a parent form.");
  return form;
}

describe("onboarding and access", () => {
  it("uses a six-character minimum for administrator password fields", () => {
    const api = new DigitalLifeApi("");
    const login = render(<AccessScreen api={api} onAuthenticated={vi.fn()} />);
    expect(screen.getByLabelText("管理密码")).toHaveAttribute("minLength", "6");
    login.unmount();

    render(<SetupJourney api={api} onComplete={vi.fn()} />);
    expect(screen.getByLabelText("管理密码")).toHaveAttribute("minLength", "6");
    expect(screen.getByLabelText("确认密码")).toHaveAttribute("minLength", "6");
  });

  it("sets the local administrator, explains LAN, and connects an Agent", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "setup").mockResolvedValue(undefined);
    vi.spyOn(api, "addAgent").mockResolvedValue(onboarded);
    const complete = vi.fn();
    render(<SetupJourney api={api} onComplete={complete} />);
    fireEvent.change(screen.getByLabelText("管理密码"), { target: { value: "long-password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "different" } });
    fireEvent.submit(formFor(screen.getByLabelText("管理密码")));
    expect(screen.getByRole("alert")).toHaveTextContent("不一致");
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "long-password" } });
    fireEvent.submit(formFor(screen.getByLabelText("管理密码")));
    expect(await screen.findByRole("heading", { name: "其他设备也要来找 joi 吗？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.submit(formFor(screen.getByLabelText("管理密码")));
    fireEvent.click(await screen.findByRole("button", { name: /先只用本机/ }));
    fireEvent.change(screen.getByLabelText(/Agent Card URL/), { target: { value: "http://192.168.1.2/card.json" } });
    fireEvent.change(screen.getByLabelText(/Bearer Token/), { target: { value: "token" } });
    fireEvent.submit(formFor(screen.getByLabelText(/Agent Card URL/)));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  });

  it("logs a LAN browser in and exposes a clear authentication failure", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "login").mockRejectedValueOnce(new ApiError("login_invalid", "密码不正确", 401)).mockResolvedValue({ csrfToken: "csrf" });
    const authenticated = vi.fn();
    render(<AccessScreen api={api} onAuthenticated={authenticated} />);
    fireEvent.change(screen.getByLabelText("管理密码"), { target: { value: "wrong-password" } });
    fireEvent.submit(formFor(screen.getByLabelText("管理密码")));
    expect(await screen.findByRole("alert")).toHaveTextContent("密码不正确");
    fireEvent.submit(formFor(screen.getByLabelText("管理密码")));
    await waitFor(() => expect(authenticated).toHaveBeenCalledOnce());
  });

  it("keeps setup and Agent failures actionable and allows an explicit skip", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "setup").mockRejectedValueOnce(new ApiError("save_failed", "密码无法保存", 500)).mockResolvedValue(undefined);
    vi.spyOn(api, "addAgent").mockRejectedValue(new Error("offline"));
    const complete = vi.fn();
    render(<SetupJourney api={api} onComplete={complete} />);
    fireEvent.change(screen.getByLabelText("管理密码"), { target: { value: "long-password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "long-password" } });
    fireEvent.submit(formFor(screen.getByLabelText("管理密码")));
    expect(await screen.findByRole("alert")).toHaveTextContent("密码无法保存");
    fireEvent.submit(formFor(screen.getByLabelText("管理密码")));
    fireEvent.click(await screen.findByRole("button", { name: /先只用本机/ }));
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.click(screen.getByRole("button", { name: /先只用本机/ }));
    fireEvent.change(screen.getByLabelText(/Agent Card URL/), { target: { value: "http://192.168.1.2/card.json" } });
    fireEvent.change(screen.getByLabelText(/Bearer Token/), { target: { value: "token" } });
    fireEvent.submit(formFor(screen.getByLabelText(/Agent Card URL/)));
    expect(await screen.findByRole("alert")).toHaveTextContent("没连上这位搭档");
    fireEvent.click(screen.getByRole("button", { name: "暂时跳过" }));
    expect(complete).toHaveBeenCalledOnce();
  });

  it("uses generic recovery copy for unexpected login and setup failures", async () => {
    const loginApi = new DigitalLifeApi("");
    vi.spyOn(loginApi, "login").mockRejectedValue(new Error("unexpected"));
    const login = render(<AccessScreen api={loginApi} onAuthenticated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("管理密码"), { target: { value: "long-password" } });
    fireEvent.submit(formFor(screen.getByLabelText("管理密码")));
    expect(await screen.findByRole("alert")).toHaveTextContent("没验证成功");
    login.unmount();

    const setupApi = new DigitalLifeApi("");
    vi.spyOn(setupApi, "setup").mockRejectedValue(new Error("unexpected"));
    render(<SetupJourney api={setupApi} onComplete={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("管理密码"), { target: { value: "long-password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "long-password" } });
    fireEvent.submit(formFor(screen.getByLabelText("管理密码")));
    expect(await screen.findByRole("alert")).toHaveTextContent("密码没存上");
  });
});
