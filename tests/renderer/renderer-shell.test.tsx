// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api";
import { AgentPanel, ConsoleApp, LifeHome, SettingsPanel } from "../../src/renderer/Console";
import type { AgentDto, ContinuityDto, DiagnosticsDto, InteractionDto, LifeDto, LifeEventDto } from "../../src/renderer/types";

const agent: AgentDto = {
  agentConnectionId: "agent_1", credentialVersion: 1, description: "持续思考", name: "Mana Core", readiness: true,
  skills: ["research", "planning"], status: "ACTIVE", updatedAt: "2026-07-15T12:00:00.000Z",
};
const collaborator: AgentDto = {
  agentConnectionId: "agent_2", credentialVersion: 1, name: "Researcher", readiness: false,
  status: "COLLABORATOR_ONLY", updatedAt: "2026-07-15T12:00:00.000Z",
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

async function openAvatarHome() {
  fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "Avatar" }));
  return screen.findByRole("heading", { name: "你的智能体，joi 帮你照顾" });
}

function first<T>(items: T[]): T {
  const item = items.at(0);
  if (item === undefined) throw new Error("Expected at least one item.");
  return item;
}

function mockApi() {
  const api = new DigitalLifeApi("");
  const listLives = vi.spyOn(api, "listLives").mockResolvedValue({ items: [life] });
  vi.spyOn(api, "listAgents").mockResolvedValue({ items: [agent, collaborator] });
  vi.spyOn(api, "listInteractions").mockResolvedValue({ items: [interaction] });
  vi.spyOn(api, "diagnostics").mockResolvedValue(diagnostics);
  vi.spyOn(api, "listBackups").mockResolvedValue({ items: [{ backupId: "backup_1", createdAt: life.createdAt, databaseBytes: 1024, manifestHash: "a".repeat(64), schemaVersion: 4 }] });
  vi.spyOn(api, "listSessions").mockResolvedValue({ items: [
    { createdAt: life.createdAt, current: true, deviceId: "device_1", ipSummary: "private", kind: "desktop", lastActivityAt: life.updatedAt },
    { createdAt: life.createdAt, current: false, deviceId: "device_2", ipSummary: "private", kind: "lan", lastActivityAt: life.updatedAt },
  ] });
  vi.spyOn(api, "settings").mockResolvedValue({ lan: { address: "", enabled: false, port: 43130, riskAccepted: false }, launchAtLogin: false });
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
  const updateSettings = vi.spyOn(api, "updateSettings").mockResolvedValue({ lan: { address: "192.168.1.20", enabled: true, port: 43130, riskAccepted: true }, launchAtLogin: true, restartRequired: true });
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
  return { addAgent, agentAction, answerInteraction, api, archiveLife, bindCollaborator, cancelAlarm, changePassword, changePrimaryAgent, correctMemory, createAlarm, createBackup, createLife, createTodo, deleteAgent, deleteLife, emergencyStopAll, extendBudget, forgetMemory, listLives, logoutAllLan, remindTodo, restoreBackup, resumeAuthorization, rotateAgentToken, runtime, sendMessage, unbindCollaborator, updateLife, updateRhythm, updateSchedule, updateSettings, updateTodo, uploadAttachment };
}

