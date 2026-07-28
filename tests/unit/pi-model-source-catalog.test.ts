import { DomainError } from "../../src/main/domain/errors.js";
import { PiModelSourceCatalog } from "../../src/main/infrastructure/pi/pi-model-source-catalog.js";

describe("PiModelSourceCatalog", () => {
  it("uses release-tested defaults and marks advanced model ids unverified", () => {
    const catalog = new PiModelSourceCatalog();
    expect(catalog.resolve("kimi")).toMatchObject({ capability: "release-tested", displayName: "Kimi", modelId: "kimi-k2.5" });
    expect(catalog.resolve("deepseek", "deepseek-reasoner")).toMatchObject({ capability: "release-tested", modelId: "deepseek-reasoner" });
    expect(catalog.resolve("qwen", "future-qwen-model")).toMatchObject({ capability: "custom-unverified-tools", modelId: "future-qwen-model" });
    expect(catalog.resolve("generic-openai", "local-model")).toEqual({
      capability: "custom-unverified-tools",
      displayName: "通用平台",
      modelId: "local-model",
    });
  });

  it("requires a model id for a generic source", () => {
    expect(() => new PiModelSourceCatalog().resolve("generic-openai")).toThrow(DomainError);
  });
});
