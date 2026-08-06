import { WorkbenchAgentService } from "../../src/main/application/partners/workbench-agent-service.js";
import { TestClock } from "../support/runtime-fixture.js";

describe("WorkbenchAgentService", () => {
  it("forwards defaults, cursors and terminal dismiss timestamps", async () => {
    const repository = {
      append: vi.fn(),
      conversation: vi.fn(() => Promise.resolve({ agent: {}, items: [] })),
      dismiss: vi.fn(() => Promise.resolve()),
      listAgents: vi.fn(() => Promise.resolve({ items: [] })),
    };
    const service = new WorkbenchAgentService({ clock: new TestClock(), repository: repository as never });
    await service.list({ workbenchId: "workbench-1" });
    await service.list({ workbenchId: "workbench-1", cursor: "cursor", limit: 12 });
    await service.list({ workbenchId: "workbench-1", goalId: "goal-1" });
    await service.conversation({ agentId: "agent-1", workbenchId: "workbench-1" });
    await service.conversation({ agentId: "agent-1", workbenchId: "workbench-1", cursor: "entry", limit: 30 });
    await service.dismiss({ agentId: "agent-1", workbenchId: "workbench-1" });
    expect(repository.listAgents).toHaveBeenNthCalledWith(1, { workbenchId: "workbench-1", limit: 50 });
    expect(repository.listAgents).toHaveBeenNthCalledWith(2, { workbenchId: "workbench-1", cursor: "cursor", limit: 12 });
    expect(repository.listAgents).toHaveBeenNthCalledWith(3, { workbenchId: "workbench-1", goalId: "goal-1", limit: 50 });
    expect(repository.conversation).toHaveBeenNthCalledWith(1, { agentId: "agent-1", workbenchId: "workbench-1", limit: 50 });
    expect(repository.conversation).toHaveBeenNthCalledWith(2, { agentId: "agent-1", workbenchId: "workbench-1", cursor: "entry", limit: 30 });
    expect(repository.dismiss).toHaveBeenCalledWith({ agentId: "agent-1", workbenchId: "workbench-1", dismissedAt: "2026-07-15T12:00:00.000Z" });
  });
});
