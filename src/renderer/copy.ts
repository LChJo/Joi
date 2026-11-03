import { t } from "./i18n";
import type { AgentDto, LifeState } from "./types";
import type { ThinkingEffort } from "../shared/joi";

export function thinkingEffortLabel(value: ThinkingEffort): string {
  const labels = { off: t("evolution.off"), low: t("evolution.low"), medium: t("evolution.medium"), high: t("evolution.high"), xhigh: t("catalog.veryHigh"), max: t("catalog.maximum") };
  return labels[value];
}

export const LIFE_STATE_LABEL: Record<LifeState, string> = {
  get BUDGET_PAUSED() { return t("status.todaySLimitReached"); },
  get DEGRADED() { return t("status.needsALook"); },
  get PAUSED() { return t("status.paused"); },
  get QUEUED() { return t("status.readyToAct"); },
  get RUNNING() { return t("settings.takingAction"); },
  get SLEEPING() { return t("status.quiet"); },
  get STOPPED() { return t("status.stopped"); },
  get WAITING_USER() { return t("settings.waitingForYourDecision"); },
};

const AGENT_STATUS_LABEL: Record<AgentDto["status"], string> = {
  get ACTIVE() { return t("status.ready"); },
  get COLLABORATOR_ONLY() { return t("status.collaborationOnly"); },
  get DISABLED() { return t("status.disabled"); },
  get DRAFT() { return t("status.notChecked"); },
  get ERROR() { return t("status.connectionIssue"); },
  get RECONFIRM_REQUIRED() { return t("status.needsConfirmation"); },
  get TOKEN_REQUIRED() { return t("status.credentialsNeedUpdating"); },
};

const STATUS_LABEL: Record<string, string> = {
  get ACTIVE() { return t("status.ready"); },
  get CANCELED() { return t("status.canceled"); },
  get CLAIMED() { return t("status.processing"); },
  get COMPLETED() { return t("status.completed"); },
  get CONSUMED() { return t("status.read"); },
  get DEAD_LETTER() { return t("status.actionNeeded"); },
  get DEFERRED() { return t("status.deferred"); },
  get DISABLED() { return t("status.disabled"); },
  get DRAFT() { return t("status.notChecked"); },
  get ERROR() { return t("status.somethingWentWrong"); },
  get FAILED() { return t("status.failed"); },
  get FAILED_PROTOCOL() { return t("status.resultNeedsConfirmation"); },
  get FIRED() { return t("status.notified"); },
  get FORGOTTEN() { return t("status.forgotten"); },
  get OPEN() { return t("status.notStarted"); },
  get PAUSED() { return t("status.paused"); },
  get PENDING() { return t("status.waiting"); },
  get RECONFIRM_REQUIRED() { return t("status.needsConfirmation"); },
  get RUNNING() { return t("status.inProgress"); },
  get SCHEDULED() { return t("status.scheduled"); },
  get SENT_NO_ACCEPT() { return t("status.sentAwaitingResponse"); },
  get SUPERSEDED() { return t("status.updated"); },
  get TOKEN_REQUIRED() { return t("status.credentialsNeedUpdating"); },
  get UNKNOWN() { return t("status.unconfirmed"); },
  get WAITING() { return t("status.waiting"); },
  get WAITING_AUTH() { return t("status.awaitingAuthorization"); },
  get WAITING_INPUT() { return t("status.awaitingYourInput"); },
  get WAITING_RETRY() { return t("status.retryLater"); },
};

export function agentStatusLabel(status: AgentDto["status"]): string {
  return AGENT_STATUS_LABEL[status];
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? t("status.statusRecorded");
}

export function activityTitle(kind: "DELEGATION" | "FLOW" | "TURN" | "WAKE"): string {
  if (kind === "DELEGATION") return t("status.partnerCollaboration");
  if (kind === "TURN") return t("status.conversation");
  if (kind === "WAKE") return t("status.action");
  return t("automation.activity");
}

export function eventStatusLabel(status: string): string {
  return statusLabel(status);
}

export function listenerStatusLabel(listener: Record<string, unknown> | undefined): string {
  if (listener === undefined) return t("settings.localAccessOnly");
  if (listener.status === "listening") return t("settings.availableToTrustedDevices");
  if (listener.status === "error") return t("settings.sharingIsTemporarilyUnavailable");
  return t("status.unconfirmed");
}
