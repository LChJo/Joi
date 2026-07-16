// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../src/renderer/api", async (loadOriginal) => {
  const original = await loadOriginal<Record<string, unknown>>();
  return { ...original, createApi: vi.fn() };
});

import { App } from "../../src/renderer/App";
import { ApiError, DigitalLifeApi, createApi } from "../../src/renderer/api";

function readyApi() {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "listLives").mockResolvedValue({ items: [] });
  vi.spyOn(api, "listAgents").mockResolvedValue({ items: [] });
  vi.spyOn(api, "listInteractions").mockResolvedValue({ items: [] });
  vi.spyOn(api, "diagnostics").mockResolvedValue({ agents: { connections: 0 }, database: { journalMode: "wal", state: "open" }, runtime: { pendingOutbox: 0 }, schemaVersion: 4, sse: { events: 0 }, web: { sessions: 1 } });
  return api;
}

function formFor(element: HTMLElement) {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Expected a parent form.");
  return form;
}

describe("application gates", () => {
  it("reports Runtime bootstrap failure and retries", async () => {
    vi.mocked(createApi).mockRejectedValueOnce(new ApiError("offline", "Runtime 离线", 503)).mockResolvedValueOnce({ api: readyApi(), configured: true, desktop: true });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法连接");
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(await screen.findByRole("heading", { name: "你的数字生命" })).toBeInTheDocument();
  });

  it("surfaces an unexpected bootstrap error without losing retry", async () => {
    vi.mocked(createApi).mockRejectedValue(new Error("unexpected bootstrap failure"));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Runtime 没有响应");
    expect(screen.getByRole("button", { name: "重新连接" })).toBeEnabled();
  });

  it("routes LAN, desktop setup, and ready sessions to distinct surfaces", async () => {
    vi.mocked(createApi).mockResolvedValueOnce({ api: readyApi(), configured: true, desktop: false });
    const first = render(<App />);
    expect(await screen.findByRole("heading", { name: "管理员登录" })).toBeInTheDocument();
    first.unmount();

    vi.mocked(createApi).mockResolvedValueOnce({ api: readyApi(), configured: false, desktop: true });
    const second = render(<App />);
    expect(await screen.findByRole("heading", { name: "先守住进入这里的门。" })).toBeInTheDocument();
    second.unmount();

    vi.mocked(createApi).mockResolvedValueOnce({ api: readyApi(), configured: false, desktop: false });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("首次设置只能"));
  });

  it("enters the console after LAN login and desktop setup", async () => {
    const lanApi = readyApi();
    vi.spyOn(lanApi, "login").mockResolvedValue({ csrfToken: "csrf" });
    vi.mocked(createApi).mockResolvedValueOnce({ api: lanApi, configured: true, desktop: false });
    const lan = render(<App />);
    const password = await screen.findByLabelText("管理员口令");
    fireEvent.change(password, { target: { value: "correct password" } });
    fireEvent.submit(formFor(password));
    expect(await screen.findByRole("heading", { name: "你的数字生命" })).toBeInTheDocument();
    lan.unmount();

    const desktopApi = readyApi();
    vi.spyOn(desktopApi, "setup").mockResolvedValue(undefined);
    vi.mocked(createApi).mockResolvedValueOnce({ api: desktopApi, configured: false, desktop: true });
    render(<App />);
    const first = await screen.findByLabelText("管理员口令");
    fireEvent.change(first, { target: { value: "correct password" } });
    fireEvent.change(screen.getByLabelText("确认口令"), { target: { value: "correct password" } });
    fireEvent.submit(formFor(first));
    fireEvent.click(await screen.findByRole("button", { name: /保持关闭并继续/ }));
    fireEvent.click(screen.getByRole("button", { name: "暂时跳过" }));
    expect(await screen.findByRole("heading", { name: "你的数字生命" })).toBeInTheDocument();
  });
});
