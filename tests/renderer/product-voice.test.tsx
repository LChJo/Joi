// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

import { DigitalLifeApi } from "../../src/renderer/api";
import { SystemPanel } from "../../src/renderer/Console";
import { SetupJourney } from "../../src/renderer/Onboarding";
import type { DiagnosticsDto } from "../../src/renderer/types";

const diagnostics: DiagnosticsDto = {
  agents: { activeInvocations: 1, connections: 1 },
  database: { integrity: "ok", journalMode: "wal", state: "open" },
  runtime: { activeWakes: 1, enabledSchedules: 2, leases: 1, pendingOutbox: 3, scheduledAlarms: 1, staleWakeTurns: 0 },
  schemaVersion: 4,
  sse: { events: 12 },
  web: { sessions: 1 },
};

describe("joi product voice", () => {
  it("gives diagnostics friendly names instead of raw runtime states", () => {
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
