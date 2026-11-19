// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { UserQuestionCard, QuestionQueue } from "../../src/renderer/UserQuestionCard.js";
import { configureLocale } from "../../src/renderer/i18n.js";
import { catalogs } from "../../src/shared/i18n/generated.js";
import type { AnswerUserQuestionInput, UserQuestionDto } from "../../src/shared/user-questions.js";

// The parent owns catalog generation. Exercise the real translator with source messages
// until that integration step, without writing any generated files.
for (const locale of ["en", "zh-CN"] as const) {
  const source = JSON.parse(readFileSync(`resources/locales/${locale}/chat.json`, "utf8")) as Record<string, string | { message: string }>;
  Object.assign(catalogs[locale], Object.fromEntries(Object.entries(source).map(([key, value]) => [`chat.${key}`, typeof value === "string" ? value : value.message])));
}

function question(overrides: Partial<UserQuestionDto> = {}): UserQuestionDto {
  return {
    questionId: "question-1", version: 1, scope: { kind: "CONVERSATION", id: "chat-1" },
    ownerId: "owner-1", sourceName: "Research partner", question: "Which approach should we use?",
    kind: "QUESTION", options: [
      { id: "existing", label: "Use existing structure", description: "Keep the current layout", recommended: true },
      { id: "new", label: "Start fresh" },
    ], multiSelect: false, allowCustom: true, defaultAnswer: "Keep the current structure and continue.",
    defaultOptionIds: ["existing"], status: "ACTIVE", createdAt: "2026-11-19T10:00:00.000Z",
    activatedAt: "2026-11-19T10:00:00.000Z", expiresAt: "2026-11-19T10:30:00.000Z", delivery: "PENDING",
    ...overrides,
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const submit = () => screen.getByRole("button", { name: "提交并继续" });
const useDefault = () => screen.getByRole("button", { name: "采用推荐并继续" });
function answerForm(): HTMLFormElement {
  const form = submit().closest("form");
  if (form === null) throw new Error("Missing answer form");
  return form;
}
async function settle(action: () => void) {
  await act(() => { action(); return Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-19T10:00:00.000Z"));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("renders an inline, expanded active question with native choices, source, and default answer", () => {
  render(<UserQuestionCard question={question()} onAnswer={vi.fn()} />);
  expect(screen.getByRole("article")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: question().question })).toBeInTheDocument();
  expect(screen.getByText("来自 Research partner")).toBeInTheDocument();
  expect(screen.getByText(question().defaultAnswer)).toBeInTheDocument();
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  expect(screen.getByRole("radio", { name: /Use existing structure/ })).toHaveAccessibleDescription("Keep the current layout");
  expect(screen.getByRole("textbox", { name: "自定义回答或补充" })).toHaveAttribute("maxLength", "8000");
  expect(screen.getByRole("timer")).toHaveTextContent("30:00");
  expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "off");
  expect(submit()).toBeDisabled();
  expect(useDefault()).toBeEnabled();
});

it("submits only the chosen radio and the expected question version", async () => {
  const onAnswer = vi.fn<(input: AnswerUserQuestionInput) => Promise<unknown>>().mockResolvedValue(undefined);
  render(<UserQuestionCard question={question({ version: 4, allowCustom: false })} onAnswer={onAnswer} />);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: /Use existing structure/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Start fresh" }));
  await settle(() => { fireEvent.click(submit()); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ version: 4, selectedOptionIds: ["new"] });
  expect(screen.getByRole("radio", { name: /Use existing structure/ })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "Start fresh" })).toBeChecked();
  expect(submit()).toBeDisabled();
  expect(screen.getByText("回答已提交，正在等待状态更新。")).toBeInTheDocument();
});

