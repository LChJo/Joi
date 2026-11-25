export interface JoiTurnRetryState {
  failureCount: number;
  sessionGeneration: number;
  epoch: number;
  failedAt?: string;
  reasonCode?: string;
  retryAt?: string;
  queued?: boolean;
}

export interface JoiTaskPendingInput {
  createdAt: string;
  inputId: string;
  goalInputId?: string;
  /** A bound goal result synthesis can run alongside other goals. */
  synthesis?: boolean;
  /** The current gate has a persisted answer awaiting review. */
  goalResume?: boolean;
  /** Persisted user actions are deterministic and do not require a model source. */
  requiresModelSource?: boolean;
  retryState?: JoiTurnRetryState;
}

export const GOAL_SYNTHESIS_YIELD = Symbol("goal_synthesis_yield");

export interface JoiTaskStaleTurn {
  inputId: string;
  turnId: string;
}

/** DB-fact view the joi task component traverses; PENDING rows are the only scheduling truth. */
export interface JoiTaskInbox {
  getRetryState?(inputId: string): Promise<JoiTurnRetryState | undefined>;
  deferRetry?(inputId: string, input: { failureCount: number; retryAt: string; epoch?: number }): Promise<boolean>;
  recordSchedulingFailure?(inputId: string, input: { startedAt: string; failedAt: string; reasonCode: string; epoch?: number }): Promise<void>;
  recoverInterruptedGoalReviews?(): Promise<void>;
  park(inputId: string, failure: { failureCount: number; reasonCode: string }): Promise<void>;
  listPendingInputs(): Promise<JoiTaskPendingInput[]>;
  listStaleRunningTurns(olderThan: string): Promise<JoiTaskStaleTurn[]>;
  failTurn(inputId: string, turnId: string): Promise<void>;
  /** Synthesis can yield while its active turn has no recorded mutation. */
  canYieldSynthesis?(inputId: string): Promise<boolean>;
  /** True once the goal was canceled by the user; an in-flight turn must then abort. */
  isCanceled(inputId: string): Promise<boolean>;
}

export interface JoiTurnDriver {
  handle(inputId: string, signal?: AbortSignal): Promise<void>;
}

export interface ModelSourceGate {
  hasReadySource(): Promise<boolean>;
}
