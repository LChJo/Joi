import { normalizeAgentConversationEntries } from "../../src/main/application/partners/agent-conversation-presentation.js";
import { TOOL_TRACE_MAX_BODY_CHARS, type ToolTraceDraft } from "../../src/main/application/partners/tool-trace-presentation.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

async function seedRun(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>, sessionPolicy: "EPHEMERAL" | "RESIDENT") {
  const workbench = await fixture.workbenchRegistry.create({ name: "测试", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
  const partner = await fixture.partners.add({ capabilities: [], displayName: "测试搭档", kind: "local-pi", skills: [], tools: [] });
  const instance = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy });
  const repository = new SqliteWorkbenchAgentRepository(fixture.database);
  const runId = "run-traces";
  const context = { agentId: instance.instanceId, runId, startedAt: "2026-09-26T10:00:00.000Z" };
  const entries = normalizeAgentConversationEntries(context, [
    { kind: "TOOL_CALL", role: "TOOL", text: "npm test", toolCallId: "toolu_1", toolName: "bash" },
    { kind: "TOOL_RESULT", role: "TOOL", text: "执行完成", toolCallId: "toolu_1", toolName: "bash" },
  ]);
  return { agentId: instance.instanceId, repository, runId, workbenchId: workbench.workbenchId, entries };
}

function trace(overrides: Partial<ToolTraceDraft> = {}): ToolTraceDraft {
  return {
    command: "cd C:\\work\\repo && npm test",
    isError: false,
    result: "42 passing",
    toolCallId: "toolu_1",
    toolName: "bash",
    truncated: false,
    ...overrides,
  };
}