it("supports multiple selections, deselection, and custom text together", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<UserQuestionCard question={question({ multiSelect: true })} onAnswer={onAnswer} />);
  const existing = screen.getByRole("checkbox", { name: /Use existing structure/ });
  const fresh = screen.getByRole("checkbox", { name: "Start fresh" });
  fireEvent.click(existing); fireEvent.click(fresh); fireEvent.click(existing); fireEvent.click(existing);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Keep both\nwith tests.  " } });
  await settle(() => { fireEvent.click(submit()); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ version: 1, selectedOptionIds: ["existing", "new"], text: "Keep both\nwith tests." });
});

it("supports a text-only question and does not submit blank text", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<UserQuestionCard question={question({ options: [], defaultOptionIds: [] })} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: " \n " } });
  expect(submit()).toBeDisabled();
  fireEvent.submit(answerForm());
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "My answer" } });
  await settle(() => { fireEvent.click(submit()); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ version: 1, text: "My answer", selectedOptionIds: [] });
});

it("adopts the server default without sending the local draft", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsubmitted draft" } });
  fireEvent.click(screen.getByRole("radio", { name: "Start fresh" }));
  await settle(() => { fireEvent.click(useDefault()); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ version: 1, useDefault: true });
});

it("uses a synchronous lock against repeated form and default submissions", async () => {
  const pending = deferred();
  const onAnswer = vi.fn().mockReturnValue(pending.promise);
  render(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Proceed" } });
  const form = answerForm();
  act(() => { fireEvent.submit(form); fireEvent.submit(form); fireEvent.click(useDefault()); });
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("textbox")).toBeDisabled();
  await settle(() => { pending.resolve(undefined); });
  fireEvent.submit(form);
  expect(onAnswer).toHaveBeenCalledTimes(1);
});

it("preserves the draft after failure, shows only safe copy, and allows retry", async () => {
  const onAnswer = vi.fn().mockRejectedValueOnce(new Error("SECRET token /private/path")).mockResolvedValue(undefined);
  render(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("radio", { name: "Start fresh" }));
  await settle(() => { fireEvent.click(submit()); });
  expect(screen.getByRole("alert")).toHaveTextContent("回答未能提交。草稿已保留，请确认问题仍在等待回答后重试。");
  expect(screen.queryByText(/SECRET|private\/path/)).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("Keep my draft");
  expect(screen.getByRole("radio", { name: "Start fresh" })).toBeChecked();
  await settle(() => { fireEvent.click(submit()); });
  expect(onAnswer).toHaveBeenCalledTimes(2);
  expect(onAnswer.mock.calls[0]).toEqual(onAnswer.mock.calls[1]);
});

it.each([
  { version: 2 }, { questionId: "question-2" }, { scope: { kind: "CONVERSATION", id: "chat-2" } },
  { scope: { kind: "GOAL", id: "chat-1" } },
] satisfies Partial<UserQuestionDto>[])("resets the draft when its identity changes: %j", (identity) => {
  const onAnswer = vi.fn();
  const view = render(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Old draft" } });
  fireEvent.click(screen.getByRole("radio", { name: "Start fresh" }));
  view.rerender(<UserQuestionCard question={question(identity)} onAnswer={onAnswer} />);
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(screen.getByRole("radio", { name: "Start fresh" })).not.toBeChecked();
  expect(submit()).toBeDisabled();
});

it("retains the draft during polling of the same question", () => {
  const onAnswer = vi.fn();
  const view = render(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Still editing" } });
  view.rerender(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  expect(screen.getByRole("textbox")).toHaveValue("Still editing");
});

it.each(["resolve", "reject"] as const)("ignores an old %s receipt after the card changes", async (result) => {
  const pending = deferred();
  const onAnswer = vi.fn().mockReturnValue(pending.promise);
  const view = render(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  fireEvent.click(useDefault());
  view.rerender(<UserQuestionCard question={question({ version: 2 })} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "New draft" } });
  await settle(() => { if (result === "resolve") pending.resolve(undefined); else pending.reject(new Error("old failure")); });
  expect(screen.getByRole("textbox")).toHaveValue("New draft");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText("回答已提交，正在等待状态更新。")).not.toBeInTheDocument();
  expect(submit()).toBeEnabled();
});

it("leaves Enter as a newline and submits with Ctrl/Cmd+Enter only outside IME", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  const textbox = screen.getByRole("textbox");
  fireEvent.change(textbox, { target: { value: "Line one\nLine two" } });
  expect(fireEvent.keyDown(textbox, { key: "Enter" })).toBe(true);
  fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true, isComposing: true });
  fireEvent.keyDown(textbox, { key: "Enter", metaKey: true, keyCode: 229 });
  fireEvent.compositionStart(textbox);
  fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
  fireEvent.compositionEnd(textbox);
  fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true, repeat: true });
  expect(onAnswer).not.toHaveBeenCalled();
  await settle(() => { fireEvent.keyDown(textbox, { key: "Enter", metaKey: true }); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ version: 1, text: "Line one\nLine two", selectedOptionIds: [] });
});

