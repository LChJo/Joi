import { TodoScheduler } from "../../src/main/application/rhythm/todo-scheduler";
import type { RuntimeStore, SseEvent } from "../../src/main/application/ports/runtime-store";

describe("Todo Scheduler edge handling", () => {
  it("skips malformed undated records and publishes an affair-bound occurrence without a notifier", async () => {
    const sse: SseEvent = {
      createdAt: "2026-07-15T12:00:00.000Z",
      entityId: "life_1",
      payload: {},
      sequence: 1,
      type: "event.created",
    };
    const fireTodoOccurrence = vi.fn(() => Promise.resolve({
      created: true,
      event: {
        affairId: "affair_1",
        attemptCount: 0,
        availableAt: "2026-07-15T12:00:00.000Z",
        createdAt: "2026-07-15T12:00:00.000Z",
        eventId: "event_1",
        lifeId: "life_1",
        occurredAt: "2026-07-15T12:00:00.000Z",
        payload: {},
        priority: 2,
        source: "schedule" as const,
        status: "PENDING" as const,
        type: "todo.due",
      },
      sse: [sse],
    }));
    const store = {
      fireTodoOccurrence,
      listDueTodos: vi.fn(() => Promise.resolve([
        {
          createdAt: sse.createdAt, lifeId: "life_1", status: "OPEN", title: "无日期", todoId: "todo_bad", updatedAt: sse.createdAt,
        },
        {
          affairId: "affair_1", createdAt: sse.createdAt, dueAt: sse.createdAt, lifeId: "life_1",
          status: "IN_PROGRESS", title: "有日期", todoId: "todo_1", updatedAt: sse.createdAt,
        },
      ])),
    } as unknown as RuntimeStore;
    const publish = vi.fn();
    const scheduler = new TodoScheduler({
      clock: { now: () => new Date(sse.createdAt) }, ids: { next: () => "event_1" }, publisher: { publish }, store,
    });

    await expect(scheduler.tick(2)).resolves.toEqual(["event_1"]);
    expect(fireTodoOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ affairId: "affair_1" }) as unknown,
      todoId: "todo_1",
    }));
    expect(publish).toHaveBeenCalledWith(sse);
  });
});
