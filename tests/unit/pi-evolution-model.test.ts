import { PiEvolutionModel } from "../../src/main/infrastructure/pi/pi-evolution-model";
import { DomainError } from "../../src/main/domain/errors";

describe("Pi evolution adapter", () => {
  const pin = { modelId: "m", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr" };
  const usage = { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 };
  const finish = { type: "toolCall", name: "finish", arguments: { decision: "wait", evidenceIds: ["record-11"] } };
  function adapter(response: unknown, api = "anthropic-messages") {
    const completeSimple = vi.fn().mockResolvedValue(response);
    const resolve = vi.fn().mockResolvedValue({ model: { api }, models: { completeSimple }, thinkingLevel: "xhigh" });
    return { model: new PiEvolutionModel({ resolver: { resolve }, sources: { selectInitial: vi.fn().mockResolvedValue(pin) } }), completeSimple };
  }
  const input = { pin, systemPrompt: "simulation", prompt: "fixture", mode: "simulation" as const, idempotencyId: "call-1" };
  it("offers registered three-module methods only for the versioned learning contract", async () => {
    const { model, completeSimple } = adapter({ content: [{ type: "toolCall", name: "propose_strategy", arguments: {
      strategy: { version: 2, context: [], planning: ["dependency_outline"], completion: [] }, fixes: ["case-one"], risks: [],
    } }], stopReason: "toolUse", usage });
    await model.call({ ...input, mode: "proposal", contract: "METHOD_V2" });
    const context = completeSimple.mock.calls[0]?.[1] as { tools: { parameters: { properties: { strategy: { properties: Record<string, unknown> } } } }[] };
    expect(context.tools[0]?.parameters.properties.strategy.properties).toHaveProperty("version");
    expect(context.tools[0]?.parameters.properties.strategy.properties).toHaveProperty("planning");
    expect(JSON.stringify(context.tools)).toContain("dependency_outline");
    expect(JSON.stringify(context.tools)).not.toContain("execute_code");
  });
  it.each(["anthropic-messages", "openai-responses"])("limits %s requests to sequential tools while retaining thinking and idempotency", async (api) => {
    const { model, completeSimple } = adapter({ content: [finish], stopReason: "toolUse", usage }, api);
    await model.call(input);
    const context = completeSimple.mock.calls[0]?.[1] as { systemPrompt: string };
    expect(context.systemPrompt).toContain("exactly one tool call");
    const options = completeSimple.mock.calls[0]?.[2] as { onPayload?: (payload: unknown) => unknown };
    expect(options).toMatchObject({ reasoning: "xhigh", headers: { "Idempotency-Key": "call-1" } });
    const payload = { tools: [{ name: "finish" }], thinking: { type: "adaptive" } };
    expect(options.onPayload?.(payload)).toEqual(api === "anthropic-messages"
      ? { ...payload, tool_choice: { type: "auto", disable_parallel_tool_use: true } }
      : { ...payload, parallel_tool_calls: false });
    expect(payload).not.toHaveProperty("tool_choice");
  });
  it.each([
    ["provider_error", "error", [], "evolution_model_call_failed"],
    ["aborted", "aborted", [], "evolution_model_call_aborted"],
    ["response_truncated", "length", [finish], "evolution_response_invalid"],
    ["no_tool_call", "stop", [{ type: "text", text: "private response" }], "evolution_response_invalid"],
    ["multiple_tool_calls", "toolUse", [finish, finish], "evolution_response_invalid"],
    ["unsupported_tool", "toolUse", [{ ...finish, name: "private_tool" }], "evolution_response_invalid"],
  ])("classifies %s and retains consumption without exposing provider content", async (kind, stopReason, content, code) => {
    const { model } = adapter({ content, stopReason, usage, errorMessage: "private provider body" });
    const error: unknown = await model.call(input).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code, tokens: 100, failure: { kind, stopReason, toolCallCount: content.length === 0 || kind === "no_tool_call" ? 0 : content.length } });
    expect(JSON.stringify(error)).not.toContain("private");
  });
  it("keeps missing usage unknown on a rejected response", async () => {
    const { model } = adapter({ content: [], stopReason: "stop" });
    await expect(model.call(input)).rejects.toMatchObject({ tokens: null, failure: { kind: "no_tool_call" } });
  });
  it("classifies rejected requests and caller cancellation without retaining the original error", async () => {
    const { model, completeSimple } = adapter(null);
    completeSimple.mockRejectedValue(new Error("private provider body"));
    await expect(model.call(input)).rejects.toMatchObject({ code: "evolution_model_call_failed", tokens: null });
    const controller = new AbortController();
    controller.abort();
    await expect(model.call({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: "evolution_model_call_aborted" });
  });
  it("distinguishes the adapter deadline from caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const { model } = adapter({ content: [], stopReason: "aborted", usage });
      await expect(model.call(input)).rejects.toMatchObject({ code: "evolution_model_call_failed", tokens: 100, failure: { kind: "timeout" } });
    } finally { timeout.mockRestore(); }
  });
  it("never exposes an unrecognized provider stop reason in failure facts", async () => {
    const { model } = adapter({ content: [], stopReason: "private provider body", usage });
    const error: unknown = await model.call(input).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ failure: { kind: "no_tool_call", toolCallCount: 0 } });
    expect(JSON.stringify(error)).not.toContain("private");
  });
  it("pins only immutable source identifiers and never executes returned tools", async () => {
    const pin = { modelId: "m", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr" };
    const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: "toolCall", name: "finish", arguments: { decision: "wait", evidenceIds: ["record-11"] } }], usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 } });
    const resolve = vi.fn().mockResolvedValue({ model: { baseUrl: "https://example.test" }, models: { completeSimple }, thinkingLevel: "off" });
    const selectInitial = vi.fn().mockResolvedValue({ ...pin, turnId: "ephemeral" });
    const model = new PiEvolutionModel({ resolver: { resolve }, sources: { selectInitial } });
    expect(await model.pin()).toEqual(pin);
    expect(selectInitial).toHaveBeenCalledWith("evolution", { requireToolProof: true });
    expect(await model.call({ pin, systemPrompt: "simulation", prompt: "fixture", mode: "simulation", idempotencyId: "call-1" })).toEqual({ value: { action: "finish", decision: "wait", evidenceIds: ["record-11"] }, tokens: 100 });
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
