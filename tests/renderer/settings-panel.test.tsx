// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api.js";
import { ConsoleApp, RemoteAccessSettings, SettingsPanel, SystemPanel } from "../../src/renderer/Console.js";
import type { DiagnosticsDto } from "../../src/renderer/types";

const diagnostics: DiagnosticsDto = {
  agents: { connections: 0 },
  database: { integrity: "ok", journalMode: "wal", state: "ok" },
  runtime: { pendingOutbox: 0 },
  schemaVersion: 26,
  sse: { events: 0 },
  storage: { artifactsBytes: 0, backupsBytes: 0, databaseBytes: 0, diskAvailableBytes: 1, state: "ok" },
  web: { sessions: 1 },
};

const runtimeSettings = {
  lan: {
    address: "192.168.1.20",
    availableAddresses: [{ address: "192.168.1.20", available: true }],
    effective: { status: "disabled" as const },
    enabled: false,
    port: 43130,
    riskAccepted: false,
  },
  launchAtLogin: false,
};

function mockOperations(api: DigitalLifeApi) {
  vi.spyOn(api, "listBackups").mockResolvedValue({
    items: [{ backupId: "backup_1", createdAt: "2026-07-30T10:00:00.000Z", databaseBytes: 1_048_576, manifestHash: "a".repeat(64), schemaVersion: 26 }],
  });
  const listSessions = vi.spyOn(api, "listSessions").mockResolvedValue({
    items: [
      { createdAt: "2026-07-30T09:00:00.000Z", current: true, deviceId: "device_1", ipSummary: "", kind: "desktop", lastActivityAt: "2026-07-30T10:00:00.000Z" },
      { createdAt: "2026-07-30T09:00:00.000Z", current: false, deviceId: "device_2", ipSummary: "", kind: "lan", lastActivityAt: "2026-07-30T10:00:00.000Z" },
      { createdAt: "2026-07-30T09:00:00.000Z", current: false, deviceId: "device_3", ipSummary: "", kind: "desktop", lastActivityAt: "2026-07-30T10:00:00.000Z" },
    ],
  });
  vi.spyOn(api, "settings").mockResolvedValue(runtimeSettings);
  vi.spyOn(api, "remoteAccessStatus").mockResolvedValue({
    devices: [], enabled: false, hostId: "host-test", relayAuthenticationConfigured: false,
    relayUrl: "", status: "disabled",
  });
  vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [] });
  return { listSessions };
}

