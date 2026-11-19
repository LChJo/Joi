import { DomainError } from "../../domain/errors.js";
import { sanitizeAgentConversationText } from "../partners/agent-conversation-presentation.js";
import type { Clock } from "../ports/runtime-store.js";
import type { EnqueueUserQuestion, UserQuestionRecord, UserQuestionStore } from "../ports/user-questions.js";
import { DEFAULT_QUESTION_ANSWER, type AnswerUserQuestionInput, type UserQuestionAnswer, type UserQuestionDto, type UserQuestionPrompt, type UserQuestionScope } from "../../../shared/user-questions.js";

export function questionDto(record: UserQuestionRecord): UserQuestionDto {
  const dto = { ...record };
  delete dto.toolCallId;delete dto.actionId;delete dto.workId;delete dto.runId;
  return { ...dto,sourceName: sanitizeAgentConversationText(dto.sourceName),question: sanitizeAgentConversationText(dto.question),
    defaultAnswer: sanitizeAgentConversationText(dto.defaultAnswer),options: dto.options.map(option => ({ ...option,label: sanitizeAgentConversationText(option.label),
      ...(option.description === undefined ? {} : { description: sanitizeAgentConversationText(option.description) }) })),
    ...(dto.answer === undefined ? {} : { answer: { ...dto.answer,text: sanitizeAgentConversationText(dto.answer.text) } }) };
}
export function normalizeUserQuestionPrompt(input: UserQuestionPrompt) {
  const prompt = input.question.trim();
  const options = input.options ?? [];
  if (!prompt || prompt.length > 8_000 || options.length > 12
    || options.some(option => !option.id || option.id.length > 100 || !option.label.trim() || option.label.length > 500)
    || new Set(options.map(option => option.id)).size !== options.length) throw new DomainError("question_invalid", "The question is invalid.");
  const multiSelect = input.multiSelect ?? false;
  const defaults = input.defaultOptionIds ?? options.filter(option => option.recommended).map(option => option.id);
  if (new Set(defaults).size !== defaults.length || defaults.some(id => !options.some(option => option.id === id)) || (!multiSelect && defaults.length > 1)) {
    throw new DomainError("question_invalid", "The recommended answer is invalid.");
  }
  const explicitDefault = input.defaultAnswer?.trim();
  const defaultAnswer = defaults.length > 0 ? options.filter(option => defaults.includes(option.id)).map(option => option.label).join("；")
    : explicitDefault === undefined || explicitDefault === "" ? DEFAULT_QUESTION_ANSWER : explicitDefault;
  return { question: prompt,options,multiSelect,allowCustom: input.allowCustom ?? true,
    defaultOptionIds: defaults,defaultAnswer,kind: input.kind ?? ("QUESTION" as const) };
}
export function normalizeUserQuestion(input: EnqueueUserQuestion, now: string): UserQuestionRecord {
  if (!input.questionId || input.questionId.length > 512 || !input.scope.id || !input.ownerId) throw new DomainError("question_invalid", "The question identity is invalid.");
  return { ...input,...normalizeUserQuestionPrompt(input),version: 1,status: "QUEUED",delivery: "PENDING",createdAt: now };
}

export class UserQuestionService {
  readonly #waiters = new Map<string, Set<{ resolve: (answer: UserQuestionAnswer) => void; reject: (error: Error) => void }>>();
  readonly #listeners = new Set<(scope: UserQuestionScope) => void>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  constructor(private readonly dependencies: { store: UserQuestionStore; clock: Clock; onAnswered?: (question: UserQuestionRecord) => Promise<void> }) {}

