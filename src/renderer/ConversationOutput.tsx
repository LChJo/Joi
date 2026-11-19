import type { ReactNode } from "react";
import { BrainIcon, CaretDownIcon, CheckIcon, CircleNotchIcon, FolderIcon, WrenchIcon, XCircleIcon } from "@phosphor-icons/react";
import type { AgentConversationEntryDto } from "../shared/joi";
import type { ConversationContextDto,ConversationDto,ConversationEntryDto,ConversationThinkingDto,ConversationTurnStatus } from "../shared/conversations";
import { ConversationContext } from "./ConversationContext";
import { contextStateLabel } from "./conversation-activity-labels";
import { SafeMarkdown } from "./SafeMarkdown";
import { t } from "./i18n";
import { UserQuestionCard } from "./UserQuestionCard";
import type { UserQuestionDto, AnswerUserQuestionInput } from "../shared/user-questions";

type ToolState = "started" | "completed" | "failed" | "stopped" | "interrupted" | "unknown";
type OutputStatus = ConversationTurnStatus | "IDLE";
interface ToolActivity { id: string;callId?: string;name: string;sequence: number;hasCall: boolean;completed: boolean;parameters?: string;result?: string;state?: AgentConversationEntryDto["toolState"]; }
const stateLabels = { started: "chat.toolRunning",completed: "chat.toolCompleted",failed: "chat.toolFailed",stopped: "chat.stopped",interrupted: "chat.interrupted",unknown: "chat.toolResultMissing" } as const;
function toolState(tool: ToolActivity,status: OutputStatus,activeSince: number): ToolState {
  if (tool.state === "completed" || tool.state === "failed") return tool.state;
  if (tool.sequence < activeSince) return "unknown";
  if (status === "RUNNING" || status === "QUEUED") return "started";
  return status === "STOPPED" ? "stopped" : status === "INTERRUPTED" ? "interrupted" : "unknown";
}
function ToolStateIcon({ state }: { state: ToolState }) {
  return state === "started" ? <CircleNotchIcon aria-hidden="true" className="chat-tool-running" weight="bold" /> : state === "completed" ? <CheckIcon /> : state === "failed" ? <XCircleIcon /> : <WrenchIcon />;
}
function ToolParameters({ parameters }: { parameters: string | undefined }) {
  return parameters === undefined ? <span className="chat-tool-missing">{t("chat.toolParametersMissing")}</span> : <code title={parameters}>{parameters}</code>;
}
interface OutputProps {
  entries: ConversationEntryDto[];
  status: OutputStatus;
  context?: ConversationContextDto;
  children?: ConversationDto["children"];
  onCancel?: (childId: string) => void;
  renderEntry?: (entry: AgentConversationEntryDto) => ReactNode;
  renderToolDetails?: (result: string | undefined, revealableCallId: string | undefined) => ReactNode;
  questions?: UserQuestionDto[];
  onAnswerQuestion?: (id: string,input: AnswerUserQuestionInput) => Promise<unknown>;
  onResumeQuestion?: (id: string) => Promise<unknown>;
}
function thinkingLabel(thinking: ConversationThinkingDto): string {
  return t(thinking.state === "STARTED" ? "chat.thinkingStarted" : thinking.state === "COMPLETED" ? "chat.thinkingCompleted" : "chat.thinkingInterrupted");
}
function thinkingDuration(thinking: ConversationThinkingDto): string {
  return thinking.durationMs === undefined ? "" : t("chat.thinkingDuration",{ seconds: Math.round(thinking.durationMs / 10) / 100 });
}
function ToolGroup({ entries,status,context: fallbackContext,children = [],onCancel,renderToolDetails,activeSince }: OutputProps & { activeSince: number }) {
  const activities = entries.flatMap(entry => entry.kind === "ACTIVITY" ? [entry.activity] : []);
  const context = activities.findLast(activity => activity.type === "CONTEXT")?.context ?? fallbackContext;
  const thought = activities.findLast(activity => activity.type === "THINKING")?.thinking;
  const summaryChars = Array.from(thought?.summary ?? ""),summaryTruncated = summaryChars.length > 1200 || thought?.summaryTruncated === true;
  const thinkingSummary = summaryChars.slice(0,1200).join("") + (summaryChars.length > 1200 ? "…" : "");
  const contextBrief = context === undefined || status === "COMPLETED" ? "" : contextStateLabel(context);
  const brief = [thought === undefined ? "" : [thinkingLabel(thought),thinkingDuration(thought)].filter(Boolean).join(" · "),contextBrief,
    children.length === 0 ? "" : t("chat.childProgress",{ total: children.length,running: children.filter(child => child.status === "RUNNING" || child.status === "QUEUED").length })].filter(Boolean).join(" · ");
  const tools: ToolActivity[] = [];
  const toolsByCallId = new Map<string, ToolActivity>();
  for (const entry of entries) {
    if (entry.kind !== "TOOL_CALL" && entry.kind !== "TOOL_RESULT") continue;
    const paired = entry.toolCallId === undefined
      ? entry.kind === "TOOL_RESULT" ? tools.findLast(tool => !tool.completed && (entry.toolName === undefined || tool.name === entry.toolName)) : undefined
      : toolsByCallId.get(entry.toolCallId);
    const summary = entry.kind === "TOOL_CALL" ? entry.text?.replace(/\s+/gu," ").trim() : undefined;
    const parameters = summary === "" ? undefined : summary;
    const state = entry.kind === "TOOL_RESULT"
      ? entry.toolState === "failed" || (entry.toolState === undefined && entry.text === "执行失败") ? "failed" : "completed"
      : entry.toolState;
    if (paired !== undefined) {
      paired.completed ||= entry.kind === "TOOL_RESULT";
      paired.hasCall ||= entry.kind === "TOOL_CALL";
      if (parameters !== undefined) paired.parameters ??= parameters;
      if (entry.kind === "TOOL_RESULT" && entry.text !== undefined) paired.result = entry.text;
      if (state !== undefined && (entry.kind === "TOOL_RESULT" || paired.state === undefined)) paired.state = state;
      continue;
    }
    const tool = { id: entry.entryId,...(entry.toolCallId === undefined ? {} : { callId: entry.toolCallId }),name: entry.toolName ?? t("chat.tool"),sequence: entry.sequence,hasCall: entry.kind === "TOOL_CALL",completed: entry.kind === "TOOL_RESULT",
      ...(entry.kind === "TOOL_RESULT" && entry.text !== undefined ? { result: entry.text } : {}),
      ...(parameters === undefined ? {} : { parameters }),...(state === undefined ? {} : { state }) };
    tools.push(tool);
    if (entry.toolCallId !== undefined) toolsByCallId.set(entry.toolCallId, tool);
  }
  const latest = tools.at(-1);
  if (latest === undefined && brief === "") return null;
  const latestState = latest === undefined ? undefined : toolState(latest,status,activeSince);
  return <details className="chat-tool-group"><summary data-tool-state={latestState}>{latest === undefined || latestState === undefined ? <BrainIcon /> : <><ToolStateIcon state={latestState} /><span className="chat-tool-summary-main"><strong>{latest.name}</strong><ToolParameters parameters={latest.parameters} /></span><span className="chat-tool-state">{t(stateLabels[latestState])}</span><small>{t("chat.toolCount",{ count: tools.length })}</small></>}{brief === "" ? null : <span className="chat-activity-brief">{brief}</span>}<CaretDownIcon className="chat-tool-chevron" /></summary>
    {tools.length === 0 ? null : <ol>{tools.map(tool => { const state = toolState(tool,status,activeSince);return <li data-tool-state={state} key={tool.id}><ToolStateIcon state={state} /><div className="chat-tool-details"><div className="chat-tool-detail-heading"><strong>{tool.name}</strong><span className="chat-tool-state">{t(stateLabels[state])}</span></div><ToolParameters parameters={tool.parameters} />{renderToolDetails?.(tool.result,tool.completed && tool.hasCall ? tool.callId : undefined)}</div></li>; })}</ol>}
    <ConversationContext conversation={{ ...(context === undefined ? {} : { context }),children }} {...(onCancel === undefined ? {} : { onCancel })} />
    {thinkingSummary === "" ? null : <div className="chat-thinking"><p>{thinkingSummary}</p>{summaryTruncated ? <small>{t("chat.thinkingSummaryTruncated")}</small> : null}</div>}
  </details>;
}

