/*
 * The provider factory keeps what a route taught it in module state, so every case below uses its
 * own sourceId to stay independent of the others.
 */
import { rememberObservedContextWindow, rememberObservedMaxOutputTokens } from "../../src/main/infrastructure/pi/pi-model-budget.js";
import { codexModelLimits } from "../../src/main/infrastructure/pi/codex-source-provider.js";
import { effectiveModelLimits, type ApiKeySourceProviderInput } from "../../src/main/infrastructure/pi/source-provider-factory.js";

/** A gateway has no vendor preset, so every number here comes from the configured value or the
 *  documented fallback — which makes it the clearest place to pin the precedence order. */
function gateway(sourceId: string, overrides: { contextWindow?: number; maxOutputTokens?: number } = {}): ApiKeySourceProviderInput {
  return {
    ...overrides,
    baseUrl: "https://gateway.example.com/v1",
    displayName: "Gateway",
    kind: "generic-openai",
    modelId: "some-model",
    protocol: "openai",
    sourceId,
  };
}

describe("effectiveModelLimits", () => {
  it("falls back to the gateway defaults when nothing else states a limit", () => {
    expect(effectiveModelLimits(gateway("limits-default"), undefined))
      .toEqual({ contextWindow: 128_000, maxOutputTokens: 16_384 });
  });

  it("lets a configured limit override the fallback", () => {
    expect(effectiveModelLimits(gateway("limits-configured", { contextWindow: 200_000, maxOutputTokens: 65_536 }), undefined))
      .toEqual({ contextWindow: 200_000, maxOutputTokens: 65_536 });
  });

  it("holds the route to what the provider stated, even against a wider configured value", () => {
    // The deadlock guard. If a configured value could exceed the learned one, a route that once
    // refused an oversized request would resend that identical request forever: the learned limit
    // would never take effect, and the capacity retry would be replaying a known failure.
    rememberObservedContextWindow("limits-observed-low", "some-model", 100_000);
    rememberObservedMaxOutputTokens("limits-observed-low", "some-model", 8_192);
    expect(effectiveModelLimits(gateway("limits-observed-low", { contextWindow: 200_000, maxOutputTokens: 65_536 }), undefined))
      .toEqual({ contextWindow: 100_000, maxOutputTokens: 8_192 });
  });

  it("keeps the configured value when it is the smaller of the two", () => {
    rememberObservedContextWindow("limits-configured-smaller", "some-model", 300_000);
    expect(effectiveModelLimits(gateway("limits-configured-smaller", { contextWindow: 200_000 }), undefined).contextWindow)
      .toBe(200_000);
  });
});

describe("Codex output limits", () => {
  it("caps the configured output at the Codex model maximum and honors lower limits", () => {
    const input = { sourceId: "codex-output-limit", modelId: "gpt-6.1-sol" };
    const defaultLimit = codexModelLimits(input)?.maxOutputTokens;
    expect(defaultLimit).toBe(128_000);
    expect(codexModelLimits({ ...input, maxOutputTokens: 131_072 })?.maxOutputTokens).toBe(defaultLimit);
    expect(codexModelLimits({ ...input, maxOutputTokens: 4_096 })?.maxOutputTokens).toBe(4_096);
    rememberObservedMaxOutputTokens(input.sourceId, input.modelId, 2_048);
    expect(codexModelLimits({ ...input, maxOutputTokens: 4_096 })?.maxOutputTokens).toBe(2_048);
  });
});