  async enqueue(input: EnqueueUserQuestion): Promise<UserQuestionDto> {
    if (this.#closed) throw new DomainError("question_canceled", "The question service is closed.");
    const now = this.dependencies.clock.now().toISOString();
    const saved = await this.dependencies.store.enqueue(normalizeUserQuestion(input,now),now);
    this.#notify(input.scope); return questionDto(saved);
  }
  async list(scope: UserQuestionScope): Promise<UserQuestionDto[]> { return (await this.dependencies.store.list(scope)).map(questionDto); }
  async recoveryRecords(scope: UserQuestionScope): Promise<UserQuestionRecord[]> { return this.dependencies.store.list(scope); }
  async answer(scope: UserQuestionScope, questionId: string, input: AnswerUserQuestionInput): Promise<UserQuestionDto> {
    const question = await this.dependencies.store.get(questionId);
    if (question?.scope.kind !== scope.kind || question.scope.id !== scope.id) throw new DomainError("question_not_found", "The question was not found.");
    if (question.status !== "ACTIVE" || question.delivery !== "PENDING" || question.version !== input.version) throw new DomainError("question_stale", "The question is no longer awaiting this answer.");
    const selected = input.useDefault === true ? question.defaultOptionIds : input.selectedOptionIds ?? [];
    const custom = input.text?.trim();
    const choices = question.options.filter(option => selected.includes(option.id)).map(option => option.label).join("；");
    const text = input.useDefault === true ? question.defaultAnswer : custom !== undefined && custom !== ""
      ? choices === "" ? custom : `选择：${choices}\n补充：${custom}`
      : choices;
    if (!text || text.length > 8_000 || (!question.allowCustom && Boolean(input.text?.trim()))
      || (!question.multiSelect && selected.length > 1) || new Set(selected).size !== selected.length
      || selected.some(id => !question.options.some(option => option.id === id))) throw new DomainError("question_answer_invalid", "The answer is invalid.");
    return questionDto(await this.#resolve(question,{ text,selectedOptionIds: selected,source: input.useDefault === true ? "USER_DEFAULT" : "USER",answeredAt: this.dependencies.clock.now().toISOString() }));
  }
  async #resolve(question: UserQuestionRecord, answer: UserQuestionAnswer): Promise<UserQuestionRecord> {
    const saved = await this.dependencies.store.answer(question.questionId,question.version,answer,this.dependencies.clock.now().toISOString());
    if (saved === null) throw new DomainError("question_stale", "The question was already resolved.");
    for (const waiter of this.#waiters.get(question.questionId) ?? []) waiter.resolve(answer);
    this.#waiters.delete(question.questionId);this.#notify(question.scope);
    await this.dependencies.onAnswered?.(saved).catch(() => undefined);
    return saved;
  }
  async expire(): Promise<UserQuestionDto[]> {
    const expired: UserQuestionDto[] = [];
    for (const question of await this.dependencies.store.due(this.dependencies.clock.now().toISOString())) {
      try {
        expired.push(questionDto(await this.#resolve(question,{ text: question.defaultAnswer,selectedOptionIds: question.defaultOptionIds,source: "TIMEOUT_DEFAULT",answeredAt: this.dependencies.clock.now().toISOString() })));
      } catch (error) { if (!(error instanceof DomainError && error.code === "question_stale")) throw error; }
    }
    if (this.dependencies.onAnswered !== undefined) for (const question of await this.dependencies.store.pendingGoalAnswers()) {
      await this.dependencies.onAnswered(question).catch(() => undefined);
    }
    return expired;
  }
  async wait(questionId: string, signal?: AbortSignal): Promise<UserQuestionAnswer> {
    if (this.#closed || signal?.aborted) throw new DomainError("question_canceled", "The question was canceled.");
    const pending = Promise.withResolvers<UserQuestionAnswer>();
    const waiters = this.#waiters.get(questionId) ?? new Set(); waiters.add(pending);this.#waiters.set(questionId,waiters);
    const abort = () => pending.reject(new DomainError("question_canceled", "The question was canceled."));
    signal?.addEventListener("abort",abort,{ once: true });
    try {
      const current = await this.dependencies.store.get(questionId);
      if (current?.delivery === "INTERRUPTED") abort();
      else if (current?.status === "ANSWERED" && current.answer !== undefined) pending.resolve(current.answer);
      else if (current === null || !["ACTIVE","QUEUED"].includes(current.status)) abort();
      return await pending.promise;
    } finally {
      signal?.removeEventListener("abort",abort);waiters.delete(pending);
      if (waiters.size === 0) this.#waiters.delete(questionId);
    }
  }
  async ask(input: EnqueueUserQuestion, signal?: AbortSignal): Promise<UserQuestionAnswer> {
    await this.enqueue(input);return this.wait(input.questionId,signal);
  }
  async cancelOwner(ownerId: string): Promise<void> {
    for (const id of await this.dependencies.store.cancelOwner(ownerId,this.dependencies.clock.now().toISOString())) {
      for (const waiter of this.#waiters.get(id) ?? []) waiter.reject(new DomainError("question_canceled", "The question was canceled."));
      this.#waiters.delete(id);const question = await this.dependencies.store.get(id);if (question !== null) this.#notify(question.scope);
    }
  }
  async cancelQuestion(scope: UserQuestionScope, questionId: string): Promise<void> {
    if (!await this.dependencies.store.cancelQuestion(scope,questionId,this.dependencies.clock.now().toISOString())) return;
    for (const waiter of this.#waiters.get(questionId) ?? []) waiter.reject(new DomainError("question_canceled", "The question was canceled."));
    this.#waiters.delete(questionId);this.#notify(scope);
  }
  async markDelivered(questionId: string): Promise<void> { await this.dependencies.store.markDelivered(questionId); }
  async interruptOwner(ownerId: string): Promise<void> {
    for (const question of await this.dependencies.store.interruptOwner(ownerId,this.dependencies.clock.now().toISOString())) {
      for (const waiter of this.#waiters.get(question.questionId) ?? []) waiter.reject(new DomainError("question_canceled", "The question was interrupted."));
      this.#waiters.delete(question.questionId);
      this.#notify(question.scope);
    }
  }
  async interruptUnfinishedConversations(): Promise<void> { await this.dependencies.store.interruptUnfinishedConversations(); }
  subscribe(listener: (scope: UserQuestionScope) => void): () => void { this.#listeners.add(listener);return () => this.#listeners.delete(listener); }
  #notify(scope: UserQuestionScope): void { for (const listener of this.#listeners) { try { listener(scope); } catch { /* 展示观察不改变持久答案。 */ } } }
  start(): void { if (this.#timer === undefined && !this.#closed) { void this.expire().catch(() => undefined);this.#timer = setInterval(() => { void this.expire().catch(() => undefined); },1_000);this.#timer.unref(); } }
  close(): void {
    this.#closed = true;if (this.#timer !== undefined) clearInterval(this.#timer);this.#timer = undefined;
    for (const waiters of this.#waiters.values()) for (const waiter of waiters) waiter.reject(new DomainError("question_canceled", "The question service is closed."));
    this.#waiters.clear();this.#listeners.clear();
  }
}
