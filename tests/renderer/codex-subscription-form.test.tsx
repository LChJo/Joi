// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { CodexSubscriptionForm } from "../../src/renderer/CodexSubscriptionForm.js";
import { ModelSourceManager } from "../../src/renderer/JoiHome.js";
import { ApiError, DigitalLifeApi } from "../../src/renderer/api.js";
import { CODEX_AUTHORIZATION_WINDOW } from "../../src/shared/codex-authorization.js";
import type { CodexLoginDto, ModelSourceDto } from "../../src/shared/joi.js";

const attemptId = "codex-attempt";
const browserUrl = "https://auth.openai.com/oauth/authorize?state=fixture";
const deviceUrl = "https://auth.openai.com/codex/device";
const callbackUrl = "http://localhost:1455/auth/callback?code=fixture&state=fixture";
const browserButton = "使用 ChatGPT 登录";
const deviceButton = "使用设备码";
const authorizationLink = "在浏览器中打开授权页";
const callbackLabel = "回调网址（仅在浏览器无法返回时粘贴）";
const statusUnavailable = "暂时无法获取 Codex 授权状态。";

function setup(sourceId?: string) {
  const api = new DigitalLifeApi("", true);
  const start = vi.spyOn(api, "startCodexLogin");
  const status = vi.spyOn(api, "codexLoginStatus");
  const submit = vi.spyOn(api, "completeCodexCallback").mockResolvedValue(undefined);
  const cancel = vi.spyOn(api, "cancelCodexLogin").mockResolvedValue(undefined);
  const onCancel = vi.fn();
  const onConnected = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const view = render(<CodexSubscriptionForm api={api} {...(sourceId === undefined ? {} : { sourceId })} onCancel={onCancel} onConnected={onConnected} />);
  return { start, status, submit, cancel, onCancel, onConnected, ...view };
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}

async function chooseCodexAction(name: string) {
  await click("Codex 更多操作");
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name }));
    await Promise.resolve();
  });
}

async function poll() {
  await act(() => vi.advanceTimersByTimeAsync(1000));
}

function codexSource(status: ModelSourceDto["status"]): ModelSourceDto {
  return {
    accessMode: "coding-plan",
    activeModel: { capability: "release-tested", id: "gpt-6.1-sol", revisionId: "model-r1" },
    activeSourceRevisionId: "source-r1",
    credential: { configured: true, version: 1 },
    displayName: "Codex",
    kind: "codex",
    order: 0,
    primary: true,
    protocol: "openai",
    sourceId: "codex-source",
    status,
  };
}

