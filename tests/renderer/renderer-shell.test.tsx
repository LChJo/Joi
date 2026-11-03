// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api";
import { ConsoleApp, SettingsPanel } from "../../src/renderer/Console";
import type { AgentDto, ContinuityDto, DiagnosticsDto, InteractionDto, LifeDto, LifeEventDto } from "../../src/renderer/types";
import type { PartnerDto } from "../../src/shared/joi";

const agent: AgentDto = {
  agentConnectionId: "agent_1", credentialVersion: 1, description: "持续思考", name: "Mana Core", readiness: true,
  skills: ["research", "planning"], status: "ACTIVE", updatedAt: "2026-07-15T12:00:00.000Z",
};
const collaborator: AgentDto = {
  agentConnectionId: "agent_2", credentialVersion: 1, name: "Researcher", readiness: false,
  status: "COLLABORATOR_ONLY", updatedAt: "2026-07-15T12:00:00.000Z",
};
const partner: PartnerDto = {
  capabilities: ["research", "planning"], createdBy: "user", displayName: "Mana Core", engine: "pi-core", inFlightCount: 0, kind: "a2a",
  knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId: "partner_agent_1",
  partnerRevisionId: "partner_revision_agent_1", registryRevision: 1, skills: ["research"], status: "ACTIVE", tools: [],
};
const life: LifeDto = {
  createdAt: "2026-07-15T12:00:00.000Z", currentPersonaVersionId: "persona_1", lifeId: "life_1",
  mainAgentConnectionId: "agent_1", name: "栖遥", personaSummary: "认真保存事实，再采取行动。", principles: ["诚实"],
  role: "长期研究伙伴", state: "RUNNING", timezone: "Asia/Shanghai", updatedAt: "2026-07-15T12:00:00.000Z",
};
const event: LifeEventDto = {
  attemptCount: 0, availableAt: "2026-07-15T12:00:00.000Z", createdAt: "2026-07-15T12:00:00.000Z",
  eventId: "event_1", lifeId: "life_1", occurredAt: "2026-07-15T12:00:00.000Z", payload: { text: "请继续研究" },
  priority: 1, source: "human", status: "PENDING", type: "human.message",
};
const continuity: ContinuityDto = {
  affairs: [{ affairId: "affair_1", lifeId: "life_1", status: "WAITING", title: "比较长期方案", updatedAt: life.updatedAt, waitingReason: "AGENT_RESULT" }],
  alarms: [{ alarmId: "alarm_1", lifeId: "life_1", nextAt: "2026-07-16T01:00:00.000Z", reason: "复查计划", repeatEveryMinutes: 60, status: "SCHEDULED" }],
  budget: { autonomousWakesLimit: 24, autonomousWakesUsed: 2, idleExplorationsLimit: 3, idleExplorationsUsed: 0, invocationsLimit: 100, invocationsUsed: 5, lifeId: "life_1", localDate: "2026-07-15" },
  delegations: [{ agentConnectionId: "agent_2", delegationId: "delegation_1", lifeId: "life_1", status: "RUNNING", task: "比较三种方案", title: "方案调研", updatedAt: life.updatedAt } as ContinuityDto["delegations"][number]],
  memories: [
    { confidence: .98, content: "用户重视事实来源。", entities: [{ name: "用户", relation: "prefers", type: "person" }], kind: "CARD", memoryId: "memory_1", revision: 2, sourceEventId: "event_source", status: "ACTIVE", updatedAt: life.updatedAt },
    { confidence: .8, content: "昨天完成首次讨论。", kind: "EPISODIC", memoryId: "memory_2", revision: 1, status: "ACTIVE", updatedAt: life.updatedAt },
    { confidence: .9, content: "方案 A 风险较低。", kind: "SEMANTIC", memoryId: "memory_3", revision: 1, status: "ACTIVE", updatedAt: life.updatedAt },
  ],
  schedules: [
    { enabled: true, kind: "morning_plan", lifeId: "life_1", localTime: "08:00", scheduleId: "schedule_1", timezone: "Asia/Shanghai" } as ContinuityDto["schedules"][number],
    { enabled: true, kind: "evening_review", lifeId: "life_1", localTime: "21:00", scheduleId: "schedule_2", timezone: "Asia/Shanghai" } as ContinuityDto["schedules"][number],
    { enabled: true, kind: "memory_metabolism", lifeId: "life_1", localTime: "03:00", scheduleId: "schedule_3", timezone: "Asia/Shanghai" } as ContinuityDto["schedules"][number],
  ],
  todos: [{ assignee: "Mana Core", dueAt: "2026-07-16T01:00:00.000Z", lifeId: "life_1", status: "OPEN", title: "整合结果", todoId: "todo_1", updatedAt: life.updatedAt }],
};
const interaction: InteractionDto = { createdAt: life.createdAt, interactionId: "interaction_1", invocationId: "invocation_1", kind: "input-required", prompt: "选择范围", status: "PENDING" };
const diagnostics: DiagnosticsDto = { agents: { connections: 2 }, database: { journalMode: "wal", state: "open" }, runtime: { pendingOutbox: 1 }, schemaVersion: 4, sse: { events: 12 }, web: { sessions: 1 } };

