import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import type { UsageContext, UsageRecorder } from "../../application/ports/usage.js";
import { beginUsage, normalizePiUsage, observation, safeProviderLabel, usageFailureStatus, type SafeUsageSession } from "../usage/sdk-usage.js";

function piStatus(message: AssistantMessage): "canceled" | "completed" | "failed" {
  if (message.stopReason === "aborted") return "canceled";
  if (message.stopReason === "error") return "failed";
  return "completed";
}

function piContext(model: Model<Api>, contextFactory: () => UsageContext): UsageContext {
  const context = contextFactory();
  return {
    ...context,
    modelId: context.modelId ?? model.id,
    sourceName: safeProviderLabel(context.sourceName ?? model.provider, "Pi"),
  };
}

function recordPiResult(session: SafeUsageSession, context: UsageContext, message: AssistantMessage): void {
  session.record(observation(context, normalizePiUsage(message.usage)));
  session.finish(piStatus(message));
}

/**
 * Wraps the two Pi request boundaries used by joi. Agent streams and direct/
 * compaction completions each begin exactly one usage invocation.
 */
export function trackPiModels(models: Models, recorder: UsageRecorder | undefined, contextFactory: () => UsageContext): Models {
  if (recorder === undefined) return models;
  return new Proxy(models, {
    get(target, property) {
      if (property === "completeSimple") {
        return async (model: Model<Api>, context: Parameters<Models["completeSimple"]>[1], options?: Parameters<Models["completeSimple"]>[2]) => {
          const usageContext = piContext(model, contextFactory);
          const session = beginUsage(recorder, usageContext);
          try {
            const message = await target.completeSimple(model, context, options);
            recordPiResult(session, usageContext, message);
            return message;
          } catch (error) {
            session.record(observation(usageContext, null));
            session.finish(usageFailureStatus(options?.signal));
            throw error;
          }
        };
      }
      if (property === "streamSimple") {
        return (model: Model<Api>, context: Parameters<Models["streamSimple"]>[1], options?: Parameters<Models["streamSimple"]>[2]) => {
          const usageContext = piContext(model, contextFactory);
          const session = beginUsage(recorder, usageContext);
          try {
            const stream = target.streamSimple(model, context, options);
            void stream.result().then(
              (message) => { recordPiResult(session, usageContext, message); },
              () => {
                session.record(observation(usageContext, null));
                session.finish(usageFailureStatus(options?.signal));
              },
            );
            return stream;
          } catch (error) {
            session.record(observation(usageContext, null));
            session.finish(usageFailureStatus(options?.signal));
            throw error;
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) as unknown : value;
    },
  });
}


export function trackPiStream(models: Models, recorder: UsageRecorder | undefined, contextFactory: () => UsageContext): Models["streamSimple"] {
  const tracked = trackPiModels(models, recorder, contextFactory);
  return tracked.streamSimple.bind(tracked);
}
