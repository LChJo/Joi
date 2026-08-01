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
  vi.spyOn(api, "joiSnapshot").mockResolvedValue({
    avatarChanges: [],
    avatars: [],
    modelSources: [{
      accessMode: "api",
      activeModel: { capability: "release-tested", id: "deepseek-chat", revisionId: "model-1" },
      activeSourceRevisionId: "source-revision-1",
      credential: { configured: true, version: 1 },
      displayName: "DeepSeek",
      kind: "deepseek",
      protocol: "openai",
      order: 0,
      primary: true,
      sourceId: "source-1",
      status: "READY",
    }],
    partners: [],
    runtime: { configured: true, status: "READY" },
    work: [],
  });
  return api;
}

function formFor(element: HTMLElement) {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Expected a parent form.");
  return form;
}

describe("application gates", () => {
  it("reports a local service bootstrap failure and retries", async () => {
    vi.mocked(createApi).mockRejectedValueOnce(new ApiError("offline", "Runtime 离线", 503)).mockResolvedValueOnce({ api: readyApi(), configured: true, desktop: true });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("连不上本机服务");
    fireEvent.click(screen.getByRole("button", { name: "再试一次" }));
    expect(await screen.findByRole("heading", { name: "现在想让 joi 做什么？" })).toBeInTheDocument();
  });

  it("surfaces an unexpected bootstrap error without losing retry", async () => {
    vi.mocked(createApi).mockRejectedValue(new Error("unexpected bootstrap failure"));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("连不上本机服务");
    expect(screen.getByRole("button", { name: "再试一次" })).toBeEnabled();
  });

  it("routes LAN, desktop setup, and ready sessions to distinct surfaces", async () => {
    vi.mocked(createApi).mockResolvedValueOnce({ api: readyApi(), configured: true, desktop: false });
    const first = render(<App />);
    expect(await screen.findByRole("heading", { name: "确认是你" })).toBeInTheDocument();
    first.unmount();

    vi.mocked(createApi).mockResolvedValueOnce({ api: readyApi(), configured: false, desktop: true });
    const second = render(<App />);
    expect(await screen.findByRole("heading", { name: "先帮 joi 设个密码。" })).toBeInTheDocument();
    second.unmount();

    vi.mocked(createApi).mockResolvedValueOnce({ api: readyApi(), configured: false, desktop: false });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("请在本机窗口完成首次设置"));
  });

  it("enters the console after LAN login and desktop setup", async () => {
    const lanApi = readyApi();
    vi.spyOn(lanApi, "login").mockResolvedValue({ csrfToken: "csrf" });
    vi.mocked(createApi).mockResolvedValueOnce({ api: lanApi, configured: true, desktop: false });
    const lan = render(<App />);
    const password = await screen.findByLabelText("管理密码");
    fireEvent.change(password, { target: { value: "correct password" } });
    fireEvent.submit(formFor(password));
    expect(await screen.findByRole("heading", { name: "现在想让 joi 做什么？" })).toBeInTheDocument();
    lan.unmount();

    const desktopApi = readyApi();
    vi.spyOn(desktopApi, "setup").mockResolvedValue(undefined);
    vi.mocked(createApi).mockResolvedValueOnce({ api: desktopApi, configured: false, desktop: true });
    render(<App />);
    const first = await screen.findByLabelText("管理密码");
    fireEvent.change(first, { target: { value: "correct password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "correct password" } });
    fireEvent.submit(formFor(first));
    fireEvent.click(await screen.findByRole("button", { name: /先只用本机/ }));
    fireEvent.click(screen.getByRole("button", { name: "暂时跳过" }));
    expect(await screen.findByRole("heading", { name: "现在想让 joi 做什么？" })).toBeInTheDocument();
  });
});
