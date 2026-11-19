import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { AnswerUserQuestionInput, UserQuestionDto } from "../shared/user-questions.js";
import { t, useI18n } from "./i18n.js";
import "./user-questions.css";

export interface UserQuestionCardProps {
  question: UserQuestionDto;
  onAnswer: (input: AnswerUserQuestionInput) => Promise<unknown>;
  onResume?: () => Promise<unknown>;
  compact?: boolean;
}

function questionKey(question: UserQuestionDto): string {
  return JSON.stringify([question.scope.kind, question.scope.id, question.questionId, question.version]);
}

function statusLabel(question: UserQuestionDto): string {
  if (question.delivery === "INTERRUPTED") return t("chat.questionInterrupted");
  switch (question.status) {
    case "ACTIVE": return question.kind === "CONFIRM" ? t("chat.questionConfirm") : t("chat.questionActive");
    case "QUEUED": return t("chat.questionQueued");
    case "ANSWERED": return t("chat.questionAnswered");
    case "CANCELED": return t("chat.questionCanceled");
    case "SUPERSEDED": return t("chat.questionSuperseded");
  }
}

function formatTimestamp(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date) : value;
}

function DefaultAnswer({ question, compact = false }: { question: UserQuestionDto; compact?: boolean }) {
  if (compact) return <p className="user-question-inline-default"><strong>{t("chat.questionDefaultLabel")} · </strong>{question.defaultAnswer}</p>;
  const defaults = question.options.filter(option => question.defaultOptionIds.includes(option.id));
  return <div className="user-question-default">
    <strong>{t("chat.questionDefaultLabel")}</strong>
    <p>{question.defaultAnswer}</p>
    {defaults.length > 0 ? <ul className="user-question-selected">{defaults.map(option => <li key={option.id}>{option.label}</li>)}</ul> : null}
  </div>;
}

function ActiveQuestion({ question, onAnswer, compact = false }: UserQuestionCardProps) {
  const { locale } = useI18n();
  const id = useId();
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now);
  const [submission, setSubmission] = useState<"idle" | "pending" | "submitted" | "failed">("idle");
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const composing = useRef(false);
  const deadline = Date.parse(question.expiresAt ?? "");
  const hasDeadline = Number.isFinite(deadline);
  const expired = hasDeadline && now >= deadline;
  const locked = !hasDeadline || expired || submission === "pending" || submission === "submitted";
  const selectedOptionIds = question.options.filter(option => selected.includes(option.id)).map(option => option.id);
  const answerText = question.allowCustom ? text.trim() : "";
  const hasAnswer = (selectedOptionIds.length > 0 || answerText.length > 0) && answerText.length <= 8000;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!hasDeadline) return;
    const update = () => { setNow(Date.now()); };
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [hasDeadline, deadline]);

  const send = async (useDefault: boolean) => {
    // Recheck wall time here: a sleeping renderer may not have ticked its timer yet.
    if (inFlight.current || locked || Date.now() >= deadline || (!useDefault && !hasAnswer)) return;
    inFlight.current = true;
    setSubmission("pending");
    const input: AnswerUserQuestionInput = useDefault
      ? { version: question.version, useDefault: true }
      : { version: question.version, selectedOptionIds, ...(answerText ? { text: answerText } : {}) };
    try {
      await onAnswer(input);
      // The DTO remains authoritative; do not synthesize an answer or reopen on a stale poll.
      if (mounted.current) setSubmission("submitted");
    } catch {
      if (mounted.current) { inFlight.current = false; setSubmission("failed"); }
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.defaultPrevented || event.key !== "Enter" || (!event.ctrlKey && !event.metaKey) || event.altKey || event.repeat) return;
    // Some IMEs signal their confirmation key only as keyCode 229.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    void send(false);
  };
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const remaining = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return <form className="user-question-form" onSubmit={event => { event.preventDefault(); void send(false); }} aria-busy={submission === "pending"}>
    <fieldset disabled={locked} aria-describedby={question.options.length > 0 ? `${id}-choice-hint` : undefined}>
      <legend>{question.question}</legend>
      {question.options.length > 0 ? <p className="user-question-hint" id={`${id}-choice-hint`}>{question.multiSelect ? t("chat.questionChooseMany") : t("chat.questionChooseOne")}</p> : null}
      {question.options.length > 0 ? <div className="user-question-options">
        {question.options.map((option, index) => <label className="user-question-option" key={option.id}>
          <input type={question.multiSelect ? "checkbox" : "radio"} name={`${id}-choice`} value={option.id}
            checked={selected.includes(option.id)} aria-labelledby={`${id}-option-${String(index)}`}
            aria-describedby={option.description ? `${id}-description-${String(index)}` : undefined}
            onChange={event => {
              const checked = event.target.checked;
              setSelected(previous => question.multiSelect
                ? checked ? [...previous.filter(value => value !== option.id), option.id] : previous.filter(value => value !== option.id)
                : [option.id]);
            }} />
          <span className="user-question-option-copy">
            <span className="user-question-option-heading"><span id={`${id}-option-${String(index)}`}>{option.label}</span>
              {option.recommended ? <span className="user-question-recommended">{t("chat.questionRecommended")}</span> : null}
            </span>
            {option.description ? <span className="user-question-hint" id={`${id}-description-${String(index)}`}>{option.description}</span> : null}
          </span>
        </label>)}
      </div> : null}
      {question.allowCustom ? <label className="user-question-custom">
        <span className="user-question-input-label" id={`${id}-custom-label`}>{t("chat.questionCustomAnswer")}</span>
        <textarea value={text} maxLength={8000} rows={compact ? 2 : 3} aria-labelledby={`${id}-custom-label`} aria-describedby={`${id}-keyboard`}
          placeholder={compact ? t("chat.questionCustomAnswer") : undefined} title={compact ? t("chat.questionKeyboardHint") : undefined}
          onChange={event => { setText(event.target.value); }} onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
        <span className="user-question-hint user-question-shortcut" id={`${id}-keyboard`}>{t("chat.questionKeyboardHint")}</span>
      </label> : null}
    </fieldset>
    <div className="user-question-timing">
      {hasDeadline ? <>
        <span className="user-question-countdown" role="timer" aria-live="off"
          title={compact ? t("chat.questionDeadline", { time: formatTimestamp(question.expiresAt ?? "", locale) }) : undefined}>
          {t("chat.questionCountdown", { remaining })}
        </span>
        <time dateTime={question.expiresAt}>{t("chat.questionDeadline", { time: formatTimestamp(question.expiresAt ?? "", locale) })}</time>
      </> : null}
      <p className="user-question-hint">{t("chat.questionTimeoutPolicy")}</p>
    </div>
    <DefaultAnswer question={question} compact={compact} />
    <div className="user-question-actions">
      <button className="user-question-button user-question-button-default" type="button" disabled={locked} onClick={() => { void send(true); }}>{t("chat.questionUseDefault")}</button>
      <button className="user-question-button user-question-button-submit" type="submit" disabled={locked || !hasAnswer}>{t("chat.questionSubmit")}</button>
    </div>
    <div className="user-question-notice" role="status" aria-live="polite" aria-atomic="true">
      {submission === "pending" ? t("chat.questionSubmitting") : submission === "submitted" ? t("chat.questionSubmitted") : expired ? t("chat.questionExpired") : !hasDeadline ? t("chat.questionTimingPending") : null}
    </div>
    {submission === "failed" ? <p className="user-question-error" role="alert">{t("chat.questionSubmitFailed")}</p> : null}
  </form>;
}

