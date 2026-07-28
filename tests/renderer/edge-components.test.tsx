// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

import { SettingsPanel, SystemPanel } from "../../src/renderer/Console";
import { DigitalLifeApi } from "../../src/renderer/api";
import type { DiagnosticsDto } from "../../src/renderer/types";
import { formatDate, initials, isoToLocalDateTime, localDateTimeToIso } from "../../src/renderer/view-utils";

const diagnostics: DiagnosticsDto = { agents: { connections: 0 }, database: { journalMode: "wal", state: "open" }, runtime: { pendingOutbox: 0 }, schemaVersion: 4, sse: { events: 0 }, web: { sessions: 0 } };

describe("renderer edge components", () => {
  it("formats fallback values and timezone edge cases", () => {
    expect(initials("  ")).toBe("JO");
    expect(formatDate("2026-07-15T12:00:00Z")).toMatch(/07/);
    expect(formatDate("invalid", "Invalid/Zone")).toBe("invalid");
    expect(localDateTimeToIso("2026-07-16T08:30", "Asia/Shanghai")).toBe("2026-07-16T00:30:00.000Z");
    expect(initials("digital life")).toBe("DI");
    expect(() => localDateTimeToIso("not-a-date", "UTC")).toThrow("invalid");
    expect(isoToLocalDateTime("2026-07-16T00:30:00.000Z", "Asia/Shanghai")).toBe("2026-07-16T08:30");
    expect(() => localDateTimeToIso("2026-03-08T02:30", "America/New_York")).toThrow("do not exist");
  });

  it("renders diagnostic loading, healthy-empty interactions, and unknown schema", () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "listBackups").mockResolvedValue({ items: [] });
    const view = render(<SystemPanel diagnostics={null} interactions={[]} />);
    expect(screen.getByLabelText("joi 正在整理页面")).toBeInTheDocument();
    view.rerender(<SystemPanel diagnostics={diagnostics} interactions={[]} />);
    expect(screen.getByText("0 项待处理")).toBeInTheDocument();
    view.rerender(<SystemPanel diagnostics={{ ...diagnostics, web: { lan: { status: 42 }, sessions: 1 } }} interactions={[{ createdAt: "now", interactionId: "i", invocationId: "v", kind: "input-required", prompt: "p", status: "PENDING" }]} />);
    expect(screen.getByText("待确认")).toBeInTheDocument();
    expect(screen.getByText("需要关注")).toBeInTheDocument();
    view.rerender(<SettingsPanel api={api} diagnostics={null} />);
    expect(screen.getByText(/数据格式 v-/)).toBeInTheDocument();
  });
});
