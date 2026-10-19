export type JoiReasoningOutcome = "DIRECT_ANSWER" | "TEAM_READY" | "RESULT_SYNTHESIZED" | "RESULT_CONTINUE" | "RESULT_BLOCKED" | "MAP_CLEARED";

export type PrimaryReasoningEvent =
  | { type: "turn_started"; turnId: string }
  | { type: "text_delta"; delta: string; turnId: string }
  | { type: "thinking_delta"; delta: string; turnId: string }
  | { type: "tool_started"; toolCallId: string; toolName: string; turnId: string }
  | { type: "tool_finished"; isError: boolean; outcome?: JoiReasoningOutcome; reasonCode?: string; toolCallId: string; toolName: string; turnId: string }
  | { type: "turn_finished"; turnId: string };

export interface StartReasoningTurnInput {
  workbenchId: string;
  /** Attachment ids bound to this input; scopes tools like attachment_read. */
  attachmentIds?: readonly string[];
  /** Original goal input when this turn serves a derived input (synthesis / harness review). */
  goalInputId?: string;
  /** Image attachments delivered as multimodal parts alongside the prompt. */
  images?: readonly { data: string; mimeType: string }[];
  inputId: string;
  modelId: string;
  modelRevisionId: string;
  onEvent?: (event: PrimaryReasoningEvent) => void;
  prompt: string;
  /** Refreshed private reference data for this request, excluded from the durable transcript. */
  backgroundContext?: string;
  /** Richer bounded alternatives, ordered from smaller to larger; selected only with spare capacity. */
  backgroundContextVariants?: readonly string[];
  /** Mandatory goal context, refreshed after tools and never saved in the transcript. */
  requiredContext?: string;
  refreshRequiredContext?: () => Promise<string>;
  sessionId: string;
  sourceId: string;
  sourceRevisionId: string;
  systemPrompt: string;
  turnId: string;
}

export interface JoiReasoningSessionSnapshot {
  workbenchId: string;
  /** Private source messages replaced by checkpoints, available only to this session's history tool. */
  archivedMessages?: unknown[];
  compaction?: {
    compactedMessages: number;
    count: number;
    lastCompactedAt: string;
    summary: string;
  } | undefined;
  messages: unknown[];
  modelRevisionId: string;
  sessionId: string;
  sourceRevisionId: string;
  systemPrompt: string;
  updatedAt: string;
}

export interface ReasoningSessionStore {
  load(sessionId: string): Promise<JoiReasoningSessionSnapshot | null>;
  save(snapshot: JoiReasoningSessionSnapshot): Promise<void>;
}

export interface PrimaryReasoningRuntime {
  abort(sessionId: string): void;
  followUp(sessionId: string, text: string): void;
  isRunning(sessionId: string): boolean;
  restore(sessionId: string): Promise<boolean>;
  /**
   * Drops this Turn's transcript from the session, for a Turn that failed after `startTurn`
   * returned. Resolves false when nothing was rolled back — an unknown session, a stream still
   * running, or a Turn that never marked a rollback point — so the caller can report it.
   */
  rollbackTurn(sessionId: string, turnId: string): Promise<boolean>;
  startTurn(input: StartReasoningTurnInput): Promise<void>;
  steer(sessionId: string, text: string): void;
  waitForIdle(sessionId: string): Promise<void>;
}
