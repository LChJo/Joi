import type { ReactNode } from "react";
import { CaretDownIcon, CheckIcon, CircleNotchIcon, FolderIcon, WrenchIcon, XCircleIcon } from "@phosphor-icons/react";
import type { AgentConversationEntryDto } from "../shared/joi";
import type { ConversationTurnStatus } from "../shared/conversations";
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
function ToolGroup({ entries,status }: { entries: AgentConversationEntryDto[];status: ConversationTurnStatus }) {
  const tools: ToolActivity[] = [];
  for (const entry of entries) {
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
  if (latest === undefined) return null;
  const latestState = toolState(latest,status);
  return <details className="chat-tool-group"><summary data-tool-state={latestState}><ToolStateIcon state={latestState} /><span className="chat-tool-summary-main"><strong>{latest.name}</strong><ToolParameters parameters={latest.parameters} /></span><span className="chat-tool-state">{t(stateLabels[latestState])}</span><small>{t("chat.toolCount",{ count: tools.length })}</small><CaretDownIcon className="chat-tool-chevron" /></summary>
    <ol>{tools.map(tool => { const state = toolState(tool,status);return <li data-tool-state={state} key={tool.id}><ToolStateIcon state={state} /><div className="chat-tool-details"><div><strong>{tool.name}</strong><span className="chat-tool-state">{t(stateLabels[state])}</span></div><ToolParameters parameters={tool.parameters} /></div></li>; })}</ol>
  </details>;
}

export function ConversationOutput({ entries,status }: { entries: AgentConversationEntryDto[];status: ConversationTurnStatus }) {
  const output: ReactNode[] = [];
  let tools: AgentConversationEntryDto[] = [];
  const flush = () => { if (tools.length > 0) { output.push(<ToolGroup entries={tools} key={tools[0]?.entryId} status={status} />);tools = []; } };
  for (const entry of entries) {
    if (entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT") { tools.push(entry);continue; }
    flush();
    output.push(entry.kind === "MARKDOWN" ? <div className="markdown-body" key={entry.entryId}><SafeMarkdown>{entry.text ?? ""}</SafeMarkdown></div>
      : entry.kind === "ARTIFACT" ? <div className="chat-artifact" key={entry.entryId}><FolderIcon />{entry.artifact?.name}</div> : <p key={entry.entryId}>{entry.text}</p>);
  }
  flush();
  return <>{output}</>;
}
