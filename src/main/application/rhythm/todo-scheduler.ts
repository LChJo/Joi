import type { Clock, IdGenerator, RuntimeStore, SsePublisher } from "../ports/runtime-store.js";

export class TodoScheduler {
  constructor(private readonly dependencies: {
    clock: Clock;
    ids: IdGenerator;
    notify?: (lifeId: string) => void;
    publisher: SsePublisher;
    store: RuntimeStore;
  }) {}

  async tick(limit = 100): Promise<string[]> {
    const now = this.dependencies.clock.now().toISOString();
    const created: string[] = [];
    for (const todo of await this.dependencies.store.listDueTodos(now, limit)) {
      if (todo.dueAt === undefined) continue;
      const result = await this.dependencies.store.fireTodoOccurrence({
        event: {
          ...(todo.affairId === undefined ? {} : { affairId: todo.affairId }),
          attemptCount: 0,
          availableAt: todo.dueAt,
          createdAt: now,
          dedupeKey: `${todo.todoId}:${todo.dueAt}`,
          eventId: this.dependencies.ids.next("event"),
          lifeId: todo.lifeId,
          occurredAt: todo.dueAt,
          payload: { dueAt: todo.dueAt, title: todo.title, todoId: todo.todoId },
          priority: 2,
          source: "schedule",
          status: "PENDING",
          type: "todo.due",
        },
        now,
        occurrenceAt: todo.dueAt,
        todoId: todo.todoId,
      });
      if (result.created && result.event !== null) {
        created.push(result.event.eventId);
        this.dependencies.notify?.(todo.lifeId);
      }
      for (const event of result.sse) await this.dependencies.publisher.publish(event);
    }
    return created;
  }
}
