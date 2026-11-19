export const USER_QUESTION_TIMEOUT_MILLIS = 30 * 60_000;
export const DEFAULT_QUESTION_ANSWER = "请在现有权限与约束内采用你推荐的方案继续；若缺少不可替代的信息，请说明阻塞，不要编造。";

export interface UserQuestionScope { kind: "GOAL" | "CONVERSATION"; id: string; }
export interface UserQuestionOption { id: string; label: string; description?: string; recommended?: boolean; }
export interface UserQuestionAnswer {
  text: string;
  selectedOptionIds: string[];
  source: "USER" | "USER_DEFAULT" | "TIMEOUT_DEFAULT";
  answeredAt: string;
}
export interface UserQuestionDto {
  questionId: string;
  version: number;
  scope: UserQuestionScope;
  ownerId: string;
  parentTurnId?: string;
  sourceName: string;
  question: string;
  kind: "QUESTION" | "CONFIRM";
  options: UserQuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
  defaultAnswer: string;
  defaultOptionIds: string[];
  status: "QUEUED" | "ACTIVE" | "ANSWERED" | "CANCELED" | "SUPERSEDED";
  createdAt: string;
  activatedAt?: string;
  expiresAt?: string;
  answer?: UserQuestionAnswer;
  delivery: "PENDING" | "DELIVERED" | "INTERRUPTED";
}
export interface AnswerUserQuestionInput { version: number; text?: string; selectedOptionIds?: string[]; useDefault?: boolean; }
export interface UserQuestionPrompt {
  question: string;
  options?: UserQuestionOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  defaultAnswer?: string;
  defaultOptionIds?: string[];
  kind?: "QUESTION" | "CONFIRM";
}
