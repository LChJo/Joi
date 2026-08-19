import { DomainError } from "../../domain/errors.js";
import { classifySourceFailure, pinModelSourceForTurn, type SourceFailureKind } from "../../domain/model-sources/model-source.js";
import type { ModelSourceRecord, ModelSourceRepository } from "../ports/model-source-ports.js";

type SourcePin = ReturnType<typeof pinModelSourceForTurn>;

export class ReasoningSourceSelector {
  constructor(private readonly repository: Pick<ModelSourceRepository, "list">) {}

  async selectInitial(turnId: string): Promise<SourcePin> {
    const source = (await this.#readySources())[0];
    if (source === undefined) throw new DomainError("model_source_not_ready", "No model source is ready.");
    return pinModelSourceForTurn(source.source, turnId);
  }

  async selectById(sourceId: string, turnId: string): Promise<SourcePin> {
    const record = (await this.#readySources()).find((candidate) => candidate.source.sourceId === sourceId);
    if (record === undefined) {
      throw new DomainError("partner_model_source_not_ready", "The partner model source is not ready.");
    }
    return pinModelSourceForTurn(record.source, turnId);
  }

  async selectFallback(input: {
    currentSourceId: string;
    failure: SourceFailureKind;
    formalOutputStarted: boolean;
    sideEffectStarted: boolean;
    turnId: string;
  }): Promise<SourcePin | null> {
    if (input.formalOutputStarted || input.sideEffectStarted || !classifySourceFailure(input.failure).fallbackAllowed) return null;
    const sources = await this.#readySources();
    const currentIndex = sources.findIndex((record) => record.source.sourceId === input.currentSourceId);
    const fallback = currentIndex < 0 ? undefined : sources[currentIndex + 1];
    return fallback === undefined ? null : pinModelSourceForTurn(fallback.source, input.turnId);
  }

  async #readySources(): Promise<ModelSourceRecord[]> {
    return (await this.repository.list())
      .filter((record) => record.source.status === "READY")
      .sort((left, right) => left.order - right.order);
  }
}
