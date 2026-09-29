import { PiEvolutionModel } from "../../src/main/infrastructure/pi/pi-evolution-model";
import { DomainError } from "../../src/main/domain/errors";

describe("Pi evolution adapter", () => {
  it("pins only immutable source identifiers and never executes returned tools", async () => {
    const pin = { modelId: "m", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr" };
    const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: "toolCall", name: "finish", arguments: { decision: "wait", evidenceIds: ["record-11"] } }] });
    const resolve = vi.fn().mockResolvedValue({ model: { baseUrl: "https://example.test" }, models: { completeSimple }, thinkingLevel: "off" });
    const selectInitial = vi.fn().mockResolvedValue({ ...pin, turnId: "ephemeral" });
    const model = new PiEvolutionModel({ resolver: { resolve }, sources: { selectInitial } });
    expect(await model.pin()).toEqual(pin);
    expect(selectInitial).toHaveBeenCalledWith("evolution", { requireToolProof: true });
    expect(await model.call({ pin, systemPrompt: "simulation", prompt: "fixture", mode: "simulation", idempotencyId: "call-1" })).toEqual({ action: "finish", decision: "wait", evidenceIds: ["record-11"] });
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 2048 });
    completeSimple.mockResolvedValue({ content: [] });
    // A typed code, so the service can route this to the model-quality path instead of the
    // infrastructure park-and-retry one, and the diagnostic can name the failure class.
    const error = await model.call({ pin, systemPrompt: "", prompt: "", mode: "proposal", idempotencyId: "call-2" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("evolution_response_invalid");
  });
});
