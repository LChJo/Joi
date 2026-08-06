// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

import { DigitalLifeApi } from "../../src/renderer/api.js";
import { SystemPanel } from "../../src/renderer/Console.js";
import type { DiagnosticsDto } from "../../src/renderer/types";

const diagnostics: DiagnosticsDto = {
  agents: { connections: 1 },
  database: { integrity: "ok", journalMode: "wal", state: "ok" },
  runtime: { pendingOutbox: 0 },
  schemaVersion: 24,
  sse: { events: 3 },
  web: { sessions: 1 },
};

describe("system panel private partner context", () => {
  it("does not expose work memory or instance data and points to the Workbench context center", () => {
    const api = new DigitalLifeApi("");
    render(<SystemPanel api={api} diagnostics={diagnostics} interactions={[]} />);
    expect(screen.getByRole("heading", { name: "私有执行上下文" })).toBeInTheDocument();
    expect(screen.getByText(/请到工作台上下文中心查看状态/u)).toBeInTheDocument();
    expect(screen.queryByLabelText("选择搭档")).not.toBeInTheDocument();
    expect(screen.queryByText("重构登录页")).not.toBeInTheDocument();
  });
});
