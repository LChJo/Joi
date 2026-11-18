import type { Models } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Individual summary attempts are numeric facts even when no completed summary is committed. */
export function withPiSummaryUsage(models: Models, manager: SessionManager): Models {
  if (!manager.getBranch().some(entry => entry.type === "custom" && entry.customType === "joi.summary_usage_mode")) manager.appendCustomEntry("joi.summary_usage_mode", { version: 1 });
  return new Proxy(models, { get(target, key) {
    if (key === "streamSimple") return (...args: Parameters<Models["streamSimple"]>) => {
      const stream = target.streamSimple(...args);
      const warming = args[2]?.sessionId === manager.getSessionId() && args[2].maxTokens === 1 && args[2].disableContinuation === true;
      if (args[2]?.sessionId === manager.getSessionId() && !warming) return stream;
      let result: ReturnType<typeof stream.result> | undefined;
      return new Proxy(stream, { get(original, property) {
        if (property === "result") return () => {
          result ??= original.result().then(message => {
            if (!warming || message.stopReason === "error" || message.stopReason === "aborted") {
              manager.appendCustomEntry(warming ? "joi.cache_warm_usage" : "joi.summary_usage", { version: 1, provider: message.provider, model: message.model, usage: message.usage,
                status: message.stopReason === "error" || !warming && message.stopReason === "length" ? "failed" : message.stopReason === "aborted" ? "canceled" : "completed" });
            }
            return message;
          });
          return result;
        };
        const value: unknown = Reflect.get(original, property, original);
        return typeof value === "function" ? value.bind(original) as unknown : value;
      } });
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) as unknown : value;
  } });
}
