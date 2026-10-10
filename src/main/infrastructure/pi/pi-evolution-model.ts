import { Type } from "@earendil-works/pi-ai";
import { DomainError } from "../../domain/errors.js";
import type { EvolutionModel, EvolutionSourcePin } from "../../application/ports/evolution.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import { trackPiModels } from "./pi-usage.js";
import { normalizePiUsage } from "../usage/sdk-usage.js";

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
    const response = await trackPiModels(models, this.dependencies.usage, () => ({ engine: "pi", purpose: "evolution", sourceId: input.pin.sourceId, modelId: input.pin.modelId, ...(input.workbenchId === undefined ? {} : { workbenchId: input.workbenchId }) })).completeSimple(model, { systemPrompt: input.systemPrompt,
      messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }], tools,
    }, { maxTokens: 2048, signal, headers: { "Idempotency-Key": input.idempotencyId }, ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }) });
    const calls = response.content.filter((block) => block.type === "toolCall");
    const call = calls[0];
    // A typed code, not a bare Error: the service's failure classification routes this to a
    // model-quality retry path instead of the infrastructure park-and-retry one.
    if (calls.length !== 1 || call === undefined || !tools.some((tool) => tool.name === call.name)) throw new DomainError("evolution_response_invalid", "The model did not answer with exactly one supported tool call.");
    const usage = normalizePiUsage(response.usage);
    return { value: input.mode === "proposal" ? call.arguments : { ...call.arguments, action: call.name },
      tokens: usage === null ? null : usage.input + usage.output };
  }
}