describe("settings panel", () => {
  it("groups settings into five accessible tabs with keyboard navigation", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["模型网络", "设备连接", "安全", "数据", "诊断"]);
    expect(screen.getByRole("tab", { name: "模型网络" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "模型网络" })).toBeInTheDocument();
    expect(screen.queryByText("其他设备访问")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "设备连接" }));
    expect(screen.getByRole("tabpanel", { name: "设备连接" })).toBeInTheDocument();
    expect(await screen.findByText("其他设备访问")).toBeInTheDocument();
    expect(screen.getByText("Joi 手机")).toBeInTheDocument();
    expect(screen.queryByText("管理密码与设备")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tab", { name: "设备连接" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "安全" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "安全" })).toHaveFocus();
    expect(await screen.findByText("管理密码与设备")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tab", { name: "安全" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "诊断" })).toHaveFocus();
    expect(await screen.findByRole("heading", { name: "joi 的运行状态" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tab", { name: "数据" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "诊断" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "诊断" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "数据" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "数据" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "模型网络" })).toHaveFocus();
    fireEvent.click(screen.getByRole("tab", { name: "数据" }));
    expect(await screen.findByText("备份与恢复")).toBeInTheDocument();
  });

  it("configures native relay access, generates a QR code and revokes paired phones", async () => {
    const api = new DigitalLifeApi("");
    const status = {
      devices: [{ createdAt: "2026-08-26T00:00:00.000Z", deviceId: "device-1", lastSeenAt: "2026-08-26T00:10:00.000Z", name: "Joi Android" }],
      enabled: true, hostId: "host-1", relayAuthenticationConfigured: true,
      relayUrl: "https://cudex.joilab.top", status: "connected" as const,
    };
    vi.spyOn(api, "remoteAccessStatus").mockResolvedValue(status);
    const update = vi.spyOn(api, "updateRemoteAccess").mockResolvedValue(status);
    const pairing = vi.spyOn(api, "createRemotePairing").mockResolvedValue({ ...status, pairing: {
      expiresAt: "2026-08-26T00:20:00.000Z", pairingId: "pair-1",
      qrUrl: "joi://pair?v=1&host=host-1&pairing=pair-1&device=device-1&secret=hidden&ticket=e30",
    } });
    const revoke = vi.spyOn(api, "revokeRemoteDevice").mockResolvedValue({ ...status, devices: [] });

    render(<RemoteAccessSettings api={api} />);
    expect(await screen.findByText("手机链路已就绪")).toBeInTheDocument();
    expect(screen.getByText("Joi Android")).toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("iroh 中继地址"), { target: { value: "https://new.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "保存远程设置" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, relayUrl: "https://new.example.com" })));
    fireEvent.click(screen.getByRole("button", { name: "生成绑定二维码" }));
    await waitFor(() => expect(pairing).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText("Joi Android App 绑定二维码")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除 Joi Android" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("device-1"));
  });

  it("refreshes a transient remote connection status and stops polling once connected", async () => {
    const api = new DigitalLifeApi("");
    const disabled = {
      devices: [], enabled: false, hostId: "host-refresh", relayAuthenticationConfigured: false,
      relayUrl: "", status: "disabled" as const,
    };
    const connecting = {
      ...disabled, enabled: true, relayAuthenticationConfigured: true,
      relayUrl: "https://relay.example.com", status: "connecting" as const,
    };
    const connected = { ...connecting, status: "connected" as const };
    const readStatus = vi.spyOn(api, "remoteAccessStatus")
      .mockResolvedValueOnce(disabled)
      .mockResolvedValueOnce(connected);
    vi.spyOn(api, "updateRemoteAccess").mockResolvedValue(connecting);

    render(<RemoteAccessSettings api={api} />);
    expect(await screen.findByText("尚未开启")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("允许已绑定的 Joi Android App 连接"));
    fireEvent.change(screen.getByLabelText("iroh 中继地址"), { target: { value: "https://relay.example.com" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存远程设置" }));
      await Promise.resolve();
    });
    expect(screen.getByText("正在建立安全链路")).toBeInTheDocument();

    expect(await screen.findByText("手机链路已就绪", {}, { timeout: 2_500 })).toBeInTheDocument();
    expect(readStatus).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(readStatus).toHaveBeenCalledTimes(2);
  });

  it("toggles LAN access in place and keeps prerequisite errors actionable", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({ ...runtimeSettings, restartRequired: false });
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);
    fireEvent.click(await screen.findByRole("tab", { name: "设备连接" }));

    const enabled = await screen.findByRole<HTMLInputElement>("checkbox", { name: "允许局域网设备访问" });
    expect(enabled.checked).toBe(false);
    fireEvent.click(enabled);
    expect(enabled.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    expect(await screen.findByText("请先确认局域网明文连接风险。", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("validates the LAN address and port before sending settings", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({ ...runtimeSettings, restartRequired: false });
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);
    fireEvent.click(await screen.findByRole("tab", { name: "设备连接" }));
    const enabled = await screen.findByRole<HTMLInputElement>("checkbox", { name: "允许局域网设备访问" });
    fireEvent.click(enabled);
    fireEvent.change(screen.getByLabelText("访问端口"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    expect(await screen.findByText("访问端口必须在 1024 到 65535 之间。", {}, { timeout: 4_000 })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("访问端口"), { target: { value: "43130" } });
    fireEvent.change(screen.getByLabelText("这台电脑的局域网地址"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    expect(await screen.findByText("请先选择这台电脑的局域网地址。", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("shows blocked, pending and disabled runtime outcomes after hot updates", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    const update = vi.spyOn(api, "updateSettings")
      .mockResolvedValueOnce({ ...runtimeSettings, lan: { ...runtimeSettings.lan, enabled: true, riskAccepted: true, effective: { status: "blocked", reasonCode: "lan_bind_failed", message: "端口被占用。" } }, restartRequired: false })
      .mockResolvedValueOnce({ ...runtimeSettings, lan: { ...runtimeSettings.lan, enabled: true, riskAccepted: true, effective: { address: "192.168.1.20", port: 43130, status: "listening", url: "http://192.168.1.20:43130", pending: { address: "10.0.0.7", port: 43131, reasonCode: "lan_bind_failed" } } }, restartRequired: false })
      .mockResolvedValueOnce({ ...runtimeSettings, restartRequired: false });
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);
    fireEvent.click(await screen.findByRole("tab", { name: "设备连接" }));
    const enabled = await screen.findByRole<HTMLInputElement>("checkbox", { name: "允许局域网设备访问" });
    fireEvent.click(enabled);
    fireEvent.click(screen.getByLabelText("我明白同一网络中的其他人可能看到未加密的连接内容"));
    fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    expect(await screen.findByText("设置已保存，但当前地址或端口暂时无法监听；本机访问仍可用。", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByText("端口被占用。", { exact: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    expect(await screen.findByText("设置已保存，但新地址暂未应用，当前仍保留原监听。", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByText("当前仍在 192.168.1.20:43130 监听，新配置等待应用")).toBeInTheDocument();

    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    expect(await screen.findByText("设置已保存，局域网访问已关闭。", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(update).toHaveBeenCalledTimes(3);
  });

  it("refreshes address candidates and preserves a stale selected address as unavailable", async () => {
    const api = new DigitalLifeApi("");
    const staleSettings = { ...runtimeSettings, lan: { ...runtimeSettings.lan, address: "192.168.1.99" } };
    const operations = mockOperations(api);
    operations.listSessions.mockResolvedValue({ items: [] });
    const settings = vi.spyOn(api, "settings").mockResolvedValueOnce(staleSettings).mockResolvedValueOnce({ ...staleSettings, lan: { ...staleSettings.lan, availableAddresses: [{ address: "10.0.0.7", available: true }] } }).mockRejectedValueOnce(new Error("offline"));
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);
    fireEvent.click(await screen.findByRole("tab", { name: "设备连接" }));
    expect(await screen.findByRole("option", { name: "192.168.1.99（当前不可用）" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "刷新地址" }));
    expect(await screen.findByRole("option", { name: "10.0.0.7" })).toBeInTheDocument();
    expect(await screen.findByText("局域网地址列表已刷新。", {}, { timeout: 4_000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新地址" }));
    expect(await screen.findByText("没能刷新局域网地址。", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(settings).toHaveBeenCalledTimes(3);
  });

  it("saves LAN settings immediately and labels session devices", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({ ...runtimeSettings, lan: { ...runtimeSettings.lan, enabled: true, effective: { address: "192.168.1.20", port: 43130, status: "listening", url: "http://192.168.1.20:43130" } }, restartRequired: false });
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);

    fireEvent.click(screen.getByRole("tab", { name: "安全" }));
    expect(await screen.findByText(/当前设备/u, {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByText(/另一台本机窗口/u)).toBeInTheDocument();
    expect(screen.getByText(/局域网设备 2/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "设备连接" }));
    fireEvent.click(await screen.findByLabelText("允许局域网设备访问", {}, { timeout: 4_000 }));
    fireEvent.click(screen.getByLabelText("我明白同一网络中的其他人可能看到未加密的连接内容"));
    fireEvent.click(await screen.findByRole("button", { name: "保存访问设置" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      lan: { address: "192.168.1.20", enabled: true, port: 43130, riskAccepted: true },
      launchAtLogin: false,
    }));
    expect(await screen.findByText("设置已保存，局域网访问已立即生效。", {}, { timeout: 4_000 })).toBeInTheDocument();
  });

  it("shows at most the ten most recently active sessions", async () => {
    const api = new DigitalLifeApi("");
    const { listSessions } = mockOperations(api);
    listSessions.mockResolvedValue({
      items: Array.from({ length: 12 }, (_, index) => ({
        createdAt: "2026-08-03T00:00:00.000Z",
        current: index === 0,
        deviceId: `device_${String(index + 1)}`,
        ipSummary: "",
        kind: index === 0 ? "desktop" as const : "lan" as const,
        lastActivityAt: new Date(Date.UTC(2026, 7, 3, 12, 0, 0) - index * 60_000).toISOString(),
      })),
    });
    const { container } = render(<SettingsPanel api={api} diagnostics={diagnostics} />);

    fireEvent.click(screen.getByRole("tab", { name: "安全" }));
    expect(await screen.findByText(/当前设备/u, {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(container.querySelectorAll(".session-list > span")).toHaveLength(10);
    expect(screen.queryByText(/局域网设备 11/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/局域网设备 12/u)).not.toBeInTheDocument();
  });

  it("surfaces API error messages and generic failures when saving settings", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    const update = vi.spyOn(api, "updateSettings").mockRejectedValue(new ApiError("settings_invalid", "端口不合法。", 400));
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);
    fireEvent.click(screen.getByRole("tab", { name: "设备连接" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存访问设置" }, { timeout: 4_000 }));
    expect(await screen.findByText("端口不合法。", {}, { timeout: 4_000 })).toBeInTheDocument();

    update.mockRejectedValue(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    expect(await screen.findByText("设置未保存。", {}, { timeout: 4_000 })).toBeInTheDocument();
  });

  it("changes the admin password and creates backups", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    const changePassword = vi.spyOn(api, "changePassword").mockResolvedValue(undefined);
    const createBackup = vi.spyOn(api, "createBackup").mockResolvedValue({
      backupId: "backup_2", createdAt: "2026-07-30T11:00:00.000Z", databaseBytes: 2_097_152, manifestHash: "b".repeat(64), schemaVersion: 26,
    });
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);

    fireEvent.click(screen.getByRole("tab", { name: "安全" }));
    fireEvent.change(await screen.findByLabelText("当前密码", {}, { timeout: 4_000 }), { target: { value: "current-pass-1" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "next-pass-22" } });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith("current-pass-1", "next-pass-22"));
    expect(await screen.findByText("管理密码已更新，其他设备需要重新登录。", {}, { timeout: 4_000 })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "数据" }));
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    await waitFor(() => expect(createBackup).toHaveBeenCalledOnce());
    expect(await screen.findByText("备份已完成，joi 检查过了。", {}, { timeout: 4_000 })).toBeInTheDocument();
  });

  it("reports API and generic failures when changing the password", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    const changePassword = vi.spyOn(api, "changePassword").mockRejectedValue(new ApiError("password_invalid", "当前密码不对。", 400));
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);

    fireEvent.click(screen.getByRole("tab", { name: "安全" }));
    fireEvent.change(await screen.findByLabelText("当前密码", {}, { timeout: 4_000 }), { target: { value: "wrong-pass-1" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "next-pass-22" } });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    expect(await screen.findByText("当前密码不对。", {}, { timeout: 4_000 })).toBeInTheDocument();

    changePassword.mockRejectedValue(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    expect(await screen.findByText("密码没更新。", {}, { timeout: 4_000 })).toBeInTheDocument();
  });

  it("renders diagnostic warnings and confirms an emergency stop", async () => {
    const api = new DigitalLifeApi("");
    const emergencyStopAll = vi.spyOn(api, "emergencyStopAll").mockResolvedValue(undefined);
    const unhealthy: DiagnosticsDto = {
      ...diagnostics,
      agents: { connections: 2, activeInvocations: 1 },
      database: { integrity: "failed", journalMode: "delete", state: "error" },
      runtime: { activeWakes: 1, enabledSchedules: 2, pendingOutbox: 3, scheduledAlarms: 4, staleWakeTurns: 2 },
      web: { lan: { status: "error" }, loopback: { status: "listening" }, sessions: 2 },
    };
    render(<SystemPanel api={api} diagnostics={unhealthy} interactions={[{ createdAt: "2026-08-01T00:00:00.000Z", interactionId: "interaction-1", invocationId: "invocation-1", kind: "input-required", prompt: "需要确认", status: "PENDING" }]} />);
    expect(screen.getByText("数据有问题")).toBeInTheDocument();
    expect(screen.getByText("2 次行动需要确认")).toBeInTheDocument();
    expect(screen.getByText("暂时无法开放")).toBeInTheDocument();
    expect(screen.getByText("1 项待处理")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "紧急暂停全部工作" }));
    await waitFor(() => expect(emergencyStopAll).toHaveBeenCalledOnce());
    expect(await screen.findByText("所有工作已紧急暂停，未确认的搭档过程仍会保留。", {}, { timeout: 4_000 })).toBeInTheDocument();
  });
});

describe("console shell", () => {
  it("surfaces state load failures with a retry affordance", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "listInteractions").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "diagnostics").mockRejectedValue(new Error("offline"));
    render(<ConsoleApp api={api} />);
    expect(await screen.findByText("没能整理出最新状态。", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再试一次" })).toBeInTheDocument();
  });
});