describe("AC-61 workbench agent tool traces", () => {
  it("stores one row per call id and lets the latest write win", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const seeded = await seedRun(fixture, "EPHEMERAL");
      const createdAt = fixture.clock.now().toISOString();
      await seeded.repository.appendToolTrace({ agentId: seeded.agentId, createdAt, runId: seeded.runId, trace: trace() });
      await seeded.repository.appendToolTrace({ agentId: seeded.agentId, createdAt, runId: seeded.runId, trace: trace({ result: "43 passing" }) });
      const rows = fixture.database.transaction(c => c.prepare("SELECT result FROM workbench_agent_tool_traces WHERE agent_id = ?").all(seeded.agentId));
      expect(rows).toEqual([{ result: "43 passing" }]);
    } finally { await fixture.close(); }
  });

  it("keeps absolute paths in the stored body while the conversation projection stays path-free", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const seeded = await seedRun(fixture, "EPHEMERAL");
      await seeded.repository.replaceRun(seeded.agentId, seeded.runId, seeded.entries);
      await seeded.repository.appendToolTrace({
        agentId: seeded.agentId, createdAt: fixture.clock.now().toISOString(), runId: seeded.runId, trace: trace(),
      });

      const page = await seeded.repository.conversation({ agentId: seeded.agentId, workbenchId: seeded.workbenchId, limit: 50 });
      expect(JSON.stringify(page)).not.toContain("C:\\work");

      const revealed = await seeded.repository.revealToolTrace({ agentId: seeded.agentId, toolCallId: "toolu_1", workbenchId: seeded.workbenchId });
      expect(revealed.command).toContain("C:\\work\\repo");
      expect(revealed.result).toBe("42 passing");
      expect(revealed).toMatchObject({ isError: false, toolName: "bash", truncated: false });
    } finally { await fixture.close(); }
  });

  it("rejects an unknown call, an unknown agent and a foreign workbench", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const seeded = await seedRun(fixture, "EPHEMERAL");
      await seeded.repository.replaceRun(seeded.agentId, seeded.runId, seeded.entries);
      await expect(seeded.repository.revealToolTrace({ agentId: seeded.agentId, toolCallId: "toolu_missing", workbenchId: seeded.workbenchId }))
        .rejects.toMatchObject({ code: "workbench_tool_trace_not_found" });
      await expect(seeded.repository.revealToolTrace({ agentId: "agent_missing", toolCallId: "toolu_1", workbenchId: seeded.workbenchId }))
        .rejects.toMatchObject({ code: "workbench_agent_not_found" });

      const other = await fixture.workbenchRegistry.create({ name: "别处", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      await expect(seeded.repository.revealToolTrace({ agentId: seeded.agentId, toolCallId: "toolu_1", workbenchId: other.workbenchId }))
        .rejects.toMatchObject({ code: "workbench_agent_not_found" });
    } finally { await fixture.close(); }
  });

  it("does not expose a trace whose call is absent from the conversation", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const seeded = await seedRun(fixture, "EPHEMERAL");
      await seeded.repository.appendToolTrace({
        agentId: seeded.agentId, createdAt: fixture.clock.now().toISOString(), runId: seeded.runId, trace: trace(),
      });
      await expect(seeded.repository.revealToolTrace({ agentId: seeded.agentId, toolCallId: "toolu_1", workbenchId: seeded.workbenchId }))
        .rejects.toMatchObject({ code: "workbench_tool_trace_not_found" });
    } finally { await fixture.close(); }
  });

  it("re-clamps an oversized stored body on read", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const seeded = await seedRun(fixture, "EPHEMERAL");
      await seeded.repository.replaceRun(seeded.agentId, seeded.runId, seeded.entries);
      fixture.database.transaction(c => c.prepare(`INSERT INTO workbench_agent_tool_traces
        (agent_id, run_id, tool_call_id, tool_name, command, result, is_error, truncated, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`).run(
        seeded.agentId, seeded.runId, "toolu_1", "bash", "x".repeat(20_000), "y".repeat(20_000), "2026-09-26T10:00:00.000Z",
      ));
      const revealed = await seeded.repository.revealToolTrace({ agentId: seeded.agentId, toolCallId: "toolu_1", workbenchId: seeded.workbenchId });
      expect(revealed.command).toHaveLength(TOOL_TRACE_MAX_BODY_CHARS);
      expect(revealed.result).toHaveLength(TOOL_TRACE_MAX_BODY_CHARS);
      expect(revealed.truncated).toBe(true);
    } finally { await fixture.close(); }
  });

  it("clears an agent's traces when the ephemeral agent is dismissed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const seeded = await seedRun(fixture, "EPHEMERAL");
      await seeded.repository.replaceRun(seeded.agentId, seeded.runId, seeded.entries);
      await seeded.repository.appendToolTrace({
        agentId: seeded.agentId, createdAt: fixture.clock.now().toISOString(), runId: seeded.runId, trace: trace(),
      });
      // dismiss only accepts a terminal agent; converge the instance directly rather than
      // wiring an engine into the fixture just to dispose it.
      fixture.database.transaction(c => c.prepare("UPDATE partner_instances SET status = 'DISPOSED', disposal_reason = 'ephemeral_completed' WHERE instance_id = ?").run(seeded.agentId));
      await seeded.repository.dismiss({ agentId: seeded.agentId, workbenchId: seeded.workbenchId, dismissedAt: fixture.clock.now().toISOString() });
      const rows = fixture.database.transaction(c => c.prepare("SELECT COUNT(*) AS n FROM workbench_agent_tool_traces").get() as { n: number });
      expect(rows.n).toBe(0);
    } finally { await fixture.close(); }
  });

  it("backfills a tool call id onto an entry that was persisted without one", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const seeded = await seedRun(fixture, "RESIDENT");
      const withoutId = seeded.entries.map(({ toolCallId: _dropped, ...entry }) => entry);
      await seeded.repository.replaceRun(seeded.agentId, seeded.runId, withoutId);
      expect((await seeded.repository.conversation({ agentId: seeded.agentId, workbenchId: seeded.workbenchId, limit: 50 })).items[0]?.toolCallId).toBeUndefined();

      const changes = () => fixture.database.transaction(c => (c.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
      const before = changes();
      await seeded.repository.replaceRun(seeded.agentId, seeded.runId, seeded.entries);
      // A guard without tool_call_id would treat every row as unchanged and write nothing.
      expect(changes() - before).toBe(2);
      expect((await seeded.repository.conversation({ agentId: seeded.agentId, workbenchId: seeded.workbenchId, limit: 50 })).items[0]?.toolCallId).toBe("toolu_1");
    } finally { await fixture.close(); }
  });
});
