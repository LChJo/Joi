/**
 * Formal deadlines for native partner runs. The total cap fires before any downstream
 * deadline (watchdog 32 min > total 30 min); the idle cap matches the PI engine's
 * existing idle semantics and is refreshed by every streamed event.
 */
export const NATIVE_RUN_DEADLINES = {
  idleMillis: 20 * 60_000,
  totalMillis: 30 * 60_000,
} as const;
