/**
 * Formal deadlines for native partner runs. The total cap fires before any downstream
 * deadline (the dispatch watchdog is a 32 min silence backstop, so a run that keeps
 * streaming never races it); the idle cap matches the PI engine's existing idle semantics
 * and is refreshed by every streamed event. A run still streaming at total expiry gets one
 * 2 min grace window to land its in-flight turn, bounding an actively streaming run at
 * total + grace instead of aborting it mid-landing.
 */
export const NATIVE_RUN_DEADLINES = {
  graceActiveWindowMillis: 2 * 60_000,
  graceMillis: 2 * 60_000,
  idleMillis: 20 * 60_000,
  totalMillis: 30 * 60_000,
} as const;