it("counts down from the absolute deadline, stays silent each second, and never answers locally", () => {
  const onAnswer = vi.fn();
  render(<UserQuestionCard question={question({ expiresAt: "2026-11-19T10:00:02.000Z" })} onAnswer={onAnswer} />);
  const liveBefore = screen.getAllByRole("status").map(node => node.textContent);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByRole("timer")).toHaveTextContent("00:01");
  expect(screen.getAllByRole("status").map(node => node.textContent)).toEqual(liveBefore);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByRole("timer")).toHaveTextContent("00:00");
  expect(useDefault()).toBeDisabled();
  expect(screen.getByText("回答时间已到，正在等待默认回答的确认。")).toBeInTheDocument();
  expect(onAnswer).not.toHaveBeenCalled();
});

it("rechecks the deadline synchronously before submitting after sleep", () => {
  const onAnswer = vi.fn();
  render(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  vi.setSystemTime(new Date("2026-11-19T11:00:00.000Z"));
  fireEvent.click(useDefault());
  expect(onAnswer).not.toHaveBeenCalled();
});

it("keeps an active card read-only until it has a valid server deadline", () => {
  const onAnswer = vi.fn();
  render(<UserQuestionCard question={question({ expiresAt: "invalid" })} onAnswer={onAnswer} />);
  expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  expect(screen.getByText("正在等待问题的截止时间，暂不可回答。")).toBeInTheDocument();
  expect(useDefault()).toBeDisabled();
  expect(screen.getByRole("textbox")).toBeDisabled();
  fireEvent.submit(answerForm());
  expect(onAnswer).not.toHaveBeenCalled();
});

it("discards late failures after the server resolves the active question", async () => {
  const pending = deferred();
  const onAnswer = vi.fn().mockReturnValue(pending.promise);
  const view = render(<UserQuestionCard question={question()} onAnswer={onAnswer} />);
  fireEvent.click(useDefault());
  view.rerender(<UserQuestionCard question={question({ status: "ANSWERED", answer: {
    text: "Server default", selectedOptionIds: [], source: "TIMEOUT_DEFAULT", answeredAt: "2026-11-19T10:30:00.000Z",
  } })} onAnswer={onAnswer} />);
  await settle(() => { pending.reject(new Error("stale")); });
  expect(screen.getByText("Server default")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("renders a confirmation without choices and can explicitly adopt its default", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<UserQuestionCard question={question({ kind: "CONFIRM", options: [], defaultOptionIds: [], allowCustom: false })} onAnswer={onAnswer} />);
  expect(screen.getByText("等待你的确认")).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(submit()).toBeDisabled();
  await settle(() => { fireEvent.click(useDefault()); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ version: 1, useDefault: true });
});

it("renders queued questions as collapsed non-answerable previews without a timer", () => {
  const onAnswer = vi.fn();
  const { container } = render(<UserQuestionCard question={question({ status: "QUEUED" })} onAnswer={onAnswer} />);
  expect(container.querySelector("details")).not.toHaveAttribute("open");
  expect(screen.getByText("排队中，轮到此问题后开始计时。")).toBeInTheDocument();
  expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "提交并继续" })).not.toBeInTheDocument();
  expect(onAnswer).not.toHaveBeenCalled();
});

