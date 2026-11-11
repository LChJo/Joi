import type { ReactNode } from "react";
import { BrainIcon, CaretDownIcon, CheckIcon, CircleNotchIcon, FolderIcon, WrenchIcon, XCircleIcon } from "@phosphor-icons/react";
import type { AgentConversationEntryDto } from "../shared/joi";
import type { ConversationContextDto,ConversationDto,ConversationEntryDto,ConversationThinkingDto,ConversationTurnStatus } from "../shared/conversations";
import { ConversationContext } from "./ConversationContext";
import { contextStateLabel } from "./conversation-activity-labels";
import { SafeMarkdown } from "./SafeMarkdown";
import { t } from "./i18n";

type ToolState = "started" | "completed" | "failed" | "stopped" | "interrupted" | "unknown";
interface ToolActivity { id: string;callId?: string;name: string;completed: boolean;parameters?: string;state?: AgentConversationEntryDto["toolState"]; }
const stateLabels = { started: "chat.toolRunning",completed: "chat.toolCompleted",failed: "chat.toolFailed",stopped: "chat.stopped",interrupted: "chat.interrupted",unknown: "chat.toolResultMissing" } as const;
function toolState(tool: ToolActivity,status: ConversationTurnStatus): ToolState {
  if (tool.state === "completed" || tool.state === "failed") return tool.state;
  if (status === "RUNNING" || status === "QUEUED") return "started";
  return status === "STOPPED" ? "stopped" : status === "INTERRUPTED" ? "interrupted" : "unknown";
}
function ToolStateIcon({ state }: { state: ToolState }) {
  return state === "started" ? <CircleNotchIcon className="chat-tool-running" /> : state === "completed" ? <CheckIcon /> : state === "failed" ? <XCircleIcon /> : <WrenchIcon />;
}
function ToolParameters({ parameters }: { parameters: string | undefined }) {
  return parameters === undefined ? <span className="chat-tool-missing">{t("chat.toolParametersMissing")}</span> : <code title={parameters}>{parameters}</code>;
}
interface OutputProps { entries: ConversationEntryDto[];status: ConversationTurnStatus;context?: ConversationContextDto;children?: ConversationDto["children"];onCancel?: (childId: string) => void; }
function thinkingLabel(thinking: ConversationThinkingDto): string {
  return t(thinking.state === "STARTED" ? "chat.thinkingStarted" : thinking.state === "COMPLETED" ? "chat.thinkingCompleted" : "chat.thinkingInterrupted");
}
function thinkingDuration(thinking: ConversationThinkingDto): string {
  return thinking.durationMs === undefined ? "" : t("chat.thinkingDuration",{ seconds: Math.round(thinking.durationMs / 10) / 100 });
}
function ToolGroup({ entries,status,context: fallbackContext,children = [],onCancel }: OutputProps) {
  const activities = entries.flatMap(entry => entry.kind === "ACTIVITY" ? [entry.activity] : []);
  const context = activities.findLast(activity => activity.type === "CONTEXT")?.context ?? fallbackContext;
  const thoughts = activities.flatMap(activity => activity.type === "THINKING" ? [activity.thinking] : []),thought = thoughts.at(-1);
  const brief = [thought === undefined ? "" : [thinkingLabel(thought),thinkingDuration(thought)].filter(Boolean).join(" · "),context === undefined ? "" : contextStateLabel(context),
    children.length === 0 ? "" : t("chat.childProgress",{ total: children.length,running: children.filter(child => child.status === "RUNNING" || child.status === "QUEUED").length })].filter(Boolean).join(" · ");
  const tools: ToolActivity[] = [];
  for (const entry of entries) {
    if (entry.kind !== "TOOL_CALL" && entry.kind !== "TOOL_RESULT") continue;
    const paired = entry.toolCallId === undefined
      ? entry.kind === "TOOL_RESULT" ? tools.findLast(tool => !tool.completed && (entry.toolName === undefined || tool.name === entry.toolName)) : undefined
      : tools.find(tool => tool.callId === entry.toolCallId);
    const summary = entry.kind === "TOOL_CALL" ? entry.text?.replace(/\s+/gu," ").trim() : undefined;
    const parameters = summary === "" ? undefined : summary;
    const state = entry.kind === "TOOL_RESULT"
      ? entry.toolState === "failed" || (entry.toolState === undefined && entry.text === "执行失败") ? "failed" : "completed"
      : entry.toolState;
    if (paired !== undefined) {
      paired.completed ||= entry.kind === "TOOL_RESULT";
      if (parameters !== undefined) paired.parameters ??= parameters;
      if (state !== undefined && (entry.kind === "TOOL_RESULT" || paired.state === undefined)) paired.state = state;
      continue;
    }
    tools.push({ id: entry.entryId,...(entry.toolCallId === undefined ? {} : { callId: entry.toolCallId }),name: entry.toolName ?? t("chat.tool"),completed: entry.kind === "TOOL_RESULT",
      ...(parameters === undefined ? {} : { parameters }),...(state === undefined ? {} : { state }) });
  }
  const latest = tools.at(-1);
  if (latest === undefined && brief === "") return null;
  const latestState = latest === undefined ? undefined : toolState(latest,status);
  return <details className="chat-tool-group"><summary data-tool-state={latestState}>{latest === undefined || latestState === undefined ? <BrainIcon /> : <><ToolStateIcon state={latestState} /><span className="chat-tool-summary-main"><strong>{latest.name}</strong><ToolParameters parameters={latest.parameters} /></span><span className="chat-tool-state">{t(stateLabels[latestState])}</span><small>{t("chat.toolCount",{ count: tools.length })}</small></>}{brief === "" ? null : <span className="chat-activity-brief">{brief}</span>}<CaretDownIcon className="chat-tool-chevron" /></summary>
    {tools.length === 0 ? null : <ol>{tools.map(tool => { const state = toolState(tool,status);return <li data-tool-state={state} key={tool.id}><ToolStateIcon state={state} /><div className="chat-tool-details"><div><strong>{tool.name}</strong><span className="chat-tool-state">{t(stateLabels[state])}</span></div><ToolParameters parameters={tool.parameters} /></div></li>; })}</ol>}
    <ConversationContext conversation={{ ...(context === undefined ? {} : { context }),children }} {...(onCancel === undefined ? {} : { onCancel })} />
    {thoughts.map(thinking => <div className="chat-thinking" key={thinking.phaseId}><span>{thinkingLabel(thinking)} {thinkingDuration(thinking)}</span>{thinking.summary === undefined ? null : <p>{thinking.summary}</p>}{thinking.summaryTruncated === true ? <small>{t("chat.thinkingSummaryTruncated")}</small> : null}</div>)}
  </details>;
}

