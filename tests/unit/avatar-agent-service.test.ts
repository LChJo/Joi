import { AvatarAgentService } from "../../src/main/application/partners/avatar-agent-service.js";
import { TestClock } from "../support/runtime-fixture.js";

describe("AvatarAgentService", () => {
  it("forwards defaults, cursors and terminal dismiss timestamps", async () => {
    const repository = {
      append: vi.fn(),
      conversation: vi.fn(() => Promise.resolve({ agent: {}, items: [] })),
      dismiss: vi.fn(() => Promise.resolve()),
      listAgents: vi.fn(() => Promise.resolve({ items: [] })),
    };
    const service = new AvatarAgentService({ clock: new TestClock(), repository: repository as never });
    await service.list({ avatarId: "avatar-1" });
    await service.list({ avatarId: "avatar-1", cursor: "cursor", limit: 12 });
    await service.list({ avatarId: "avatar-1", goalId: "goal-1" });
    await service.conversation({ agentId: "agent-1", avatarId: "avatar-1" });
    await service.conversation({ agentId: "agent-1", avatarId: "avatar-1", cursor: "entry", limit: 30 });
    await service.dismiss({ agentId: "agent-1", avatarId: "avatar-1" });
    expect(repository.listAgents).toHaveBeenNthCalledWith(1, { avatarId: "avatar-1", limit: 50 });
    expect(repository.listAgents).toHaveBeenNthCalledWith(2, { avatarId: "avatar-1", cursor: "cursor", limit: 12 });
    expect(repository.listAgents).toHaveBeenNthCalledWith(3, { avatarId: "avatar-1", goalId: "goal-1", limit: 50 });
    expect(repository.conversation).toHaveBeenNthCalledWith(1, { agentId: "agent-1", avatarId: "avatar-1", limit: 50 });
    expect(repository.conversation).toHaveBeenNthCalledWith(2, { agentId: "agent-1", avatarId: "avatar-1", cursor: "entry", limit: 30 });
    expect(repository.dismiss).toHaveBeenCalledWith({ agentId: "agent-1", avatarId: "avatar-1", dismissedAt: "2026-07-15T12:00:00.000Z" });
  });
});
