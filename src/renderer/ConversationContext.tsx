import type { ConversationDto } from "../shared/conversations";
import { t,useI18n } from "./i18n";

export function ConversationContext({ conversation,onCancel }: { conversation: ConversationDto;onCancel: (childId: string) => void }) {
  useI18n();const context = conversation.context,children = conversation.children ?? [];
  if (context === undefined && children.length === 0) return null;
  const state = context?.state;
  const label = state === "COMPACTING" ? t("chat.contextCompacting") : state === "COMPRESSED" ? t("chat.contextCompressed") : state === "BACKOFF" ? t("chat.contextBackoff")
    : state === "TRIMMED" ? t("chat.contextTrimmed") : state === "CAPACITY" ? t("chat.contextCapacity") : t("chat.contextReady");
  return <div className="chat-runtime-context">
    {context === undefined ? null : <div aria-live="polite" role="status"><span>{context.kind === "NATIVE" ? t("chat.contextNative")
      : context.requestChars === undefined ? t("chat.contextEstimating") : t("chat.contextCharacters",{ used: context.requestChars,budget: context.budgetChars ?? context.requestChars })}</span><span>{label}</span>
      {context.activityAt === undefined ? null : <time dateTime={context.activityAt}>{t("chat.recentActivity")} {new Date(context.activityAt).toLocaleTimeString()}</time>}
      {context.missingHistory === true ? <small>{t("chat.legacyHistoryMissing")}</small> : null}</div>}
    {children.length === 0 ? null : <details><summary>{t("chat.childProgress",{ total: children.length,running: children.filter(child => child.status === "QUEUED" || child.status === "RUNNING").length })}</summary>
      <ul>{children.map((child,index) => <li key={child.childId}><span>{t("chat.childNumber",{ number: index + 1 })}</span><span>{child.status === "COMPLETED" ? t("chat.completed") : child.status === "RUNNING" ? t("chat.running") : child.status === "QUEUED" ? t("chat.queued") : child.status === "CANCELED" ? t("chat.stopped") : child.status === "INTERRUPTED" ? t("chat.interrupted") : t("chat.failed")}</span>
        {child.status === "QUEUED" || child.status === "RUNNING" ? <button onClick={() => onCancel(child.childId)} type="button">{t("chat.cancelChild")}</button> : null}</li>)}</ul></details>}
  </div>;
}
