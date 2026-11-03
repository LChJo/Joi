import type { Clock, RuntimeStore, SsePublisher } from "../ports/runtime-store.js";

export class ExpressionDeliveryScheduler {
  constructor(private readonly dependencies: { clock: Clock; publisher: SsePublisher; store: RuntimeStore }) {}

  async tick(limit = 100): Promise<string[]> {
    const result = await this.dependencies.store.deliverDueExpressions(this.dependencies.clock.now().toISOString(), limit);
    for (const event of result.sse) await this.dependencies.publisher.publish(event);
    return result.expressions.map((expression) => expression.expressionId);
  }
}