function RecordedAnswer({ question, compact = false }: { question: UserQuestionDto; compact?: boolean }) {
  const { locale } = useI18n();
  if (question.answer === undefined) return null;
  const answer = question.answer;
  const selected = question.options.filter(option => answer.selectedOptionIds.includes(option.id));
  return <div className="user-question-answer">
    <div className="user-question-answer-meta">
      <strong>{answer.source === "USER" ? t("chat.questionAnswerUser") : answer.source === "USER_DEFAULT" ? t("chat.questionAnswerUserDefault") : t("chat.questionAnswerTimeout")}</strong>
      <time dateTime={answer.answeredAt}>{formatTimestamp(answer.answeredAt, locale)}</time>
    </div>
    <p>{answer.text}</p>
    {!compact && selected.length > 0 ? <ul className="user-question-selected">{selected.map(option => <li key={option.id}>{option.label}</li>)}</ul> : null}
    {question.delivery !== "INTERRUPTED" ? <p className="user-question-hint">{question.delivery === "DELIVERED" ? t("chat.questionDeliveryDelivered") : t("chat.questionDeliveryPending")}</p> : null}
  </div>;
}

function QuestionHeader({ question }: { question: UserQuestionDto }) {
  return <header className="user-question-header">
    <span className="user-question-status" role="status" aria-live="polite">{statusLabel(question)}</span>
    <span className="user-question-source">{t("chat.questionSource", { name: question.sourceName })}</span>
  </header>;
}

function QuestionResolution({ question, compact = false }: { question: UserQuestionDto; compact?: boolean }) {
  return <>
    <RecordedAnswer question={question} compact={compact} />
    {question.status === "CANCELED" ? <p className="user-question-hint">{t("chat.questionCanceledHint")}</p> : null}
    {question.status === "SUPERSEDED" ? <p className="user-question-hint">{t("chat.questionSupersededHint")}</p> : null}
    {question.delivery === "INTERRUPTED" ? <p className="user-question-notice">{t("chat.questionInterruptedHint")}</p> : null}
  </>;
}