export function ConversationOutput({ entries,status,context,children,onCancel,renderEntry,renderToolDetails,questions = [],onAnswerQuestion,onResumeQuestion }: OutputProps) {
  const output: ReactNode[] = [];
  const lastThinking = entries.findLast(entry => entry.kind === "ACTIVITY" && entry.activity.type === "THINKING");
  const lastActivity = entries.findLast(entry => entry.kind === "ACTIVITY" || entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT");
  const fallback = { ...(context === undefined ? {} : { context }),...(children === undefined ? {} : { children }),...(onCancel === undefined ? {} : { onCancel }) };
  const activeSince = entries.findLast(entry => entry.role === "USER")?.sequence ?? -Infinity;
  const toolDetails = renderToolDetails === undefined ? {} : { renderToolDetails };
  let tools: ConversationEntryDto[] = [],groupKey = "first-activity";
  if (lastActivity === undefined && (context !== undefined || (children?.length ?? 0) > 0)) output.push(<ToolGroup activeSince={activeSince} entries={[]} key="first-activity" status={status} {...fallback} />);
  const flush = () => { if (tools.length > 0) { output.push(<ToolGroup activeSince={activeSince} entries={tools} key={groupKey} status={status} {...toolDetails} {...(tools.at(-1) === lastActivity ? fallback : {})} />);tools = []; } };
  const pendingQuestions = [...questions];
  const renderQuestionsBefore = (createdAt?: string) => {
    while (pendingQuestions.length > 0 && (createdAt === undefined || (pendingQuestions[0]?.createdAt ?? "") <= createdAt)) {
      const question = pendingQuestions.shift();
      if (question === undefined) break;
      flush();
      output.push(<UserQuestionCard key={`question:${question.questionId}:${String(question.version)}`} question={question} {...(onResumeQuestion === undefined || !["INTERRUPTED","FAILED","STOPPED"].includes(status) ? {} : {onResume: () => onResumeQuestion(question.questionId)})} onAnswer={input => onAnswerQuestion?.(question.questionId,input) ?? Promise.reject(new Error("question_unavailable"))} />);
      groupKey = `activity-after-question:${question.questionId}`;
    }
  };
  for (const entry of entries) {
    renderQuestionsBefore(entry.createdAt);
    if (questions.length > 0 && (entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT") && entry.toolName === "ask_user") continue;
    if (entry.kind === "ACTIVITY" && entry.activity.type === "THINKING" && entry !== lastThinking) continue;
    if (entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT" || entry.kind === "ACTIVITY") { tools.push(entry);continue; }
    flush();
    groupKey = `activity-after-${entry.entryId}`;
    output.push(renderEntry?.(entry) ?? (entry.kind === "MARKDOWN" ? <div className="markdown-body" key={entry.entryId}><SafeMarkdown>{entry.text ?? ""}</SafeMarkdown></div>
      : entry.kind === "ARTIFACT" ? <div className="chat-artifact" key={entry.entryId}><FolderIcon />{entry.artifact?.name}</div> : <p key={entry.entryId}>{entry.text}</p>));
  }
  flush();
  renderQuestionsBefore();
  return <>{output}</>;
}
