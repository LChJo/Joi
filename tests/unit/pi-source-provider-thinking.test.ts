import { clampThinkingLevel } from "@earendil-works/pi-ai";

import { modelRequiresAlwaysOnThinking } from "../../src/main/infrastructure/pi/provider-presets.js";
import { createPiSourceProvider, defaultThinkingLevel, type PiSourceProviderInput } from "../../src/main/infrastructure/pi/source-provider-factory.js";
import type { ThinkingEffort } from "../../src/shared/joi.js";

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

describe("createPiSourceProvider thinkingEffort", () => {
  it.each(["low", "medium", "high", "xhigh", "max"] as const)("routes a configured effort through adaptive thinking ($effort)", (effort) => {
    const model = singleModel({ kind: "generic-openai", baseUrl: "http://127.0.0.1:54455/", displayName: "自定义", modelId: "glm-5.3-flash", protocol: "anthropic", sourceId: "glm_an", thinkingEffort: effort });
    expect(model.api).toBe("anthropic-messages");
    expect(model.compat).toMatchObject({ forceAdaptiveThinking: true });
    expect(model.thinkingLevelMap).toMatchObject({ [effort]: effort });
  });

  it("leaves a generic anthropic source untouched when no effort is configured", () => {
    const model = singleModel({ kind: "generic-openai", baseUrl: "http://127.0.0.1:54455/", displayName: "自定义", modelId: "glm-5.3-flash", protocol: "anthropic", sourceId: "glm_an_plain" });
    expect(model.compat).toBeUndefined();
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it("treats an explicit off as no adaptive override on the anthropic wire", () => {
    const model = singleModel({ kind: "generic-openai", baseUrl: "http://127.0.0.1:54455/", displayName: "自定义", modelId: "glm-5.3-flash", protocol: "anthropic", sourceId: "glm_an_off", thinkingEffort: "off" });
    expect(model.compat).toBeUndefined();
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it("turns reasoning on for a non-always-on openai gateway with a configured effort", () => {
    const model = singleModel({ kind: "generic-openai", baseUrl: "http://127.0.0.1:54455/v1", displayName: "自定义", modelId: "glm-5.3-flash", protocol: "openai", sourceId: "glm_oai", thinkingEffort: "high" });
    expect(model.reasoning).toBe(true);
  });

  // pi-ai counts "xhigh"/"max" as unavailable unless thinkingLevelMap names them, and
  // openai-responses runs clampThinkingLevel before it builds the body — so without the
  // declaration "最高" silently goes out as "high" and the choice never reaches the gateway.
  // This is that same clamp, applied to the model the factory hands the wire.
  it.each(["xhigh", "max"] as const)("declares the top tiers on the openai wire so pi-ai cannot clamp them down ($effort)", (effort) => {
    const model = singleModel({ kind: "generic-openai", baseUrl: "http://127.0.0.1:54455/v1", displayName: "自定义", modelId: "glm-5.3-flash", protocol: "openai", sourceId: "glm_oai_top", thinkingEffort: effort });
    expect(model.reasoning).toBe(true);
    expect(clampThinkingLevel(model, effort)).toBe(effort);
  });

  it("keeps reasoning off for a non-always-on openai gateway with an explicit off", () => {
    const model = singleModel({ kind: "generic-openai", baseUrl: "http://127.0.0.1:54455/v1", displayName: "自定义", modelId: "glm-5.3-flash", protocol: "openai", sourceId: "glm_oai_off", thinkingEffort: "off" });
    expect(model.reasoning).toBe(false);
    expect(model.thinkingLevelMap).toBeUndefined();
  });
});

describe("createPiSourceProvider Kimi K3 tiers", () => {
  const k3 = (thinkingEffort?: ThinkingEffort) => singleModel({
    accessMode: "coding-plan", kind: "kimi", modelId: "k3", protocol: "anthropic", sourceId: "kimi_k3",
    ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
  });

  it("keeps K3's own tier table when the choice is left to joi", () => {
    expect(k3().thinkingLevelMap).toEqual({
      high: "high", low: "low", max: "max", medium: null, minimal: null, off: null, xhigh: null,
    });
  });

  // The table is joi's guess about the endpoint; the tier the user picked for this exact model is
  // not. Letting the table win sent "极高" as "high" — pi-ai only passes an entry through when it
  // is a string, and folds everything past "high" to "high" otherwise.
  it("layers the chosen tier on top of K3's table instead of losing to it", () => {
    expect(k3("xhigh").thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
    expect(k3("medium").thinkingLevelMap).toMatchObject({ medium: "medium" });
  });

  it("still refuses to let K3 be sent a disabled-thinking block", () => {
    expect(k3("off").thinkingLevelMap).toMatchObject({ off: null });
  });

  it("leaves the tiers the user did not pick as unavailable", () => {
    expect(k3("high").thinkingLevelMap).toMatchObject({ off: null, minimal: null, medium: null, xhigh: null });
  });
});

describe("defaultThinkingLevel", () => {
  it("prefers the user's configured effort", () => {
    expect(defaultThinkingLevel("max", "https://token-plan.cn-beijing.maas.aliyuncs.com/v1")).toBe("max");
  });

  it("falls back to the endpoint allowlist when unset", () => {
    expect(defaultThinkingLevel(undefined, "https://token-plan.cn-beijing.maas.aliyuncs.com/v1")).toBe("low");
    expect(defaultThinkingLevel(undefined, "http://127.0.0.1:54455/")).toBe("off");
  });

  // Kimi's coding-plan host is not one of the always-on Bailian hosts, so an unset K3 tier runs at
  // "off" — which pi-agent-core turns into an omitted `reasoning` (agent.js: "off" ? undefined).
  // That means K3's effort was never requested at all before tiers existed, and the tiers below are
  // reaching the endpoint for the first time — hence probing with the configured one.
  it("leaves Kimi's coding-plan host at off, not low", () => {
    expect(defaultThinkingLevel(undefined, "https://api.kimi.com/coding/v1")).toBe("off");
  });
});

describe("createPiSourceProvider image input", () => {
  it("declares image input for generic openai gateways so pi-ai keeps image blocks", () => {
    const model = singleModel({ baseUrl: "https://llm.example.net/", displayName: "通用平台", kind: "generic-openai", modelId: "glm-5.3-flash", protocol: "openai", sourceId: "gateway" });
    expect(model.input).toEqual(["text", "image"]);
  });

  it("keeps image input declared for the kimi coding plan anthropic endpoint", () => {
    const model = singleModel({ accessMode: "coding-plan", kind: "kimi", modelId: "kimi-for-coding", protocol: "anthropic", sourceId: "kimi_cp" });
    expect(model.input).toEqual(["text", "image"]);
  });

  const textOnlySources: readonly PiSourceProviderInput[] = [
    { accessMode: "api", kind: "kimi", modelId: "kimi-k2.5", protocol: "openai", sourceId: "kimi_api" },
    { accessMode: "token-plan", kind: "qwen", modelId: "qwen3.7-plus", protocol: "anthropic", sourceId: "qwen_tp_an" },
    { accessMode: "api", kind: "deepseek", modelId: "deepseek-chat", protocol: "openai", sourceId: "deepseek_api" },
  ];
  it.each(textOnlySources)("keeps unproven vision sources text-only ($sourceId)", (input) => {
    expect(singleModel(input).input).toEqual(["text"]);
  });
});
