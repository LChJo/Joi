export class WakeLiveness {
  constructor(private readonly thresholds: { staleThresholdMs: number; startupGraceMs: number }) {}

  isStale(input: { createdAt: string; inProcess: boolean; lastTurnActivityAt?: string; now: Date }): boolean {
    if (input.inProcess) return false;
    if (input.lastTurnActivityAt !== undefined
      && input.now.getTime() - Date.parse(input.lastTurnActivityAt) <= this.thresholds.staleThresholdMs) return false;
    return input.now.getTime() - Date.parse(input.createdAt) > this.thresholds.startupGraceMs;
  }
}