export function ConversationOutput({ entries,status,context,children,onCancel }: OutputProps) {
  const output: ReactNode[] = [];
  const lastActivity = entries.findLast(entry => entry.kind === "ACTIVITY" || entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT");
  const fallback = { ...(context === undefined ? {} : { context }),...(children === undefined ? {} : { children }),...(onCancel === undefined ? {} : { onCancel }) };
  let tools: ConversationEntryDto[] = [],groups = 0;
  if (lastActivity === undefined && (context !== undefined || (children?.length ?? 0) > 0)) output.push(<ToolGroup entries={[]} key="first-activity" status={status} {...fallback} />);
  const flush = () => { if (tools.length > 0) { output.push(<ToolGroup entries={tools} key={groups++ === 0 ? "first-activity" : tools[0]?.entryId} status={status} {...(tools.at(-1) === lastActivity ? fallback : {})} />);tools = []; } };
  for (const entry of entries) {
    if (entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT" || entry.kind === "ACTIVITY") { tools.push(entry);continue; }
    flush();
    output.push(entry.kind === "MARKDOWN" ? <div className="markdown-body" key={entry.entryId}><SafeMarkdown>{entry.text ?? ""}</SafeMarkdown></div>
      : entry.kind === "ARTIFACT" ? <div className="chat-artifact" key={entry.entryId}><FolderIcon />{entry.artifact?.name}</div> : <p key={entry.entryId}>{entry.text}</p>);
  }
  flush();
  return <>{output}</>;
}