it.each([
  ["USER", "你的回答"], ["USER_DEFAULT", "你采用了推荐回答"], ["TIMEOUT_DEFAULT", "超时后采用默认回答"],
] as const)("shows the recorded %s answer, selections, timestamp and delivery", (source, label) => {
  render(<UserQuestionCard question={question({ status: "ANSWERED", delivery: "DELIVERED", answer: {
    text: "Recorded answer", selectedOptionIds: ["existing"], source, answeredAt: "2026-11-19T10:01:00.000Z",
  } })} onAnswer={vi.fn()} />);
  expect(screen.getByText("Recorded answer")).toBeInTheDocument();
  expect(screen.getByText("Use existing structure")).toBeInTheDocument();
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByText("回答已交付。")).toBeInTheDocument();
  expect(screen.getByRole("article").querySelector("time")).toHaveAttribute("dateTime", "2026-11-19T10:01:00.000Z");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it.each([
  ["CANCELED", "问题已取消，无需回答。"], ["SUPERSEDED", "已由新问题替代，请回答最新问题。"],
] as const)("keeps a %s question visible and read-only", (status, text) => {
  render(<UserQuestionCard question={question({ status })} onAnswer={vi.fn()} />);
  expect(screen.getByText(question().question)).toBeInTheDocument();
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("distinguishes recorded-but-pending delivery from interrupted delivery and forbids resubmission", () => {
  const onAnswer = vi.fn();
  const answered = question({ status: "ANSWERED", answer: { text: "Retained answer", selectedOptionIds: [], source: "USER", answeredAt: "2026-11-19T10:01:00.000Z" } });
  const view = render(<UserQuestionCard question={answered} onAnswer={onAnswer} />);
  expect(screen.getByText("回答已记录，等待交付。")).toBeInTheDocument();
  view.rerender(<UserQuestionCard question={{ ...answered, delivery: "INTERRUPTED" }} onAnswer={onAnswer} />);
  expect(screen.getByText("Retained answer")).toBeInTheDocument();
  expect(screen.getByText("交付已中断。此问题已关闭，不会自动重发回答。")).toBeInTheDocument();
  view.rerender(<UserQuestionCard question={question({ delivery: "INTERRUPTED" })} onAnswer={onAnswer} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("timer")).not.toBeInTheDocument();
});

it("keeps history in input order and binds each answer to the right queue item", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<QuestionQueue questions={[
    question({ questionId: "old", status: "CANCELED", question: "Old question" }),
    question({ questionId: "current", question: "Current question" }),
    question({ questionId: "next", status: "QUEUED", question: "Next question" }),
  ]} onAnswer={onAnswer} />);
  const cards = screen.getAllByRole("article");
  expect(cards).toHaveLength(3);
  expect(cards[0]).toHaveTextContent("Old question");
  expect(cards[1]).toHaveTextContent("Current question");
  expect(cards[2]).toHaveTextContent("Next question");
  const current = cards[1];
  if (current === undefined) throw new Error("Missing current question");
  await settle(() => { fireEvent.click(within(current).getByRole("button", { name: "采用推荐并继续" })); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith("current", { version: 1, useDefault: true });
});

it("reacts to locale changes without discarding the draft", () => {
  render(<UserQuestionCard question={question()} onAnswer={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "My draft" } });
  act(() => { configureLocale({ preference: "en" }); });
  expect(screen.getByRole("button", { name: "Submit and continue" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Your answer or additional details" })).toHaveValue("My draft");
});
