// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

import { DigitalLifeApi } from "../../src/renderer/api";
import { AgentPanel, LifeHome, SystemPanel } from "../../src/renderer/Console";
import { SetupJourney } from "../../src/renderer/Onboarding";
import type { AgentDto, DiagnosticsDto, LifeDto } from "../../src/renderer/types";

const activePartner: AgentDto = {
  agentConnectionId: "agent_1",
  description: "帮助梳理长期事务",
  name: "Mana",
  readiness: true,
  status: "ACTIVE",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

const life: LifeDto = {
  autonomousBudgetDailyLimit: 24,
  autonomousBudgetUsed: 2,
  createdAt: "2026-07-16T00:00:00.000Z",
  currentPersonaVersionId: "persona_1",
  lifeId: "life_1",
  mainAgentConnectionId: activePartner.agentConnectionId,
  name: "栖光",
  nextWakeAt: "2026-07-16T08:00:00.000Z",
  pendingEventCount: 3,
  personaSummary: "尊重事实，持续整理长期事务。",
  principles: ["诚实"],
  state: "RUNNING",
  timezone: "Asia/Shanghai",
  totalBudgetDailyLimit: 100,
  totalBudgetUsed: 5,
  updatedAt: "2026-07-16T00:00:00.000Z",
};

const diagnostics: DiagnosticsDto = {
  agents: { activeInvocations: 1, connections: 1 },
  database: { integrity: "ok", journalMode: "wal", state: "open" },
  runtime: { activeWakes: 1, enabledSchedules: 2, leases: 1, pendingOutbox: 3, scheduledAlarms: 1, staleWakeTurns: 0 },
  schemaVersion: 4,
  sse: { events: 12 },
  web: { sessions: 1 },
};

describe("joi product voice", () => {
  it("introduces joi on the home page and explains the next step without runtime jargon", () => {
    const { container } = render(<LifeHome agents={[]} lives={[]} onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(screen.getByText("你好，joi 在这里")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "你的智能体，joi 帮你照顾" })).toBeInTheDocument();
    expect(screen.getByText(/joi 需要先连一位能帮它思考和行动的搭档/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/readiness|Agent|Wake|A2A|调用|唤醒/);
  });

  it("uses everyday labels for life cards", () => {
    const { container } = render(<LifeHome agents={[activePartner]} lives={[life]} onCreate={vi.fn()} onOpen={vi.fn()} />);

    expect(screen.getByText("搭档")).toBeInTheDocument();
    expect(screen.getByText("待处理")).toBeInTheDocument();
    expect(screen.getByText("今日动态")).toBeInTheDocument();
    expect(screen.getByText("下一次行动")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/主 Agent|待处理事件|唤醒|调用/);
  });

  it("gives partner connections and diagnostics friendly names instead of raw runtime states", () => {
    const api = new DigitalLifeApi("");
    const partner = render(<AgentPanel agents={[activePartner]} api={api} refresh={vi.fn(() => Promise.resolve())} />);
    expect(screen.getByRole("heading", { name: "工作搭档" })).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
    expect(partner.container).not.toHaveTextContent(/Agents|readiness|ACTIVE|Token|Card/);
    partner.unmount();

    const status = render(<SystemPanel diagnostics={diagnostics} interactions={[]} />);
    expect(screen.getByRole("heading", { name: "joi 的运行状态" })).toBeInTheDocument();
    for (const label of ["数据版本", "工作搭档", "正在协作", "正在行动", "等待处理", "状态更新"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(status.container).not.toHaveTextContent(/Schema|Wake|SSE|Interactions|wal|open|integrity|lease/i);
  });

  it("starts setup in joi's first-person voice", () => {
    const api = new DigitalLifeApi("");
    const { container } = render(<SetupJourney api={api} onComplete={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "先帮 joi 设个密码。" })).toBeInTheDocument();
    expect(screen.getByText(/只存本机/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/STEP|LOCAL ADMIN|Agent Token/);
  });
});