describe("joi renderer console", () => {
  it("covers the primary keyboard-accessible management paths", async () => {
    const fixture = mockApi();
    const { api } = fixture;
    render(<ConsoleApp api={api} />);
    expect(await openAvatarHome()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开 栖遥" }));
    expect(await screen.findByText("我会继续跟进。")).toBeInTheDocument();
    expect(screen.getByText("你的消息")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("回答"), { target: { value: "范围 A" } });
    fireEvent.submit(formFor(screen.getByLabelText("回答")));
    await waitFor(() => expect(fixture.answerInteraction).toHaveBeenCalledWith("interaction_1", "范围 A"));
    fireEvent.change(screen.getByLabelText("输入消息"), { target: { value: "新的消息" } });
    fireEvent.keyDown(screen.getByLabelText("输入消息"), { key: "Enter", shiftKey: false });
    await waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledWith("life_1", "新的消息"));
    fixture.runtime.mockResolvedValueOnce({ ...life, state: "RUNNING" });
    fireEvent.click(screen.getByRole("button", { name: "停止运行" }));
    fireEvent.click(screen.getByRole("button", { name: "只停止这次" }));
    await waitFor(() => expect(fixture.runtime).toHaveBeenCalledWith("life_1", "cancel-run"));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));

    fireEvent.click(screen.getByRole("button", { name: "事务与待办" }));
    expect(screen.getAllByText("比较长期方案")[0]).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("新待办"), { target: { value: "新任务" } });
    fireEvent.submit(formFor(screen.getByLabelText("新待办")));
    await waitFor(() => expect(fixture.createTodo).toHaveBeenCalledWith("life_1", "新任务"));
    fireEvent.click(screen.getByRole("button", { name: "提醒" }));
    await waitFor(() => expect(fixture.remindTodo).toHaveBeenCalledWith("life_1", "todo_1"));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(fixture.updateTodo).toHaveBeenCalledWith("life_1", "todo_1", { status: "DONE" }));

    fireEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(screen.getByText("概念卡")).toBeInTheDocument();
    fireEvent.click(first(screen.getAllByRole("button", { name: "修正" })));
    fireEvent.change(screen.getByLabelText("修正后的记忆"), { target: { value: "修正后的事实" } });
    fireEvent.submit(formFor(screen.getByLabelText("修正后的记忆")));
    await waitFor(() => expect(fixture.correctMemory).toHaveBeenCalled());
    fireEvent.click(first(screen.getAllByRole("button", { name: "遗忘" })));
    await waitFor(() => expect(fixture.forgetMemory).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "作息与闹钟" }));
    expect(screen.getByText("晨间计划")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("闹钟原因"), { target: { value: "检查进度" } });
    fireEvent.change(screen.getByLabelText("闹钟时间"), { target: { value: "2026-07-16T08:00" } });
    fireEvent.submit(formFor(screen.getByLabelText("闹钟原因")));
    await waitFor(() => expect(fixture.createAlarm).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(fixture.cancelAlarm).toHaveBeenCalledWith("life_1", "alarm_1"));
    fireEvent.click(screen.getByRole("button", { name: "增加今天的额度" }));
    await waitFor(() => expect(fixture.extendBudget).toHaveBeenCalled());

    fireEvent.click(within(screen.getByRole("navigation", { name: "智能体详情" })).getByRole("button", { name: "设置" }));
    const nameInput = screen.getByDisplayValue("栖遥");
    fireEvent.change(nameInput, { target: { value: "栖遥二号" } });
    fireEvent.submit(formFor(nameInput));
    await waitFor(() => expect(fixture.updateLife).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "返回全部智能体" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "搭档" }));
    expect(screen.getByText("持续思考")).toBeInTheDocument();
    expect(screen.getByText("这位搭档没留介绍")).toBeInTheDocument();
    fireEvent.click(first(screen.getAllByRole("button", { name: "重新检查" })));
    fireEvent.click(first(screen.getAllByRole("button", { name: "更新密钥" })));
    fireEvent.change(screen.getByLabelText("新密钥"), { target: { value: "rotated" } });
    fireEvent.submit(formFor(screen.getByLabelText("新密钥")));
    await waitFor(() => expect(fixture.rotateAgentToken).toHaveBeenCalledWith("agent_1", "rotated"));
    fireEvent.click(first(screen.getAllByRole("button", { name: "停用" })));
    fireEvent.click(screen.getByRole("button", { name: "添加搭档" }));
    const dialog = screen.getByRole("form", { name: "添加搭档" });
    fireEvent.change(within(dialog).getByLabelText(/Agent Card URL/), { target: { value: "http://192.168.1.2/card.json" } });
    fireEvent.change(within(dialog).getByLabelText(/Bearer Token/), { target: { value: "secret" } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(fixture.addAgent).toHaveBeenCalled());

    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "状态" }));
    expect(screen.getByText("v4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "紧急暂停全部智能体" }));
    await waitFor(() => expect(fixture.emergencyStopAll).toHaveBeenCalled());
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "设置" }));
    expect(screen.getByText("管理密码与设备")).toBeInTheDocument();
  });

  it("shows honest empty and unavailable-primary states", () => {
    const onCreate = vi.fn();
    const { rerender } = render(<LifeHome agents={[]} lives={[]} onCreate={onCreate} onOpen={vi.fn()} />);
    expect(screen.getByText("还没有智能体，创建一个试试")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建第一个智能体" })).toBeDisabled();
    rerender(<LifeHome agents={[agent]} lives={[]} onCreate={onCreate} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "创建第一个智能体" }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("renders archived Life facts and all enriched Agent connection states", async () => {
    const onOpen = vi.fn();
    const archived = {
      ...life, archivedAt: life.updatedAt, autonomousBudgetDailyLimit: 30, autonomousBudgetUsed: 4,
      nextWakeAt: "2026-07-16T01:00:00.000Z", pendingEventCount: 3, totalBudgetDailyLimit: 120, totalBudgetUsed: 8,
    };
    const view = render(<LifeHome agents={[agent]} lives={[archived]} onCreate={vi.fn()} onOpen={onOpen} />);
    expect(screen.getByText("已归档")).toBeInTheDocument();
    expect(screen.getByText("主动 4/30，协作 8/120")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开 栖遥" }));
    expect(onOpen).toHaveBeenCalledWith(archived);

    const fixture = mockApi();
    const disabled: AgentDto = { ...collaborator, lifeBindings: [{ lifeId: life.lifeId, name: life.name, role: "COLLABORATOR" }], recentInvocationStatus: "FAILED", status: "DISABLED" };
    const tokenRequired: AgentDto = { ...agent, agentConnectionId: "agent_token", lifeBindings: [{ lifeId: life.lifeId, name: life.name, role: "PRIMARY" }], name: "Token Agent", status: "TOKEN_REQUIRED" };
    fixture.api.getAgentDeletionImpact = vi.fn().mockResolvedValueOnce({ activeInvocations: 1, bindings: [
      { lifeId: life.lifeId, name: life.name, role: "PRIMARY" }, { lifeId: life.lifeId, name: life.name, role: "COLLABORATOR" },
    ] }).mockResolvedValue({ activeInvocations: 0, bindings: [] });
    view.rerender(<AgentPanel agents={[disabled, tokenRequired]} api={fixture.api} refresh={() => Promise.resolve()} />);
    expect(screen.getByText("最近协作：没成功")).toBeInTheDocument();
    expect(screen.getByText("这份数据来自备份，旧密钥已失效。请重新输入密钥并检查连接。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新启用" }));
    await waitFor(() => expect(fixture.agentAction).toHaveBeenCalledWith("agent_2", "enable"));
    const disabledRow = screen.getByRole("heading", { name: "Researcher" }).closest("article");
    if (disabledRow === null) throw new Error("missing disabled agent row");
    fireEvent.click(within(disabledRow).getByRole("button", { name: /删除/ }));
    expect(await screen.findByText(/还在陪伴以下智能体/)).toBeInTheDocument();
    expect(screen.getByText(/主力搭档：先暂停智能体再交接/)).toBeInTheDocument();
    expect(screen.getByText(/协作搭档：在智能体设置里解除/)).toBeInTheDocument();
    expect(screen.getByText(/还有 1 项协作正在进行/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const tokenRow = screen.getByRole("heading", { name: "Token Agent" }).closest("article");
    if (tokenRow === null) throw new Error("missing token agent row");
    fireEvent.click(within(tokenRow).getByRole("button", { name: "重新输入密钥" }));
    fireEvent.click(within(tokenRow).getByRole("button", { name: "取消" }));
  });

  it("manages LAN, startup, sessions, passwords and verified backups", async () => {
    const fixture = mockApi();
    vi.stubGlobal("confirm", vi.fn().mockReturnValueOnce(false).mockReturnValue(true));
    render(<SettingsPanel api={fixture.api} diagnostics={{ ...diagnostics, storage: { artifactsBytes: 1, backupsBytes: 2, databaseBytes: 3, diskAvailableBytes: 4, state: "low" } }} />);
    const address = await screen.findByLabelText("这台电脑的局域网地址");
    fireEvent.click(screen.getByLabelText("允许局域网设备访问"));
    fireEvent.change(address, { target: { value: "192.168.1.20" } });
    fireEvent.click(screen.getByLabelText(/我明白同一网络/));
    fireEvent.click(screen.getByLabelText("开机时启动 joi"));
    fireEvent.submit(formFor(address));
    await waitFor(() => expect(fixture.updateSettings).toHaveBeenCalledOnce());
    const submittedSettings = fixture.updateSettings.mock.calls[0]?.[0];
    expect(submittedSettings).toMatchObject({ launchAtLogin: true, lan: { enabled: true } });
    await screen.findByText(/重启后其他设备的访问方式会切换/);
    fixture.updateSettings.mockResolvedValueOnce({ lan: { address: "192.168.1.20", enabled: true, port: 43130, riskAccepted: true }, launchAtLogin: true, restartRequired: false });
    fireEvent.submit(formFor(screen.getByLabelText("这台电脑的局域网地址")));
    await screen.findByText("设置已保存。");
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
    const address = await screen.findByLabelText("这台电脑的局域网地址");
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    expect(await screen.findByText("备份校验失败")).toBeInTheDocument();
    fireEvent.submit(formFor(address));
    expect(await screen.findByText("设置未保存。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old password secure" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new password secure" } });
    fireEvent.submit(formFor(screen.getByLabelText("当前密码")));
    expect(await screen.findByText("当前密码错误")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(await screen.findByText("恢复没开始。")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("completes the three-step Life birth journey", async () => {
    const fixture = mockApi();
    const { api } = fixture;
    render(<ConsoleApp api={api} />);
    await openAvatarHome();
    fireEvent.click(screen.getByRole("button", { name: "创建新智能体" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新智能体" } });
    fireEvent.change(screen.getByLabelText("人格摘要"), { target: { value: "尊重事实并保持好奇。" } });
    fireEvent.change(screen.getByLabelText("角色（可选）"), { target: { value: "观察者" } });
    fireEvent.change(screen.getByLabelText("原则（每行一条）"), { target: { value: "诚实\n克制" } });
    fireEvent.click(screen.getByRole("button", { name: /继续/ }));
    expect(screen.getByRole("radio", { name: /Mana Core/ })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /Researcher/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Researcher/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Researcher/ }));
    fireEvent.click(screen.getByRole("button", { name: /继续/ }));
    expect(screen.getByText("计划一天")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /让它出生/ }));
    await waitFor(() => expect(fixture.createLife).toHaveBeenCalledWith(expect.objectContaining({ name: "新智能体" })));
    expect(fixture.bindCollaborator).toHaveBeenCalledWith("life_1", "agent_2");
    expect(fixture.runtime).toHaveBeenCalledWith("life_1", "start");
  });

  it("keeps the birth wizard reversible and reports a failed creation without losing input", async () => {
    const fixture = mockApi();
    fixture.createLife.mockRejectedValue(new ApiError("birth_failed", "主 Agent 暂不可用", 503));
    render(<ConsoleApp api={fixture.api} />);
    await openAvatarHome();
    fireEvent.click(screen.getByRole("button", { name: "创建新智能体" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "失败智能体" } });
    fireEvent.change(screen.getByLabelText("头像 URL（可选）"), { target: { value: "https://example.test/avatar.png" } });
    fireEvent.change(screen.getByLabelText("人格摘要"), { target: { value: "保留输入" } });
    fireEvent.change(screen.getByLabelText("初始目标（可选）"), { target: { value: "继续尝试" } });
    fireEvent.click(screen.getByRole("button", { name: /继续/ }));
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByLabelText("名称")).toHaveValue("失败智能体");
    fireEvent.click(screen.getByRole("button", { name: /继续/ }));
    fireEvent.click(screen.getByRole("button", { name: /继续/ }));
    fireEvent.change(screen.getByLabelText("时区"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByRole("button", { name: /让它出生/ }));
    expect(await screen.findByText(/没创建成功，请确认搭档仍然可用/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /让它出生/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "暂时退出" }));
    expect(await openAvatarHome()).toBeInTheDocument();
  });

  it("renders a Life with no pending human interactions", async () => {
    const fixture = mockApi();
    vi.spyOn(fixture.api, "listInteractions").mockResolvedValue({ items: [] });
    render(<ConsoleApp api={fixture.api} />);
    await openAvatarHome();
    fireEvent.click(screen.getByRole("button", { name: "打开 栖遥" }));
    await screen.findByText("我会继续跟进。");
    expect(screen.queryByRole("heading", { name: "等你决定" })).not.toBeInTheDocument();
  });

  it("renders sparse, stopped and auth-required states without inventing data", async () => {
    const api = new DigitalLifeApi("");
    const stopped: LifeDto = { ...life, mainAgentConnectionId: "missing_agent", state: "STOPPED", timezone: "Invalid/Timezone" };
    delete stopped.role;
    vi.spyOn(api, "listLives").mockResolvedValue({ items: [stopped] });
    vi.spyOn(api, "listAgents").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listInteractions").mockResolvedValue({ items: [{ ...interaction, interactionId: "auth_1", kind: "auth-required" }] });
    vi.spyOn(api, "diagnostics").mockResolvedValue({ ...diagnostics, runtime: { pendingOutbox: 0 } });
    vi.spyOn(api, "getLife").mockResolvedValue(stopped);
    vi.spyOn(api, "listEvents").mockResolvedValue({ items: [{ ...event, eventId: "system_1", occurredAt: "not-a-date", payload: {}, source: "system", status: "CONSUMED", type: "system.birth" }] });
    vi.spyOn(api, "listExpressions").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "continuity").mockResolvedValue({ ...continuity, affairs: [], alarms: [], delegations: [], memories: [], schedules: [{ ...first(continuity.schedules), enabled: false }], todos: [] });
    const sendMessage = vi.spyOn(api, "sendMessage").mockResolvedValue(event);
    const runtime = vi.spyOn(api, "runtime").mockResolvedValue({ ...stopped, state: "SLEEPING" });
    render(<ConsoleApp api={api} />);
    await openAvatarHome();
    expect(screen.getByText("暂未连接")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开 栖遥" }));
    expect(await screen.findByText("需要你完成授权")).toBeInTheDocument();
    expect(screen.getByText("joi 的运行记录")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("输入消息"), { target: { value: "离线也保存" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(screen.getByText("消息已收下，等它行动时会看到。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await waitFor(() => expect(runtime).toHaveBeenCalledWith("life_1", "start"));
    fireEvent.click(screen.getByRole("button", { name: "事务与待办" }));
    expect(screen.getByText("还没有长期事务。")).toBeInTheDocument();
    expect(screen.getByText("暂时没有开放待办。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(screen.getAllByText("还没有这类记忆。")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "作息与闹钟" }));
    expect(screen.getByText("还没有闹钟。")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation", { name: "智能体详情" })).getByRole("button", { name: "设置" }));
    expect(screen.getByLabelText("角色")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "返回全部智能体" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "搭档" }));
    expect(screen.getByText("还没有搭档")).toBeInTheDocument();
  });

  it("renders continuity records whose optional summary, due date and repeat are absent", async () => {
    const fixture = mockApi();
    vi.spyOn(fixture.api, "continuity").mockResolvedValue({
      ...continuity,
      affairs: [{ affairId: "affair_sparse", lifeId: life.lifeId, status: "OPEN", title: "无摘要事务", updatedAt: life.updatedAt }],
      alarms: [{ alarmId: "alarm_sparse", lifeId: life.lifeId, nextAt: life.updatedAt, reason: "单次提醒", status: "SCHEDULED" }],
      todos: [{ lifeId: life.lifeId, status: "OPEN", title: "无期限待办", todoId: "todo_sparse", updatedAt: life.updatedAt }],
    });
    render(<ConsoleApp api={fixture.api} />);
    await openAvatarHome();
    fireEvent.click(screen.getByRole("button", { name: "打开 栖遥" }));
    await screen.findByText("我会继续跟进。");
    fireEvent.click(screen.getByRole("button", { name: "事务与待办" }));
    expect(screen.getByText("持续推进中")).toBeInTheDocument();
    expect(screen.getByText(/没有截止时间/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "作息与闹钟" }));
    expect(screen.getByText("单次提醒")).toBeInTheDocument();
  });

  it("keeps a failed console load retryable", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "listLives").mockRejectedValueOnce(new ApiError("offline", "本机暂时离线", 503)).mockResolvedValue({ items: [] });
    vi.spyOn(api, "listAgents").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listInteractions").mockResolvedValue({ items: [] });
    vi.spyOn(api, "diagnostics").mockResolvedValue(diagnostics);
    render(<ConsoleApp api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("本机暂时离线");
    fireEvent.click(screen.getByRole("button", { name: "再试一次" }));
    expect(await openAvatarHome()).toBeInTheDocument();
  });

  it("reports SSE reconnect state, refreshes on events, and closes the stream", async () => {
    class FakeEventSource {
      static instance: FakeEventSource | null = null;
      readonly close = vi.fn();
      readonly listeners = new Map<string, () => void>();
      onerror: (() => void) | null = null;
      onopen: (() => void) | null = null;
      constructor(readonly url: string) { FakeEventSource.instance = this; }
      addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fixture = mockApi();
    const view = render(<ConsoleApp api={fixture.api} />);
    await openAvatarHome();
    const stream = FakeEventSource.instance;
    if (stream === null) throw new Error("Expected an event stream.");
    expect(stream.url).toContain("/api/v1/stream");
    act(() => stream.onerror?.());
    expect(screen.getByText("重新连接中")).toBeInTheDocument();
    act(() => stream.onopen?.());
    expect(screen.getByText("已连接")).toBeInTheDocument();
    act(() => stream.listeners.get("event.created")?.());
    await waitFor(() => expect(fixture.listLives).toHaveBeenCalledTimes(2));
    act(() => stream.listeners.get("stream_reset")?.());
    await waitFor(() => expect(fixture.listLives).toHaveBeenCalledTimes(3));
    view.unmount();
    expect(stream.close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("shows runtime audit facts, resumes auth, and sends only explicitly selected bounded attachments", async () => {
    const fixture = mockApi();
    vi.spyOn(fixture.api, "listInteractions").mockResolvedValue({ items: [{ ...interaction, interactionId: "auth_2", kind: "auth-required" }] });
    vi.spyOn(fixture.api, "listActivity").mockResolvedValue({ items: [
      { activityId: "wake_2", details: { eventCount: 2, turnCount: 1 }, kind: "WAKE", startedAt: life.createdAt, status: "RUNNING", title: "主 Agent Wake" },
      { activityId: "turn_2", details: { agentName: "Mana Core", invocationStatus: "WORKING", turnNumber: 1 }, kind: "TURN", startedAt: life.createdAt, status: "RUNNING", title: "主 Agent Turn 1" },
      { activityId: "flow_2", details: { failures: 1 }, endedAt: life.updatedAt, kind: "FLOW", startedAt: life.createdAt, status: "FAILED", title: "动作协议校验失败" },
      { activityId: "delegation_2", details: { agentName: "Researcher" }, endedAt: life.updatedAt, kind: "DELEGATION", startedAt: life.createdAt, status: "COMPLETED", title: "资料调研" },
    ] });
    render(<ConsoleApp api={fixture.api} />);
    await openAvatarHome();
    fireEvent.click(screen.getByRole("button", { name: "打开 栖遥" }));
    expect(await screen.findByText("一次行动")).toBeInTheDocument();
    expect(screen.getByText(/这次结果还不能确认/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /已完成授权/ }));
    await waitFor(() => expect(fixture.resumeAuthorization).toHaveBeenCalledWith("auth_2"));

    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("missing attachment input");
    const tooMany = Array.from({ length: 9 }, (_, index) => new File(["x"], `f${String(index)}.txt`, { type: "text/plain" }));
    fireEvent.change(input, { target: { files: tooMany } });
    expect(screen.getByText(/最多 8 个/)).toBeInTheDocument();
    const selected = new File(["brief"], "brief.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [selected] } });
    expect(screen.getByText(/已选 1 个附件/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("输入消息"), { target: { value: "读取附件" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(fixture.uploadAttachment).toHaveBeenCalledWith("life_1", selected));
    expect(fixture.sendMessage).toHaveBeenCalledWith("life_1", "读取附件", ["attachment_1"]);
  });

  it("edits Todo, schedule, rhythm defaults and calendar alarms through event-producing controls", async () => {
    const fixture = mockApi();
    render(<ConsoleApp api={fixture.api} />);
    await openAvatarHome();
    fireEvent.click(screen.getByRole("button", { name: "打开 栖遥" }));
    await screen.findByText("我会继续跟进。");
    fireEvent.click(screen.getByRole("button", { name: "事务与待办" }));
    fireEvent.change(screen.getByLabelText("截止时间"), { target: { value: "2026-07-17T09:30" } });
    fireEvent.change(screen.getByLabelText("负责人"), { target: { value: "我" } });
    fireEvent.change(screen.getByLabelText("关联事务"), { target: { value: "affair_1" } });
    fireEvent.change(screen.getByLabelText("新待办"), { target: { value: "带上下文任务" } });
    fireEvent.submit(formFor(screen.getByLabelText("新待办")));
    await waitFor(() => expect(fixture.createTodo).toHaveBeenCalledWith("life_1", "带上下文任务", expect.objectContaining({ affairId: "affair_1", assignee: "我" })));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("待办标题"), { target: { value: "更新后的任务" } });
    fireEvent.change(screen.getByLabelText("待办截止时间"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("待办负责人"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("待办关联事务"), { target: { value: "" } });
    fireEvent.submit(formFor(screen.getByLabelText("待办标题")));
    await waitFor(() => expect(fixture.updateTodo).toHaveBeenCalledWith("life_1", "todo_1", expect.objectContaining({ affairId: null, assignee: null, dueAt: null, title: "更新后的任务" })));

    fireEvent.click(screen.getByRole("button", { name: "作息与闹钟" }));
    fireEvent.change(screen.getByLabelText("晨间计划时间"), { target: { value: "08:30" } });
    const enabled = formFor(screen.getByLabelText("晨间计划时间")).querySelector('input[type="checkbox"]');
    if (!(enabled instanceof HTMLInputElement)) throw new Error("missing schedule enabled control");
    fireEvent.click(enabled);
    fireEvent.submit(formFor(screen.getByLabelText("晨间计划时间")));
    await waitFor(() => expect(fixture.updateSchedule).toHaveBeenCalledWith("life_1", "schedule_1", "08:30", false));
    fireEvent.change(screen.getByLabelText("安静开始"), { target: { value: "22:30" } });
    fireEvent.change(screen.getByLabelText("安静结束"), { target: { value: "06:30" } });
    fireEvent.change(screen.getByLabelText("主动行动"), { target: { value: "30", valueAsNumber: 30 } });
    fireEvent.change(screen.getByLabelText("搭档协作"), { target: { value: "120", valueAsNumber: 120 } });
    fireEvent.change(screen.getByLabelText("主动探索"), { target: { value: "4", valueAsNumber: 4 } });
    fireEvent.submit(formFor(screen.getByLabelText("安静开始")));
    await waitFor(() => expect(fixture.updateRhythm).toHaveBeenCalledWith("life_1", expect.objectContaining({ autonomousWakesDefault: 30, quietStart: "22:30" })));
    fireEvent.change(screen.getByLabelText("闹钟原因"), { target: { value: "工作日检查" } });
    fireEvent.change(screen.getByLabelText("闹钟时间"), { target: { value: "2026-07-17T08:00" } });
    fireEvent.change(screen.getByLabelText("重复规则"), { target: { value: "rule:WEEKDAYS" } });
    fireEvent.click(screen.getByLabelText("允许在安静时段行动"));
    fireEvent.submit(formFor(screen.getByLabelText("闹钟原因")));
    await waitFor(() => expect(fixture.createAlarm).toHaveBeenCalledWith("life_1", "工作日检查", expect.any(String), { allowQuietHours: true, recurrenceRule: "WEEKDAYS" }));
  });

  it("performs paused primary handoff, collaborator removal, archive and deletion impact confirmation", async () => {
    const fixture = mockApi();
    const paused = { ...life, state: "PAUSED" as const };
    vi.spyOn(fixture.api, "getLife").mockResolvedValue(paused);
    vi.spyOn(fixture.api, "listAgents").mockResolvedValue({ items: [agent, { ...collaborator, readiness: true, status: "ACTIVE" }] });
    vi.spyOn(fixture.api, "continuity").mockResolvedValue({ ...continuity, collaborators: [collaborator] });
    render(<ConsoleApp api={fixture.api} />);
    await openAvatarHome();
    fireEvent.click(screen.getByRole("button", { name: "打开 栖遥" }));
    await screen.findByText("我会继续跟进。");
    fireEvent.click(within(screen.getByRole("navigation", { name: "智能体详情" })).getByRole("button", { name: "设置" }));
    fireEvent.change(screen.getByLabelText("角色"), { target: { value: "新角色" } });
    fireEvent.change(screen.getByLabelText("头像 URL"), { target: { value: "https://example.test/new.png" } });
    fireEvent.change(screen.getByLabelText("人格摘要"), { target: { value: "更新人格" } });
    fireEvent.change(screen.getByLabelText("初始目标"), { target: { value: "更新目标" } });
    fireEvent.change(screen.getByLabelText("新的主力搭档"), { target: { value: "agent_2" } });
    fireEvent.click(screen.getByRole("button", { name: "更换主力搭档" }));
    await waitFor(() => expect(fixture.changePrimaryAgent).toHaveBeenCalledWith("life_1", "agent_2"));
    fireEvent.click(screen.getByRole("button", { name: "解除" }));
    await waitFor(() => expect(fixture.unbindCollaborator).toHaveBeenCalledWith("life_1", "agent_2"));
    fireEvent.click(screen.getByRole("button", { name: "归档智能体" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "归档智能体" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(fixture.archiveLife).toHaveBeenCalledWith("life_1"));
    fireEvent.click(screen.getByRole("button", { name: /删除智能体/ }));
    expect(await screen.findByText(/还会删除 1 个文件/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/输入智能体名称/), { target: { value: "栖遥" } });
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(fixture.deleteLife).toHaveBeenCalledWith("life_1"));
  });

  it("shows enriched diagnostics and completes an unbound Agent deletion", async () => {
    const fixture = mockApi();
    vi.spyOn(fixture.api, "diagnostics").mockResolvedValue({
      agents: { activeInvocations: 2, connections: 2, openBreakers: 1 }, database: { integrity: "corrupt", journalMode: "wal", state: "open" },
      runtime: { activeWakes: 1, enabledSchedules: 3, leases: 1, pendingOutbox: 2, scheduledAlarms: 4, staleWakeTurns: 1 },
      schemaVersion: 16, sse: { events: 9 }, web: { lan: { status: "listening" }, sessions: 2 },
    });
    render(<ConsoleApp api={fixture.api} />);
    await openAvatarHome();
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "状态" }));
    expect(screen.getByText("需要检查")).toBeInTheDocument();
    expect(screen.getByText("1 次行动需要确认")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "导出诊断" })).toHaveAttribute("download");
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "搭档" }));
    const row = screen.getByRole("heading", { name: "Mana Core" }).closest("article");
    if (row === null) throw new Error("missing agent row");
    fireEvent.click(within(row).getByRole("button", { name: /删除/ }));
    expect(await screen.findByRole("heading", { name: "删除 Mana Core？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(fixture.deleteAgent).toHaveBeenCalledWith("agent_1"));
  });
});
