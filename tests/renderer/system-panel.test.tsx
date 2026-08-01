// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

function mockPartners(api: DigitalLifeApi) {
  vi.spyOn(api, "listPartners").mockResolvedValue({
    items: [{
      capabilities: [], createdBy: "user", displayName: "Memory holder", engine: "pi-core", inFlightCount: 0,
      kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId: "partner_1",
      partnerRevisionId: "revision_1", registryRevision: 1, skills: [], status: "ACTIVE", tools: [],
    }],
  });
}

describe("system panel partner work memory", () => {
  it("shows the read-only memory ledger and live instances of the selected partner", async () => {
    const api = new DigitalLifeApi("");
    mockPartners(api);
    vi.spyOn(api, "partnerMemory").mockResolvedValue({
      entries: [{
        createdAt: "2026-07-29T10:00:00.000Z", memoryId: "memory_1", outcome: "COMPLETED", partnerId: "partner_1",
        sessionDataSource: "partner_instance_messages:instance_1", title: "重构登录页",
      }],
      summary: "1 of 1 recent runs completed.",
      summaryUpdatedAt: "2026-07-29T10:05:00.000Z",
    });
    vi.spyOn(api, "listPartnerInstances").mockResolvedValue({
      items: [{
        createdAt: "2026-07-29T10:00:00.000Z", engine: "pi-core", externalSessionRef: "partner_instance_messages:instance_1",
        instanceId: "instance_1", lastUsedAt: "2026-07-29T10:04:00.000Z", partnerId: "partner_1",
        sessionPolicy: "RESIDENT", status: "IDLE",
      }],
    });

    render(<SystemPanel api={api} diagnostics={diagnostics} interactions={[]} />);
    expect(await screen.findByText("搭档工作记忆（只读）")).toBeInTheDocument();
    expect(screen.queryByText("重构登录页")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("选择搭档"), { target: { value: "partner_1" } });
    expect(await screen.findByText("1 of 1 recent runs completed.", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByText("重构登录页")).toBeInTheDocument();
    expect(screen.getAllByText(/partner_instance_messages:instance_1/u).length).toBeGreaterThan(0);
    expect(screen.getByText("常驻实例")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("选择搭档"), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText("重构登录页")).not.toBeInTheDocument());
  });

  it("explains when the memory ledger cannot be loaded", async () => {
    const api = new DigitalLifeApi("");
    mockPartners(api);
    vi.spyOn(api, "partnerMemory").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "listPartnerInstances").mockResolvedValue({ items: [] });
    render(<SystemPanel api={api} diagnostics={diagnostics} interactions={[]} />);
    fireEvent.change(await screen.findByLabelText("选择搭档", {}, { timeout: 4_000 }), { target: { value: "partner_1" } });
    expect(await screen.findByText("没能读取搭档工作记忆。", {}, { timeout: 4_000 })).toBeInTheDocument();
  });
});
