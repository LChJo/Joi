export interface JoiTaskPendingInput {
  createdAt: string;
  inputId: string;
  /** Persisted user actions are deterministic and do not require a model source. */
  requiresModelSource?: boolean;
}

export interface JoiTaskStaleTurn {
  inputId: string;
  turnId: string;
}

/** DB-fact view the joi task component traverses; PENDING rows are the only scheduling truth. */
export interface JoiTaskInbox {
  park(inputId: string, failure: { failureCount: number; reasonCode: string }): Promise<void>;
  listPendingInputs(): Promise<JoiTaskPendingInput[]>;
  listStaleRunningTurns(olderThan: string): Promise<JoiTaskStaleTurn[]>;
  failTurn(inputId: string, turnId: string): Promise<void>;
}

export interface JoiTurnDriver {
  handle(inputId: string, signal?: AbortSignal): Promise<void>;
}

export interface ModelSourceGate {
  hasReadySource(): Promise<boolean>;
}
