import { TodoScheduler } from "../../src/main/application/rhythm/todo-scheduler";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("Todo Scheduler", () => {
  it("creates one due event without completing the Todo", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.60/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId, name: "栖遥", personaSummary: "守约", timezone: "UTC",
      });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((database) => database.prepare(`
        INSERT INTO todos (todo_id, life_id, title, status, due_at, created_at, updated_at)
        VALUES ('todo_due', ?, '提交计划', 'OPEN', ?, ?, ?)`)
        .run(life.lifeId, now, now, now));
      const notify = vi.fn();
      const scheduler = new TodoScheduler({
        clock: fixture.clock, ids: fixture.ids, notify, publisher: fixture.sse, store: fixture.database.store,
      });

      const [first, concurrent] = await Promise.all([scheduler.tick(), scheduler.tick()]);
      expect([...first, ...concurrent]).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith(life.lifeId);
      expect((await fixture.database.store.listLifeEvents(life.lifeId)).filter((event) => event.type === "todo.due"))
        .toEqual([expect.objectContaining({ payload: expect.objectContaining({ todoId: "todo_due" }) as unknown })]);
      expect(await fixture.database.store.listTodos(life.lifeId)).toEqual([
        expect.objectContaining({ status: "OPEN", todoId: "todo_due" }),
      ]);
      expect(await scheduler.tick()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
