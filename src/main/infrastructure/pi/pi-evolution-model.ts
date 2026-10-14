import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { EvolutionModelCallError, type EvolutionModel, type EvolutionSourcePin } from "../../application/ports/evolution.js";
import type { EvolutionModelFailure } from "../../../shared/evolution.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import { trackPiModels } from "./pi-usage.js";
import { normalizePiUsage } from "../usage/sdk-usage.js";

function safeStopReason(value: unknown): EvolutionModelFailure["stopReason"] {
  switch (value) {
    case "pending": case "stop": case "length": case "toolUse": case "error": case "aborted": case "deferred": return value;
    default: return undefined;
  }
}

export class PiEvolutionModel implements EvolutionModel {
  constructor(private readonly dependencies: { resolver: PiConfiguredModelResolver; sources: Pick<ReasoningSourceSelector, "selectInitial">; usage?: UsageRecorder }) {}
  async pin(): Promise<EvolutionSourcePin> {
    // Evaluation needs strict single-tool-call discipline, which is a stronger requirement than an
    // orchestration turn's; prefer sources that have proven it, falling back rather than failing.
    const { modelId, modelRevisionId, sourceId, sourceRevisionId } = await this.dependencies.sources.selectInitial("evolution", { requireToolProof: true });
    return { modelId, modelRevisionId, sourceId, sourceRevisionId };
  }
  async call(input: Parameters<EvolutionModel["call"]>[0] & { workbenchId?: string }): Promise<unknown> {
    const { model, models, thinkingLevel } = await this.dependencies.resolver.resolve(input.pin);
    const signal = input.signal === undefined ? AbortSignal.timeout(60_000) : AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]);
    const tools = input.mode === "proposal" ? [{
      name: "propose_strategy", description: "Propose exactly one module change with supporting development scenario IDs.",
      parameters: Type.Object({ strategy: Type.Object({ context: Type.Union([Type.Literal("baseline"), Type.Literal("requirements_first"), Type.Literal("open_questions_first")]), completion: Type.Union([Type.Literal("baseline"), Type.Literal("evidence_matrix"), Type.Literal("contradiction_check")]) }), fixes: Type.Array(Type.String(), { maxItems: 10 }), risks: Type.Array(Type.String(), { maxItems: 10 }) }),
    }] : [{ name: "read_evidence", description: "Read one synthetic evidence record by ID.", parameters: Type.Object({ evidenceId: Type.String() }) },
      { name: "finish", description: "Submit the completion decision and evidence IDs read.", parameters: Type.Object({ decision: Type.Union([Type.Literal("complete"), Type.Literal("continue"), Type.Literal("wait")]), evidenceIds: Type.Array(Type.String(), { maxItems: 10 }) }) }];
    const instruction = "Return exactly one tool call per response. Do not answer in plain text. After read_evidence, stop and wait for its observation before requesting another record or calling finish.";
    let response: AssistantMessage;
    try {
      response = await trackPiModels(models, this.dependencies.usage, () => ({ engine: "pi", purpose: "evolution", sourceId: input.pin.sourceId, modelId: input.pin.modelId, ...(input.workbenchId === undefined ? {} : { workbenchId: input.workbenchId }) })).completeSimple(model, { systemPrompt: `${input.systemPrompt}\n${instruction}`,
      messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }], tools,
      }, { maxTokens: 2048, signal, headers: { "Idempotency-Key": input.idempotencyId }, ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
        onPayload: (payload: unknown) => {
          if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
          // Auto selection preserves thinking compatibility; the prompt requires one call and
          // the wire constraint prevents the provider from batching independent evidence reads.
          if (model.api === "anthropic-messages") return { ...payload, tool_choice: { type: "auto", disable_parallel_tool_use: true } };
          if (model.api === "openai-responses" || model.api === "openai-completions") return { ...payload, parallel_tool_calls: false };
          return;
        },
      });
    } catch {
      throw new EvolutionModelCallError({ kind: input.signal?.aborted === true ? "aborted" : signal.aborted ? "timeout" : "provider_error", toolCallCount: 0 }, null);
    }
    const usage = normalizePiUsage(response.usage);
    const tokens = usage === null ? null : usage.input + usage.output;
    const calls = response.content.filter((block) => block.type === "toolCall");
    const call = calls[0];
    const kind: EvolutionModelFailure["kind"] | null = input.signal?.aborted === true ? "aborted"
      : signal.aborted ? "timeout" : response.stopReason === "error" || response.stopReason === "deferred" || response.stopReason === "pending" ? "provider_error"
        : response.stopReason === "aborted" ? "aborted" : response.stopReason === "length" ? "response_truncated"
          : calls.length === 0 ? "no_tool_call" : calls.length > 1 ? "multiple_tool_calls"
            : call === undefined || !tools.some((tool) => tool.name === call.name) ? "unsupported_tool" : null;
    const stopReason = safeStopReason(response.stopReason);
    if (kind !== null) throw new EvolutionModelCallError({ kind, toolCallCount: calls.length,
      ...(stopReason === undefined ? {} : { stopReason }) }, tokens);
    if (call === undefined) throw new EvolutionModelCallError({ kind: "no_tool_call", toolCallCount: 0 }, tokens);
    return { value: input.mode === "proposal" ? call.arguments : { ...call.arguments, action: call.name },
      tokens };
  }
}
