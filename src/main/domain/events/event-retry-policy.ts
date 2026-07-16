const RETRY_MINUTES = [2, 4, 8, 16, 32, 60] as const;

export class EventRetryPolicy {
  afterFailure(input: { attemptCount: number; maxAttempts: number; now: Date }):
    | { attemptCount: number; availableAt: string; delayMinutes: number; status: "PENDING" }
    | { attemptCount: number; status: "DEAD_LETTER" } {
    if (input.attemptCount >= input.maxAttempts) return { attemptCount: input.attemptCount, status: "DEAD_LETTER" };
    const delayMinutes = RETRY_MINUTES[Math.min(Math.max(input.attemptCount - 1, 0), RETRY_MINUTES.length - 1)] ?? 60;
    return {
      attemptCount: input.attemptCount,
      availableAt: new Date(input.now.getTime() + delayMinutes * 60_000).toISOString(),
      delayMinutes,
      status: "PENDING",
    };
  }
}
