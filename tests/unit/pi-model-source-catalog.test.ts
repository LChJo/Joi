import { DomainError } from "../../src/main/domain/errors.js";
import { PiModelSourceCatalog } from "../../src/main/infrastructure/pi/pi-model-source-catalog.js";

describe("PiModelSourceCatalog", () => {
  it("uses release-tested defaults and marks advanced model ids unverified", () => {
    const catalog = new PiModelSourceCatalog();
    expect(catalog.resolve("kimi")).toMatchObject({ accessMode: "api", capability: "release-tested", displayName: "Kimi API", modelId: "kimi-k2.5", protocol: "openai" });
    expect(catalog.resolve("kimi", undefined, "coding-plan", "anthropic")).toMatchObject({
      accessMode: "coding-plan", capability: "release-tested", displayName: "Kimi Code", modelId: "kimi-for-coding", protocol: "anthropic",
    });
    expect(catalog.resolve("kimi", "kimi-k3", "coding-plan", "anthropic")).toMatchObject({
      capability: "release-tested",
      modelId: "k3",
    });
    expect(catalog.resolve("kimi", undefined, "coding-plan")).toMatchObject({ presetVersion: "2026-08-06" });
    expect(catalog.resolve("glm", undefined, "coding-plan")).toMatchObject({ displayName: "GLM Coding Plan", modelId: "glm-5.2" });
    expect(catalog.resolve("qwen", undefined, "coding-plan")).toMatchObject({ displayName: "百炼 Coding Plan", modelId: "qwen3.7-plus" });
    expect(catalog.resolve("qwen", undefined, "token-plan", "anthropic")).toMatchObject({
      accessMode: "token-plan", displayName: "百炼 Token Plan", modelId: "qwen3.7-plus", protocol: "anthropic",
    });
    expect(catalog.resolve("doubao", undefined, "coding-plan")).toMatchObject({ displayName: "方舟 Coding Plan", modelId: "ark-code-latest" });
    expect(catalog.resolve("minimax", undefined, "coding-plan")).toMatchObject({ displayName: "MiniMax Token Plan", modelId: "MiniMax-M2.7" });
    expect(catalog.resolve("deepseek", "deepseek-reasoner")).toMatchObject({ capability: "release-tested", modelId: "deepseek-reasoner" });
    expect(catalog.resolve("qwen", "future-qwen-model")).toMatchObject({ capability: "custom-unverified-tools", modelId: "future-qwen-model" });
    expect(catalog.resolve("generic-openai", "local-model", "custom", "anthropic")).toEqual({
      accessMode: "custom",
      capability: "custom-unverified-tools",
      displayName: "通用平台",
      modelId: "local-model",
      protocol: "anthropic",
    });
    expect(() => catalog.resolve("deepseek", undefined, "api", "anthropic")).toThrow(DomainError);
  });

  it("requires a model id for a generic source", () => {
    expect(() => new PiModelSourceCatalog().resolve("generic-openai")).toThrow(DomainError);
  });
});
