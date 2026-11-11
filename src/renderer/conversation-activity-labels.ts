import type { ConversationContextDto } from "../shared/conversations";
import { t } from "./i18n";

export function contextStateLabel(context: ConversationContextDto): string {
  const state = context.state;
  return state === "COMPACTING" ? t("chat.contextCompacting") : state === "COMPRESSED" ? t("chat.contextCompressed") : state === "BACKOFF" ? t("chat.contextBackoff")
    : state === "TRIMMED" ? t("chat.contextTrimmed") : state === "CAPACITY" ? t("chat.contextCapacity") : t("chat.contextReady");
}