function formFor(element: HTMLElement) {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Expected a parent form.");
  return form;
}

function first<T>(items: T[]): T {
  const item = items.at(0);
  if (item === undefined) throw new Error("Expected at least one item.");
  return item;
}

function mockApi() {
  const api = new DigitalLifeApi("");
  const runtimeRequest = vi.spyOn(api, "joiRuntime").mockResolvedValue({ configured: true, status: "READY" });
  const listLives = vi.spyOn(api, "listLives").mockResolvedValue({ items: [life] });
  vi.spyOn(api, "listWorkbenches").mockResolvedValue({ items: [{ workbenchId: "workbench_1", name: "产品工作", scopeSummary: "joi 工程", updatedAt: life.updatedAt }] });
  const createWorkbench = vi.spyOn(api, "createWorkbench").mockResolvedValue({ workbenchId: "workbench_2", name: "研究", scopeSummary: "研究范围", updatedAt: life.updatedAt });
  vi.spyOn(api, "listAgents").mockResolvedValue({ items: [agent, collaborator] });
  vi.spyOn(api, "listPartners").mockResolvedValue({ items: [partner] });
  const interactionsRequest = vi.spyOn(api, "listInteractions").mockResolvedValue({ items: [interaction] });
  const diagnosticsRequest = vi.spyOn(api, "diagnostics").mockResolvedValue(diagnostics);
  vi.spyOn(api, "listBackups").mockResolvedValue({ items: [{ backupId: "backup_1", createdAt: life.createdAt, databaseBytes: 1024, manifestHash: "a".repeat(64), schemaVersion: 4 }] });
  vi.spyOn(api, "listSessions").mockResolvedValue({ items: [
    { createdAt: life.createdAt, current: true, deviceId: "device_1", ipSummary: "private", kind: "desktop", lastActivityAt: life.updatedAt },
    { createdAt: life.createdAt, current: false, deviceId: "device_2", ipSummary: "private", kind: "lan", lastActivityAt: life.updatedAt },
  ] });
  vi.spyOn(api, "settings").mockResolvedValue({ lan: { address: "", availableAddresses: [{ address: "192.168.1.20", available: true }], effective: { status: "disabled" }, enabled: false, port: 43130, riskAccepted: false }, launchAtLogin: false });
  vi.spyOn(api, "getLife").mockResolvedValue(life);
  vi.spyOn(api, "listEvents").mockResolvedValue({ items: [event, { ...event, eventId: "agent_event", payload: { summary: "已完成比较" }, source: "agent", type: "agent.completed" }] });
  vi.spyOn(api, "listExpressions").mockResolvedValue({ items: [{ actionId: "action_1", createdAt: life.createdAt, deliveredAt: life.createdAt, expressionId: "expression_1", lifeId: "life_1", text: "我会继续跟进。", wakeId: "wake_1" }] });
  vi.spyOn(api, "listActivity").mockResolvedValue({ items: [] });
  vi.spyOn(api, "continuity").mockResolvedValue(continuity);
  const runtime = vi.spyOn(api, "runtime").mockResolvedValue({ ...life, state: "PAUSED" });
  const sendMessage = vi.spyOn(api, "sendMessage").mockResolvedValue(event);
  const uploadAttachment = vi.spyOn(api, "uploadAttachment").mockResolvedValue({ attachmentId: "attachment_1", createdAt: life.createdAt, filename: "brief.txt", lifeId: life.lifeId, mimeType: "text/plain", size: 5 });
  const answerInteraction = vi.spyOn(api, "answerInteraction").mockResolvedValue({ ...interaction, status: "RESOLVED" });
  const remindTodo = vi.spyOn(api, "remindTodo").mockResolvedValue(event);
  const correctMemory = vi.spyOn(api, "correctMemory").mockResolvedValue(event);
  const forgetMemory = vi.spyOn(api, "forgetMemory").mockResolvedValue(event);
  const createTodo = vi.spyOn(api, "createTodo").mockResolvedValue(event);
  const updateTodo = vi.spyOn(api, "updateTodo").mockResolvedValue(event);
  const createAlarm = vi.spyOn(api, "createAlarm").mockResolvedValue(event);
  const cancelAlarm = vi.spyOn(api, "cancelAlarm").mockResolvedValue(event);
  const extendBudget = vi.spyOn(api, "extendBudget").mockResolvedValue({ ...continuity.budget, autonomousWakesLimit: 30 });
  const updateLife = vi.spyOn(api, "updateLife").mockResolvedValue({ ...life, name: "栖遥二号" });
  const agentAction = vi.spyOn(api, "agentAction").mockResolvedValue(agent);
  const rotateAgentToken = vi.spyOn(api, "rotateAgentToken").mockResolvedValue(agent);
  const emergencyStopAll = vi.spyOn(api, "emergencyStopAll").mockResolvedValue(undefined);
  vi.spyOn(api, "logout").mockResolvedValue(undefined);
  const createBackup = vi.spyOn(api, "createBackup").mockResolvedValue({ backupId: "backup_1", createdAt: life.createdAt, databaseBytes: 1024, manifestHash: "a".repeat(64), schemaVersion: 4 });
  const restoreBackup = vi.spyOn(api, "restoreBackup").mockResolvedValue({ backupId: "backup_1", restartRequired: true });
  const updateSettings = vi.spyOn(api, "updateSettings").mockResolvedValue({ lan: { address: "192.168.1.20", availableAddresses: [{ address: "192.168.1.20", available: true }], effective: { address: "192.168.1.20", port: 43130, status: "listening", url: "http://192.168.1.20:43130" }, enabled: true, port: 43130, riskAccepted: true }, launchAtLogin: true, restartRequired: false });
  const changePassword = vi.spyOn(api, "changePassword").mockResolvedValue(undefined);
  const logoutAllLan = vi.spyOn(api, "logoutAllLan").mockResolvedValue(undefined);
  const addAgent = vi.spyOn(api, "addAgent").mockResolvedValue(agent);
  const createLife = vi.spyOn(api, "createLife").mockResolvedValue(life);
  const bindCollaborator = vi.spyOn(api, "bindCollaborator").mockResolvedValue({ items: [agent, collaborator] });
  const resumeAuthorization = vi.spyOn(api, "resumeAuthorization").mockResolvedValue({ ...interaction, kind: "auth-required", status: "RESOLVED" });
  const updateSchedule = vi.spyOn(api, "updateSchedule").mockResolvedValue(first(continuity.schedules));
  const updateRhythm = vi.spyOn(api, "updateRhythm").mockResolvedValue(life);
  const changePrimaryAgent = vi.spyOn(api, "changePrimaryAgent").mockResolvedValue({ handoff: { createdAt: life.createdAt, fromAgentConnectionId: "agent_1", handoffId: "handoff_1", lifeId: life.lifeId, summary: "bounded", toAgentConnectionId: "agent_2" }, life: { ...life, mainAgentConnectionId: "agent_2", state: "PAUSED" } });
  const unbindCollaborator = vi.spyOn(api, "unbindCollaborator").mockResolvedValue({ items: [agent] });
  const archiveLife = vi.spyOn(api, "archiveLife").mockResolvedValue({ ...life, archivedAt: life.updatedAt, state: "STOPPED" });
  const deleteLife = vi.spyOn(api, "deleteLife").mockResolvedValue(undefined);
  vi.spyOn(api, "getLifeDeletionImpact").mockResolvedValue({ affairs: 1, alarms: 1, artifacts: 1, attachments: 1, delegations: 1, events: 2, managedBytes: 2048, memories: 3, schedules: 3, todos: 1, wakes: 1 });
  const deleteAgent = vi.spyOn(api, "deleteAgent").mockResolvedValue(undefined);
  vi.spyOn(api, "getAgentDeletionImpact").mockResolvedValue({ activeInvocations: 0, bindings: [] });
  const disablePartner = vi.spyOn(api, "disablePartner").mockResolvedValue({ ...partner, status: "DISABLED" });
  return { addAgent, agentAction, answerInteraction, api, archiveLife, bindCollaborator, cancelAlarm, changePassword, changePrimaryAgent, correctMemory, createAlarm, createWorkbench, createBackup, createLife, createTodo, deleteAgent, deleteLife, diagnosticsRequest, disablePartner, emergencyStopAll, extendBudget, forgetMemory, interactionsRequest, listLives, logoutAllLan, remindTodo, restoreBackup, resumeAuthorization, rotateAgentToken, runtime, runtimeRequest, sendMessage, unbindCollaborator, updateLife, updateRhythm, updateSchedule, updateSettings, updateTodo, uploadAttachment };
}