describe("Codex subscription form", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens the approved browser page and lets the user retry a rejected callback", async () => {
    const { start, status, submit, onCancel, cancel, unmount } = setup();
    start.mockResolvedValue({ attemptId, status: "browser", url: browserUrl, acceptsCallback: false });
    status.mockResolvedValueOnce({ attemptId, status: "browser", url: browserUrl, acceptsCallback: true });
    submit.mockRejectedValueOnce(new ApiError("codex_callback_invalid", "Fixture rejected", 400));
    await click(browserButton);
    expect(start).toHaveBeenCalledExactlyOnceWith("browser", undefined);
    expect(screen.getByRole("link", { name: authorizationLink })).toHaveAttribute("href", browserUrl);
    expect(screen.getByRole("link", { name: authorizationLink })).toHaveAttribute("target", CODEX_AUTHORIZATION_WINDOW);
    expect(screen.queryByLabelText(callbackLabel)).toBeNull();

    await poll();
    const callback = screen.getByLabelText(callbackLabel);
    fireEvent.change(callback, { target: { value: callbackUrl } });
    await click("提交回调网址");
    expect(screen.getByRole("alert")).toHaveTextContent("请粘贴本次授权返回的完整回调网址。");
    expect(callback).toHaveValue(callbackUrl);
    await click("提交回调网址");
    expect(submit.mock.calls).toEqual([[attemptId, callbackUrl], [attemptId, callbackUrl]]);
    expect(callback).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();

    await click("取消");
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(attemptId);
  });

  it.each([
    ["READY", "已连接，joi 可以开始思考了。"],
    ["NEEDS_AUTH", "已保存 Codex 订阅。请在模型网络中检查连接状态。"],
  ] as const)("finishes device sign-in with source status %s and reloads settings", async (sourceStatus, expectedMessage) => {
    const { start, status, onConnected, cancel, unmount } = setup("codex-source");
    start.mockResolvedValue({ attemptId, status: "device_code", url: deviceUrl, userCode: "FIXTURE-CODE" });
    status.mockResolvedValueOnce({ attemptId, status: "validating" });
    status.mockResolvedValueOnce({ attemptId, status: "completed", source: codexSource(sourceStatus) });
    await click(deviceButton);
    expect(start).toHaveBeenCalledExactlyOnceWith("device_code", "codex-source");
    expect(screen.getByText("FIXTURE-CODE")).toBeVisible();
    expect(screen.getByRole("link", { name: authorizationLink })).toHaveAttribute("href", deviceUrl);

    await poll();
    expect(screen.getByRole("status")).toHaveTextContent("正在检查连接");
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    await poll();
    expect(screen.getByRole("status")).toHaveTextContent(expectedMessage);
    expect(onConnected).toHaveBeenCalledTimes(1);
    await poll();
    expect(status).toHaveBeenCalledTimes(2);
    unmount();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("recovers from a transient polling error and stops on a lost desktop session", async () => {
    const { start, status, cancel } = setup();
    start.mockResolvedValue({ attemptId, status: "starting" });
    status.mockRejectedValueOnce(new Error("Synthetic connection reset"));
    status.mockResolvedValueOnce({ attemptId, status: "browser", url: "https://example.invalid/oauth/authorize", acceptsCallback: false });
    status.mockRejectedValueOnce(new ApiError("unauthorized", "Expired desktop session", 401));
    await click(browserButton);
    await poll();
    expect(screen.getByRole("alert")).toHaveTextContent(statusUnavailable);
    await poll();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("link", { name: authorizationLink })).toBeNull();
    await poll();
    expect(screen.getByRole("alert")).toHaveTextContent(statusUnavailable);
    expect(screen.getByRole("button", { name: browserButton })).toBeEnabled();
    await poll();
    expect(status).toHaveBeenCalledTimes(3);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "Codex 授权未完成，请重试。"],
    ["expired", "Codex 授权已超时，请重新登录。"],
    ["canceled", undefined],
  ] as const)("stops polling a %s attempt and allows another sign-in", async (terminalStatus, expectedMessage) => {
    const { start, status, cancel, unmount } = setup();
    start.mockResolvedValue({ attemptId, status: "starting" });
    status.mockResolvedValueOnce({ attemptId, status: terminalStatus });
    await click(browserButton);
    await poll();
    expect(screen.queryByRole("alert")?.textContent).toBe(expectedMessage);
    expect(screen.getByRole("button", { name: browserButton })).toBeEnabled();
    await poll();
    expect(status).toHaveBeenCalledTimes(1);
    unmount();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("distinguishes a busy attempt from other start failures", async () => {
    const { start } = setup();
    start.mockRejectedValueOnce(new ApiError("codex_login_busy", "Busy", 409));
    start.mockRejectedValueOnce(new ApiError("other", "Fixture error", 503));
    await click(browserButton);
    expect(screen.getByRole("alert")).toHaveTextContent("已有 Codex 授权正在进行");
    await click(deviceButton);
    expect(screen.getByRole("alert")).toHaveTextContent("Codex 授权未完成，请重试。");
  });

  it("cancels a delayed start after the form has been closed", async () => {
    const { start, status, cancel, unmount } = setup();
    const pending = Promise.withResolvers<CodexLoginDto>();
    start.mockReturnValue(pending.promise);
    await click(browserButton);
    expect(screen.getByRole("button", { name: deviceButton })).toBeDisabled();
    unmount();
    await act(async () => {
      pending.resolve({ attemptId, status: "starting" });
      await pending.promise;
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(attemptId);
    expect(status).not.toHaveBeenCalled();
  });

  it("aborts an in-flight poll on close and ignores its late result", async () => {
    const { start, status, cancel, onConnected, unmount } = setup();
    const pending = Promise.withResolvers<CodexLoginDto>();
    start.mockResolvedValue({ attemptId, status: "starting" });
    status.mockReturnValueOnce(pending.promise);
    await click(browserButton);
    await poll();
    const signal = status.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve({ attemptId, status: "completed", source: codexSource("READY") });
      await pending.promise;
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(attemptId);
    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe("Codex subscription model settings", () => {
  it("validates the edited model once after saving, and renders the returned availability", async () => {
    const api = new DigitalLifeApi("", true);
    const original = codexSource("READY");
    const draft: ModelSourceDto = { ...original, status: "DRAFT", activeSourceRevisionId: "source-r2", activeModel: { ...original.activeModel, id: "gpt-6.2-sol", revisionId: "model-r2" } };
    const validation = Promise.withResolvers<ModelSourceDto>();
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [original] });
    vi.spyOn(api, "listPartners").mockResolvedValue({ items: [] });
    const update = vi.spyOn(api, "updateModelSource").mockResolvedValue(draft);
    const validate = vi.spyOn(api, "validateModelSource").mockReturnValue(validation.promise);
    render(<ModelSourceManager api={api} />);
    await screen.findByText("Codex");
    await chooseCodexAction("编辑");
    const model = screen.getByLabelText("编辑 Model ID");
    fireEvent.change(model, { target: { value: "gpt-6.2-sol" } });
    const form = model.closest("form");
    if (form === null) throw new Error("Missing model settings form");
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
      await Promise.resolve();
    });
    expect(validate).toHaveBeenCalledExactlyOnceWith(original.sourceId);
    expect(update).toHaveBeenCalledTimes(1);
    expect(screen.getByText("正在验证")).toBeVisible();
    expect(screen.getByRole("button", { name: "验证" })).toBeDisabled();
    await act(async () => {
      validation.resolve({ ...draft, status: "READY" });
      await validation.promise;
    });
    expect(screen.getByText(/gpt-6\.2-sol/)).toBeVisible();
    expect(screen.getByText("可用")).toBeVisible();
  });

  it("keeps ordering and validation on the card and other actions in the menu", async () => {
    const api = new DigitalLifeApi("", true);
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [codexSource("READY")] });
    vi.spyOn(api, "listPartners").mockResolvedValue({ items: [] });
    const remove = vi.spyOn(api, "deleteModelSource").mockResolvedValue(undefined);
    render(<ModelSourceManager api={api} />);
    await screen.findByText("Codex");
    expect(screen.getByRole("button", { name: "上移" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "验证" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /编辑|重新登录|停用|删除/u })).toBeNull();
    await click("Codex 更多操作");
    expect(remove).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["编辑", "重新登录 Codex", "停用", "删除"]);
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "删除" }));
      await Promise.resolve();
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith("codex-source");
  });

  it("enables a disabled source through validation and restores the validation action when ready", async () => {
    const api = new DigitalLifeApi("", true);
    const list = vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [codexSource("DISABLED")] });
    vi.spyOn(api, "listPartners").mockResolvedValue({ items: [] });
    const ready = codexSource("READY");
    const validate = vi.spyOn(api, "validateModelSource").mockImplementation(() => {
      list.mockResolvedValue({ items: [ready] });
      return Promise.resolve(ready);
    });
    render(<ModelSourceManager api={api} />);
    expect(await screen.findByText("已停用")).toBeVisible();
    expect(screen.queryByRole("button", { name: "验证" })).toBeNull();
    await click("启用");
    expect(validate).toHaveBeenCalledExactlyOnceWith(ready.sourceId);
    expect(screen.getByText("可用")).toBeVisible();
    expect(screen.getByRole("button", { name: "验证" })).toBeEnabled();
  });

  it("preserves masked account details across reorder and reconnects the selected source", async () => {
    const api = new DigitalLifeApi("", true);
    const codex = { ...codexSource("NEEDS_AUTH"), reasonCode: "auth_failed" };
    const fallback: ModelSourceDto = {
      ...codexSource("READY"),
      accessMode: "api",
      displayName: "Fallback",
      kind: "kimi",
      order: 1,
      primary: false,
      sourceId: "fallback",
    };
    const codexAccount = { expiresAt: "2026-11-21T00:00:00.000Z", maskedAccount: "••••1234", plan: "Plus" };
    const list = vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [{ ...codex, codexAccount }, fallback] });
    vi.spyOn(api, "listPartners").mockResolvedValue({ items: [] });
    const order = vi.spyOn(api, "orderModelSources").mockResolvedValue({
      items: [{ ...fallback, order: 0, primary: true }, { ...codex, order: 1, primary: false }],
    });
    const start = vi.spyOn(api, "startCodexLogin").mockResolvedValue({ attemptId, status: "starting" });
    const cancel = vi.spyOn(api, "cancelCodexLogin").mockResolvedValue(undefined);
    render(<ModelSourceManager api={api} />);
    expect(await screen.findByText("账号 ••••1234")).toBeVisible();
    expect(screen.getByText("套餐 Plus")).toBeVisible();
    expect(screen.getByText(/Codex 订阅授权已失效/)).toBeVisible();
    expect(list).toHaveBeenCalledExactlyOnceWith(true);

    const actions = screen.getByRole("group", { name: /Codex/ });
    await act(async () => {
      fireEvent.click(within(actions).getByRole("button", { name: "下移" }));
      await Promise.resolve();
    });
    expect(order).toHaveBeenCalledExactlyOnceWith(["fallback", codex.sourceId]);
    expect(screen.getByText("账号 ••••1234")).toBeVisible();
    expect(screen.getByText("套餐 Plus")).toBeVisible();

    await chooseCodexAction("编辑");
    expect(screen.getByLabelText("编辑 Model ID")).toBeVisible();
    expect(screen.queryByLabelText(/替换 API Key/)).toBeNull();
    await chooseCodexAction("重新登录 Codex");
    expect(screen.queryByLabelText("编辑 Model ID")).toBeNull();
    await click(browserButton);
    expect(start).toHaveBeenCalledExactlyOnceWith("browser", codex.sourceId);
    await click("取消");
    expect(cancel).toHaveBeenCalledExactlyOnceWith(attemptId);
  });
});
