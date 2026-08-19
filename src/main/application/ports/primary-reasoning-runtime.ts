export type PrimaryReasoningEvent =
  | { type: "turn_started"; turnId: string }
  | { type: "text_delta"; delta: string; turnId: string }
  | { type: "thinking_delta"; delta: string; turnId: string }
  | { type: "tool_started"; toolCallId: string; toolName: string; turnId: string }
  | { type: "tool_finished"; isError: boolean; reasonCode?: string; toolCallId: string; toolName: string; turnId: string }
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
  sessionId: string;
  sourceId: string;
  sourceRevisionId: string;
  systemPrompt: string;
  turnId: string;
}

export interface JoiReasoningSessionSnapshot {
  workbenchId: string;
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
  startTurn(input: StartReasoningTurnInput): Promise<void>;
  steer(sessionId: string, text: string): void;
  waitForIdle(sessionId: string): Promise<void>;
}