describe("joi renderer console", () => {
  it("refreshes model health in the lower-left status and clears the warning after recovery", async () => {
    const fixture = mockApi();
    fixture.runtimeRequest.mockResolvedValue({ configured: true, status: "DEGRADED",
      modelHealth: { ready: 0, recovering: 2, unavailable: 2 } });
    const view = render(<ConsoleApp api={fixture.api} />);
    const warning = await screen.findByRole("button", { name: "模型暂不可用，正在自动恢复" });
    expect(view.container.querySelector(".sidebar footer")).toContainElement(warning);
    expect(fixture.diagnosticsRequest).not.toHaveBeenCalled();
    fixture.runtimeRequest.mockResolvedValue({ configured: true, status: "READY",
      modelHealth: { ready: 2, recovering: 0, unavailable: 0 } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "模型暂不可用，正在自动恢复" })).not.toBeInTheDocument(), { timeout: 4_000 });
  });

  it("shows partial failure and opens model settings without displaying provider error text", async () => {
    const fixture = mockApi();
    fixture.runtimeRequest.mockResolvedValue({ configured: true, status: "DEGRADED",
      modelHealth: { ready: 1, recovering: 0, unavailable: 1 } });
    render(<ConsoleApp api={fixture.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "部分模型需要检查" }));
    expect(await screen.findByRole("heading", { name: "joi 的设置" })).toBeInTheDocument();
  });

  it("returns the content viewport to the top when primary navigation changes", async () => {
    const fixture = mockApi();
    const view = render(<ConsoleApp api={fixture.api} />);
    await waitFor(() => expect(fixture.interactionsRequest).toHaveBeenCalledOnce());
    expect(fixture.diagnosticsRequest).not.toHaveBeenCalled();
    const main = view.container.querySelector(".console-main");
    if (!(main instanceof HTMLElement)) throw new Error("Expected the console content viewport.");
    main.scrollTop = 240;
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "工作台" }));
    expect(await screen.findByRole("heading", { name: "工作台" })).toBeInTheDocument();
    expect(main.scrollTop).toBe(0);
  });

  it("uses native Workbench records in the secondary context page", async () => {
    const fixture = mockApi();
    render(<ConsoleApp api={fixture.api} />);
    fireEvent.click(within(await screen.findByRole("navigation", { name: "主导航" })).getByRole("button", { name: "工作台" }));
    expect(await screen.findByRole("heading", { name: "工作台" })).toBeInTheDocument();
    expect(await screen.findByText("产品工作")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建工作台" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "研究" } });
    fireEvent.change(screen.getByLabelText("工程名称"), { target: { value: "研究工程" } });
    fireEvent.change(screen.getByLabelText("职责范围"), { target: { value: "研究范围" } });
    fireEvent.change(screen.getByLabelText("人格摘要"), { target: { value: "严谨研究" } });
    fireEvent.submit(formFor(screen.getByLabelText("名称")));
    await waitFor(() => expect(fixture.createWorkbench).toHaveBeenCalledWith({
      name: "研究", personaSummary: "严谨研究", projectLabel: "研究工程", scopeSummary: "研究范围",
    }));
  });

  it("recovers the lightweight console status and keeps every new management page reachable", async () => {
    const fixture = mockApi();
    fixture.interactionsRequest.mockRejectedValueOnce(new ApiError("diagnostics_unavailable", "状态暂不可用", 503));
    render(<ConsoleApp api={fixture.api} />);

    expect(await screen.findByText("状态暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新连接状态更新" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "再试一次" }));
    await waitFor(() => expect(fixture.interactionsRequest).toHaveBeenCalledTimes(2));
    const navigation = screen.getByRole("navigation", { name: "主导航" });
    fireEvent.click(within(navigation).getByRole("button", { name: "搭档" }));
    expect(await screen.findByRole("heading", { name: "搭档" })).toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole("button", { name: "定时任务" }));
    expect(await screen.findByRole("heading", { name: "定时任务" })).toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("heading", { name: "joi 的设置" })).toBeInTheDocument();
  });

  it("polls lightweight status globally without polling full diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const fixture = mockApi();
      const view = render(<ConsoleApp api={fixture.api} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await vi.waitFor(() => expect(fixture.interactionsRequest).toHaveBeenCalledOnce());
      expect(fixture.diagnosticsRequest).not.toHaveBeenCalled();
      expect(screen.queryByText("状态自动刷新")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(2_500);
      await vi.waitFor(() => expect(fixture.interactionsRequest).toHaveBeenCalledTimes(2));
      expect(fixture.diagnosticsRequest).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces lightweight status polls while the previous request is pending", async () => {
    vi.useFakeTimers();
    try {
      const fixture = mockApi();
      let resolveInteractions: ((value: { items: (typeof interaction)[] }) => void) | undefined;
      fixture.interactionsRequest.mockImplementation(() => new Promise((resolve) => { resolveInteractions = resolve; }));
      const view = render(<ConsoleApp api={fixture.api} />);

      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.interactionsRequest).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fixture.interactionsRequest).toHaveBeenCalledOnce();
      resolveInteractions?.({ items: [interaction] });
      await vi.advanceTimersByTimeAsync(0);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls full diagnostics only while the diagnostics settings tab is active", async () => {
    vi.useFakeTimers();
    try {
      const fixture = mockApi();
      const view = render(<SettingsPanel api={fixture.api} diagnostics={diagnostics} />);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fixture.diagnosticsRequest).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("tab", { name: "诊断" }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(fixture.diagnosticsRequest).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(fixture.diagnosticsRequest).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByRole("tab", { name: "数据" }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fixture.diagnosticsRequest).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces diagnostics polling while a settings request is pending", async () => {
    vi.useFakeTimers();
    try {
      const fixture = mockApi();
      let resolveDiagnostics: ((value: DiagnosticsDto) => void) | undefined;
      fixture.diagnosticsRequest.mockImplementation(() => new Promise((resolve) => { resolveDiagnostics = resolve; }));
      const view = render(<SettingsPanel api={fixture.api} diagnostics={diagnostics} />);

      fireEvent.click(screen.getByRole("tab", { name: "诊断" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.diagnosticsRequest).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fixture.diagnosticsRequest).toHaveBeenCalledOnce();
      resolveDiagnostics?.(diagnostics);
      await vi.advanceTimersByTimeAsync(0);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("manages LAN, startup, sessions, passwords and verified backups", async () => {
    const fixture = mockApi();
    vi.stubGlobal("confirm", vi.fn().mockReturnValueOnce(false).mockReturnValue(true));
    render(<SettingsPanel api={fixture.api} diagnostics={{ ...diagnostics, storage: { artifactsBytes: 1, backupsBytes: 2, databaseBytes: 3, diskAvailableBytes: 4, state: "low" } }} />);
    fireEvent.click(screen.getByRole("tab", { name: "设备连接" }));
    const address = await screen.findByLabelText("这台电脑的局域网地址");
    fireEvent.click(screen.getByLabelText("允许局域网设备访问"));
    fireEvent.change(address, { target: { value: "192.168.1.20" } });
    fireEvent.click(screen.getByLabelText(/我明白同一网络/));
    fireEvent.click(screen.getByLabelText("开机时启动 joi"));
    fireEvent.submit(formFor(address));
    await waitFor(() => expect(fixture.updateSettings).toHaveBeenCalledOnce());
    const submittedSettings = fixture.updateSettings.mock.calls[0]?.[0];
    expect(submittedSettings).toMatchObject({ launchAtLogin: true, lan: { enabled: true } });
    await screen.findByText("设置已保存，局域网访问已立即生效。");
    fixture.updateSettings.mockResolvedValueOnce({ lan: { address: "192.168.1.20", availableAddresses: [{ address: "192.168.1.20", available: true }], effective: { address: "192.168.1.20", port: 43130, status: "listening", url: "http://192.168.1.20:43130" }, enabled: true, port: 43130, riskAccepted: true }, launchAtLogin: true, restartRequired: false });
    fireEvent.submit(formFor(screen.getByLabelText("这台电脑的局域网地址")));
    await screen.findByText("设置已保存，局域网访问已立即生效。");
    fireEvent.click(screen.getByRole("tab", { name: "安全" }));
    expect(screen.getByText("磁盘空间不足")).toBeInTheDocument();
    expect(screen.getByText(/局域网设备 2/)).toBeInTheDocument();
    expect(screen.getByLabelText("当前密码")).toHaveAttribute("minLength", "6");
    expect(screen.getByLabelText("新密码")).toHaveAttribute("minLength", "6");

    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old password secure" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new password secure" } });
    fireEvent.submit(formFor(screen.getByLabelText("当前密码")));
    await waitFor(() => expect(fixture.changePassword).toHaveBeenCalledWith("old password secure", "new password secure"));
    fireEvent.click(screen.getByRole("button", { name: "退出所有局域网设备" }));
    await waitFor(() => expect(fixture.logoutAllLan).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "数据" }));
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    await waitFor(() => expect(fixture.createBackup).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(fixture.restoreBackup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(fixture.restoreBackup).toHaveBeenCalledWith("backup_1"));
    vi.unstubAllGlobals();
  });

  it("keeps operation failures explicit and retryable", async () => {
    const fixture = mockApi();
    fixture.createBackup.mockRejectedValue(new ApiError("backup_failed", "备份校验失败", 409));
    fixture.updateSettings.mockRejectedValue(new Error("settings failed"));
    fixture.changePassword.mockRejectedValue(new ApiError("password_invalid", "当前密码错误", 403));
    fixture.restoreBackup.mockRejectedValue(new Error("restore failed"));
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SettingsPanel api={fixture.api} diagnostics={diagnostics} />);
    fireEvent.click(screen.getByRole("tab", { name: "数据" }));
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    expect(await screen.findByText("备份校验失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "设备连接" }));
    const address = await screen.findByLabelText("这台电脑的局域网地址");
    fireEvent.submit(formFor(address));
    expect(await screen.findByText("设置未保存。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "安全" }));
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old password secure" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new password secure" } });
    fireEvent.submit(formFor(screen.getByLabelText("当前密码")));
    expect(await screen.findByText("当前密码错误")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "数据" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(await screen.findByText("恢复没开始。")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

});