function QuestionCard({ question, onAnswer, onResume, compact = false }: UserQuestionCardProps) {
  useI18n();
  const [resuming,setResuming] = useState(false);
  const [resumeError,setResumeError] = useState(false);
  const resumeLock = useRef(false);
  const resume = async () => {
    if (resumeLock.current || onResume === undefined) return;
    resumeLock.current = true;setResuming(true);setResumeError(false);
    try { await onResume(); } catch { setResumeError(true); }
    finally { resumeLock.current = false;setResuming(false); }
  };
  const interrupted = question.delivery === "INTERRUPTED";
  const active = question.status === "ACTIVE" && !interrupted;
  const className = `user-question-card${compact ? " user-question-card-compact" : ""}${active ? " user-question-card-active" : ""}`;
  if (compact && !interrupted && question.status === "ANSWERED" && question.answer !== undefined) {
    return <article className={`${className} user-question-card-summary`} aria-label={question.question} data-status={question.status}>
      <details>
        <summary className="user-question-summary">
          <span className="user-question-status" title={question.delivery === "PENDING" ? t("chat.questionDeliveryPending") : undefined}>{statusLabel(question)}</span>
          <span className="user-question-summary-prompt">{question.question}</span>
          <span aria-hidden="true">·</span>
          <span className="user-question-summary-reply">{question.answer.text}</span>
          <CaretDownIcon aria-hidden="true" size={14} />
        </summary>
        <div className="user-question-summary-details">
          <span className="user-question-source">{t("chat.questionSource", { name: question.sourceName })}</span>
          <h3 className="user-question-title">{question.question}</h3>
          <RecordedAnswer question={question} compact />
        </div>
      </details>
    </article>;
  }
  return <article className={className} aria-label={question.question} data-status={question.status}>
    <QuestionHeader question={question} />
    {active ? <ActiveQuestion question={question} onAnswer={onAnswer} compact={compact} /> : <>
      {question.status === "QUEUED" && !interrupted ? <>
        <details className="user-question-preview"><summary>{question.question}</summary><DefaultAnswer question={question} compact={compact} /></details>
        <p className="user-question-hint">{t("chat.questionQueuedHint")}</p>
      </> : <h3 className="user-question-title">{question.question}</h3>}
      <QuestionResolution question={question} compact={compact} />
      {interrupted && question.answer === undefined ? <DefaultAnswer question={question} compact={compact} /> : null}
      {interrupted && question.status !== "CANCELED" && question.status !== "SUPERSEDED" && onResume !== undefined ? <button className="user-question-button user-question-button-submit" type="button" disabled={resuming} onClick={() => void resume()}>{resuming ? t("chat.questionSubmitting") : question.answer === undefined ? t("chat.questionResumeDefault") : t("chat.questionResumeSaved")}</button> : null}
      {resumeError ? <p className="user-question-error" role="alert">{t("chat.questionSubmitFailed")}</p> : null}
    </>}
  </article>;
}

export function UserQuestionCard(props: UserQuestionCardProps) {
  // Remount every draft-owning descendant before a new scope/id/version can receive a receipt.
  return <QuestionCard key={questionKey(props.question)} {...props} />;
}

function isPendingQuestion(question: UserQuestionDto): boolean {
  return question.status === "ACTIVE" || question.status === "QUEUED";
}

export function QuestionQueue({ questions, onAnswer }: {
  questions: readonly UserQuestionDto[];
  onAnswer: (id: string, input: AnswerUserQuestionInput) => Promise<unknown>;
}) {
  useI18n();
  const pending = questions.filter(isPendingQuestion);
  if (pending.length === 0) return null;
  return <ol className="user-question-queue" aria-label={t("chat.questionQueueLabel")}>
    {pending.map(question => <li key={questionKey(question)}><UserQuestionCard compact question={question} onAnswer={input => onAnswer(question.questionId, input)} /></li>)}
  </ol>;
}

export function GoalQuestionHistory({ questions }: { questions?: UserQuestionDto[] | undefined }) {
  useI18n();
  const history = questions?.filter(question => !isPendingQuestion(question)) ?? [];
  if (history.length === 0) return null;
  return <details className="goal-question-history">
    <summary><CaretDownIcon aria-hidden="true" size={14} />{t("chat.goalQuestionHistory")}</summary>
    <ol className="user-question-queue">
      {history.map(question => <li key={questionKey(question)}><article className="user-question-card user-question-card-compact" aria-label={question.question} data-status={question.status}>
        <QuestionHeader question={question} />
        <h3 className="user-question-title">{question.question}</h3>
        <QuestionResolution question={question} />
      </article></li>)}
    </ol>
  </details>;
}
