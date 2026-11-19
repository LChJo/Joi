import { Theme, type ExtensionUIContext, type ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { UserQuestionService } from "../../application/joi/user-question-service.js";
import type { EnqueueUserQuestion } from "../../application/ports/user-questions.js";
import type { UserQuestionAnswer, UserQuestionPrompt } from "../../../shared/user-questions.js";

export type PiUserQuestions = Pick<UserQuestionService, "ask" | "cancelQuestion" | "cancelOwner" | "interruptOwner" | "markDelivered">;
type QuestionOwner = Pick<EnqueueUserQuestion, "ownerId" | "scope" | "sourceName">;

export function isPiQuestionShutdown(signal?: AbortSignal): boolean {
  const reason: unknown = signal?.reason;
  return signal?.aborted === true && reason !== null && typeof reason === "object" && "code" in reason && reason.code === "conversation_shutdown";
}

/** Cancellation must also revoke the durable card, not just detach its in-memory waiter. */
export async function askPiUserQuestion(service: PiUserQuestions, input: EnqueueUserQuestion, signal?: AbortSignal): Promise<UserQuestionAnswer> {
  signal?.throwIfAborted();
  const cancel = () => { if (!isPiQuestionShutdown(signal)) void service.cancelQuestion(input.scope, input.questionId).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const answer = await service.ask(input, signal);
    signal?.throwIfAborted();
    return answer;
  } catch (error) {
    // An abort can race enqueue: cancel again after ask settles so the newly saved card is revoked.
    if (signal?.aborted === true && !isPiQuestionShutdown(signal)) await service.cancelQuestion(input.scope, input.questionId);
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); }
}

// Public Theme constructor; all terminal colors are inert. No deep SDK imports or global theme state.
const rpcTheme = new Theme({
  accent: "", border: "", borderAccent: "", borderMuted: "", success: "", error: "", warning: "", muted: "", dim: "", text: "", thinkingText: "",
  userMessageText: "", customMessageText: "", customMessageLabel: "", toolTitle: "", toolOutput: "",
  mdHeading: "", mdLink: "", mdLinkUrl: "", mdCode: "", mdCodeBlock: "", mdCodeBlockBorder: "", mdQuote: "", mdQuoteBorder: "", mdHr: "", mdListBullet: "",
  toolDiffAdded: "", toolDiffRemoved: "", toolDiffContext: "", syntaxComment: "", syntaxKeyword: "", syntaxFunction: "", syntaxVariable: "", syntaxString: "",
  syntaxNumber: "", syntaxType: "", syntaxOperator: "", syntaxPunctuation: "", thinkingOff: "", thinkingMinimal: "", thinkingLow: "", thinkingMedium: "",
  thinkingHigh: "", thinkingXhigh: "", bashMode: "",
}, { selectedBg: "", userMessageBg: "", customMessageBg: "", toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "" }, "truecolor");
const noop = () => undefined;

/** Official basic dialogs use the durable queue; terminal-only affordances remain unavailable in RPC. */
export function createPiUserQuestionUI(service: PiUserQuestions, owner: QuestionOwner, lifecycle: { signal?: AbortSignal; onCancel?: () => void; onAnswer?: (questionId: string) => void } = {}): ExtensionUIContext {
  let sequence = 0;
  const ask = async (prompt: UserQuestionPrompt, opts?: ExtensionUIDialogOptions): Promise<UserQuestionAnswer | undefined> => {
    // An explicit extension deadline starts at invocation, independently of the queue's ACTIVE-only
    // 30-minute deadline. It dismisses this dialog only; run owners control lifecycle cancellation.
    const timeout = new AbortController();
    const timer = opts?.timeout === undefined ? undefined : setTimeout(() => timeout.abort(), Math.max(0, opts.timeout));
    const signals = [lifecycle.signal, opts?.signal, timer === undefined ? undefined : timeout.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
    try {
      const questionId = `pi-ui-question:${owner.ownerId}:${String(++sequence)}`;
      const answer = await askPiUserQuestion(service, { ...owner, ...prompt, questionId }, signal);
      // Returning a dialog value is not proof that the extension/tool consumed it. The run owner
      // acknowledges these ids only after its canonical work result is safely recorded.
      lifecycle.onAnswer?.(questionId);
      return answer;
    } catch (error) {
      if (timeout.signal.aborted && lifecycle.signal?.aborted !== true && opts?.signal?.aborted !== true) return undefined;
      lifecycle.onCancel?.();
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  return {
    select: async (title, labels, opts) => {
      const options = labels.map((label, index) => ({ id: `option-${String(index + 1)}`, label }));
      const answer = await ask({ question: title, options, allowCustom: false }, opts);
      return options.find(option => answer?.selectedOptionIds.includes(option.id))?.label;
    },
    input: async (title, placeholder, opts) => (await ask({ question: [title, placeholder].filter(Boolean).join("\n\n") }, opts))?.text,
    editor: async (title, prefill) => (await ask({ question: [title, prefill].filter(Boolean).join("\n\n"), ...(prefill?.trim() ? { defaultAnswer: prefill } : {}) }))?.text,
    confirm: async (title, message, opts) => {
      const answer = await ask({ question: [title, message].filter(Boolean).join("\n\n"), kind: "CONFIRM", allowCustom: false,
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No", recommended: true }], defaultOptionIds: ["no"], defaultAnswer: "No" }, opts);
      return answer?.source === "USER" && answer.selectedOptionIds.length === 1 && answer.selectedOptionIds[0] === "yes";
    },
    notify: noop, onTerminalInput: () => noop, setStatus: noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop, setWidget: noop, setFooter: noop, setHeader: noop, setTitle: noop,
    // The SDK's generic signature omits RPC's documented unsupported return value.
    custom: <T>() => Promise.resolve(undefined as T),
    pasteToEditor: noop, setEditorText: noop, getEditorText: () => "", addAutocompleteProvider: noop, setEditorComponent: noop,
    getEditorComponent: () => undefined, theme: rpcTheme, getAllThemes: () => [], getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is unavailable in RPC mode." }), getToolsExpanded: () => false, setToolsExpanded: noop,
  };
}
