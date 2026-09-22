import { PiEvolutionModel } from "../../src/main/infrastructure/pi/pi-evolution-model";

describe("Pi evolution adapter", () => {
  it("pins only immutable source identifiers and never executes returned tools", async () => {
    const pin = { modelId: "m", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr" };
    const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: "toolCall", name: "finish", arguments: { decision: "wait", evidenceIds: ["record-11"] } }] });
    const resolve = vi.fn().mockResolvedValue({ model: { baseUrl: "https://example.test" }, models: { completeSimple } });
    const model = new PiEvolutionModel({ resolver: { resolve }, sources: { selectInitial: vi.fn().mockResolvedValue({ ...pin, turnId: "ephemeral" }) } });
    expect(await model.pin()).toEqual(pin);
    expect(await model.call({ pin, systemPrompt: "simulation", prompt: "fixture", mode: "simulation", idempotencyId: "call-1" })).toEqual({ action: "finish", decision: "wait", evidenceIds: ["record-11"] });
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 2048 });
    completeSimple.mockResolvedValue({ content: [] });
    await expect(model.call({ pin, systemPrompt: "", prompt: "", mode: "proposal", idempotencyId: "call-2" })).rejects.toThrow("evolution_response_invalid");
  });
});
