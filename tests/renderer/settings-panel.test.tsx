// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api.js";
import { ConsoleApp, RemoteAccessSettings, SettingsPanel } from "../../src/renderer/Console.js";
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

const runtimeSettings = { lan: { address: "192.168.1.20", enabled: false, port: 43130, riskAccepted: false }, launchAtLogin: false };

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
  it("configures browser relay access, generates a QR code and revokes paired browsers", async () => {
    const api = new DigitalLifeApi("");
    const status = {
      devices: [{ createdAt: "2026-08-26T00:00:00.000Z", deviceId: "device-1", lastSeenAt: "2026-08-26T00:10:00.000Z", name: "手机浏览器" }],
      enabled: true, hostId: "host-1", relayAuthenticationConfigured: true,
      relayUrl: "https://remote.joilab.top", status: "connected" as const,
    };
    vi.spyOn(api, "remoteAccessStatus").mockResolvedValue(status);
    const update = vi.spyOn(api, "updateRemoteAccess").mockResolvedValue(status);
    const pairing = vi.spyOn(api, "createRemotePairing").mockResolvedValue({ ...status, pairing: {
      expiresAt: "2026-08-26T00:20:00.000Z", pairingId: "pair-1",
      qrUrl: "https://remote.joilab.top/remote/#v=1&host=host-1&pairing=pair-1&device=device-1&secret=hidden",
    } });
    const revoke = vi.spyOn(api, "revokeRemoteDevice").mockResolvedValue({ ...status, devices: [] });

    render(<RemoteAccessSettings api={api} />);
    expect(await screen.findByText("已安全连接")).toBeInTheDocument();
    expect(screen.getByText("手机浏览器")).toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("浏览器网关地址"), { target: { value: "https://new.example.com" } });
    fireEvent.change(screen.getByLabelText("中继主机令牌"), { target: { value: "new-relay-token-that-is-long-enough" } });
    fireEvent.click(screen.getByRole("button", { name: "保存远程设置" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, relayAuthentication: "new-relay-token-that-is-long-enough", relayUrl: "https://new.example.com" })));
    fireEvent.click(screen.getByRole("button", { name: "生成绑定二维码" }));
    await waitFor(() => expect(pairing).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText("远程浏览器绑定二维码")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除 手机浏览器" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("device-1"));
  });

  it("saves LAN settings, reports restart requirements and labels session devices", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({ ...runtimeSettings, restartRequired: true });
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);

    expect(await screen.findByText(/当前设备/u, {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByText(/另一台本机窗口/u)).toBeInTheDocument();
    expect(screen.getByText(/局域网设备 2/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存访问设置" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      lan: { address: "192.168.1.20", enabled: false, port: 43130, riskAccepted: false },
      launchAtLogin: false,
    }));
    expect(await screen.findByText("设置已保存，重启后其他设备的访问方式会切换。", {}, { timeout: 4_000 })).toBeInTheDocument();
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

    fireEvent.change(await screen.findByLabelText("当前密码", {}, { timeout: 4_000 }), { target: { value: "current-pass-1" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "next-pass-22" } });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith("current-pass-1", "next-pass-22"));
    expect(await screen.findByText("管理密码已更新，其他设备需要重新登录。", {}, { timeout: 4_000 })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    await waitFor(() => expect(createBackup).toHaveBeenCalledOnce());
    expect(await screen.findByText("备份已完成，joi 检查过了。", {}, { timeout: 4_000 })).toBeInTheDocument();
  });

  it("reports API and generic failures when changing the password", async () => {
    const api = new DigitalLifeApi("");
    mockOperations(api);
    const changePassword = vi.spyOn(api, "changePassword").mockRejectedValue(new ApiError("password_invalid", "当前密码不对。", 400));
    render(<SettingsPanel api={api} diagnostics={diagnostics} />);

    fireEvent.change(await screen.findByLabelText("当前密码", {}, { timeout: 4_000 }), { target: { value: "wrong-pass-1" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "next-pass-22" } });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    expect(await screen.findByText("当前密码不对。", {}, { timeout: 4_000 })).toBeInTheDocument();

    changePassword.mockRejectedValue(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    expect(await screen.findByText("密码没更新。", {}, { timeout: 4_000 })).toBeInTheDocument();
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
