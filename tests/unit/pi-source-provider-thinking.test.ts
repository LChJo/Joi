import { modelRequiresAlwaysOnThinking } from "../../src/main/infrastructure/pi/provider-presets.js";
import { createPiSourceProvider, type PiSourceProviderInput } from "../../src/main/infrastructure/pi/source-provider-factory.js";

function singleModel(input: PiSourceProviderInput) {
  const model = createPiSourceProvider(input).getModels()[0];
  if (model === undefined) throw new Error("expected exactly one model");
  return model;
}

describe("modelRequiresAlwaysOnThinking", () => {
  it.each([
    ["https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", true],
    ["https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic", true],
    ["https://coding.dashscope.aliyuncs.com/v1", true],
    ["https://coding.dashscope.aliyuncs.com/apps/anthropic", true],
  ] as const)("flags Bailian thinking-only plan endpoints (%s)", (url, expected) => {
    expect(modelRequiresAlwaysOnThinking(url)).toBe(expected);
  });

  it.each([
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", false],
    ["https://dashscope.aliyuncs.com/apps/anthropic", false],
    ["https://api.kimi.com/coding/v1", false],
    ["https://open.bigmodel.cn/api/paas/v4", false],
    ["http://127.0.0.1:11434/v1", false],
  ] as const)("leaves standard api and other providers untouched (%s)", (url, expected) => {
    expect(modelRequiresAlwaysOnThinking(url)).toBe(expected);
  });

  it("returns false for an undefined base url", () => {
    expect(modelRequiresAlwaysOnThinking(undefined)).toBe(false);
  });
});

describe("createPiSourceProvider thinking config", () => {
  it("marks token-plan openai reasoning on so responses sends an effort level", () => {
    expect(singleModel({ accessMode: "token-plan", kind: "qwen", modelId: "qwen3.7-plus", protocol: "openai", sourceId: "qwen_tp" }))
      .toMatchObject({ api: "openai-responses", compat: { supportsDeveloperRole: false, supportsLongCacheRetention: false }, reasoning: true });
  });

  it("marks coding-plan openai reasoning on", () => {
    expect(singleModel({ accessMode: "coding-plan", kind: "qwen", modelId: "qwen3.7-plus", protocol: "openai", sourceId: "qwen_cp" }))
      .toMatchObject({ api: "openai-responses", compat: { supportsDeveloperRole: false, supportsLongCacheRetention: false }, reasoning: true });
  });

  it("keeps the standard qwen api openai model without forced thinking", () => {
    const model = singleModel({ accessMode: "api", kind: "qwen", modelId: "qwen3.5-plus", protocol: "openai", sourceId: "qwen_api" });
    expect(model.reasoning).toBe(false);
    expect(model.compat).toMatchObject({ supportsDeveloperRole: false, supportsLongCacheRetention: false });
  });

  it("keeps qwen token-plan anthropic reasoning true without an openai compat override", () => {
    const model = singleModel({ accessMode: "token-plan", kind: "qwen", modelId: "qwen3.7-plus", protocol: "anthropic", sourceId: "qwen_tp_an" });
    expect(model.reasoning).toBe(true);
    expect(model.compat).toBeUndefined();
  });
});
