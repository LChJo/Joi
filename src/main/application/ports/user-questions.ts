import type { UserQuestionAnswer, UserQuestionDto, UserQuestionPrompt, UserQuestionScope } from "../../../shared/user-questions.js";

export interface EnqueueUserQuestion extends UserQuestionPrompt {
  questionId: string;
  scope: UserQuestionScope;
  ownerId: string;
  parentTurnId?: string;
  sourceName: string;
  toolCallId?: string;
  actionId?: string;
  workId?: string;
  runId?: string;
}
export interface UserQuestionRecord extends UserQuestionDto {
  toolCallId?: string;
  actionId?: string;
  workId?: string;
  runId?: string;
}
export interface UserQuestionStore {
  enqueue(question: UserQuestionRecord, now: string): Promise<UserQuestionRecord>;
  list(scope: UserQuestionScope): Promise<UserQuestionRecord[]>;
  get(questionId: string): Promise<UserQuestionRecord | null>;
  answer(questionId: string, version: number, answer: UserQuestionAnswer, now: string): Promise<UserQuestionRecord | null>;
  due(now: string): Promise<UserQuestionRecord[]>;
  pendingGoalAnswers(): Promise<UserQuestionRecord[]>;
  cancelOwner(ownerId: string, now: string): Promise<string[]>;
  cancelQuestion(scope: UserQuestionScope, questionId: string, now: string): Promise<boolean>;
  markDelivered(questionId: string): Promise<void>;
  interruptOwner(ownerId: string, now: string): Promise<UserQuestionRecord[]>;
  interruptUnfinishedConversations(): Promise<void>;
}
