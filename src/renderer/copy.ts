import type { AgentDto, LifeState } from "./types";

export const LIFE_STATE_LABEL: Record<LifeState, string> = {
  BUDGET_PAUSED: "今天的次数用完了",
  DEGRADED: "需要看看",
  PAUSED: "已暂停",
  QUEUED: "准备行动",
  RUNNING: "正在行动",
  SLEEPING: "安静中",
  STOPPED: "已停止",
  WAITING_USER: "等你决定",
};

const AGENT_STATUS_LABEL: Record<AgentDto["status"], string> = {
  ACTIVE: "可用",
  COLLABORATOR_ONLY: "仅协作",
  DISABLED: "已停用",
  DRAFT: "待检查",
  ERROR: "连接异常",
  RECONFIRM_REQUIRED: "需要重新确认",
  TOKEN_REQUIRED: "需要更新密钥",
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "可用",
  CANCELED: "已取消",
  CLAIMED: "处理中",
  COMPLETED: "已完成",
  CONSUMED: "已读取",
  DEAD_LETTER: "需要处理",
  DEFERRED: "稍后处理",
  DISABLED: "已停用",
  DRAFT: "待检查",
  ERROR: "出问题了",
  FAILED: "没成功",
  FAILED_PROTOCOL: "结果待确认",
  FIRED: "已提醒",
  FORGOTTEN: "已遗忘",
  OPEN: "待开始",
  PAUSED: "已暂停",
  PENDING: "等待中",
  RECONFIRM_REQUIRED: "需要重新确认",
  RUNNING: "进行中",
  SCHEDULED: "已安排",
  SENT_NO_ACCEPT: "已发出，等回复",
  SUPERSEDED: "已更新",
  TOKEN_REQUIRED: "需要更新密钥",
  UNKNOWN: "待确认",
  WAITING: "等待中",
  WAITING_AUTH: "等授权",
  WAITING_INPUT: "等你补充",
  WAITING_RETRY: "稍后重试",
};

export function agentStatusLabel(status: AgentDto["status"]): string {
  return AGENT_STATUS_LABEL[status];
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? "状态已记录";
}

export function activityTitle(kind: "DELEGATION" | "FLOW" | "TURN" | "WAKE"): string {
  if (kind === "DELEGATION") return "搭档协作";
  if (kind === "TURN") return "一次对话";
  if (kind === "WAKE") return "一次行动";
  return "运行记录";
}

export function eventStatusLabel(status: string): string {
  return statusLabel(status);
}

export function listenerStatusLabel(listener: Record<string, unknown> | undefined): string {
  if (listener === undefined) return "仅限本机";
  if (listener.status === "listening") return "已对可信设备开放";
  if (listener.status === "error") return "暂时无法开放";
  return "待确认";
}
