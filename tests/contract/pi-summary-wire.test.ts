import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createModels, type CredentialStore } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { summarizeSegment } from "../../src/main/infrastructure/pi/pi-compaction.js";
import { createPiSourceProvider } from "../../src/main/infrastructure/pi/source-provider-factory.js";

const credentials: CredentialStore = {
  read: () => Promise.resolve({ type: "api_key", key: "synthetic-credential" }),
  list: () => Promise.resolve([]), modify: () => Promise.resolve(undefined), delete: () => Promise.resolve(),
};

describe("SUM-03 actual summary request", () => {
  it.each([["openai", false], ["anthropic", false], ["anthropic", true]] as const)("uses route output capacity on %s with required thinking=%s", async (protocol, requiredThinking) => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: "synthetic validation response" } }));
      });
    });
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
    try {
      const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
      const provider = createPiSourceProvider({ kind: "generic-openai", protocol, baseUrl, displayName: "Synthetic source", sourceId: `summary-wire-${protocol}`,
        modelId: "summary-test", contextWindow: requiredThinking ? 32_000 : 1_000_000, maxOutputTokens: 32_768, thinkingEffort: "high" });
      const models = createModels({ credentials, authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) } });
      models.setProvider(provider);
      const transported = vi.spyOn(models, "completeSimple");
      const model = provider.getModels()[0];
      if (model === undefined) throw new Error("Missing test model");
      const summaryModel = requiredThinking ? { ...model, compat: { forceAdaptiveThinking: false }, thinkingLevelMap: { off: null, minimal: null, low: "low" } } : model;
      expect(await summarizeSegment({ models, model: summaryModel, segment: [{ role: "user", content: requiredThinking ? "中".repeat(12_000) : "SYNTHETIC_TASK", timestamp: 0 }],
        ...(requiredThinking ? { previousSummary: "中".repeat(8000) } : {}), reserveTokens: 8000, thinkingLevel: "high" }))
        .toMatchObject({ ok: false, reasonCode: "summary_provider_error" });
      expect(bodies).toHaveLength(1);
      const body = bodies[0];
      const ceiling = body?.[protocol === "openai" ? "max_output_tokens" : "max_tokens"];
      if (requiredThinking) {
        expect(ceiling).toBe(transported.mock.calls[0]?.[2]?.maxTokens);
        expect(Number(ceiling) + JSON.stringify(transported.mock.calls[0]?.[1]).length).toBeLessThan(32_000);
        expect(body?.thinking).toMatchObject({ type: "enabled" });
      } else expect(ceiling).toBe(32_768);
      if (protocol === "openai") expect(body?.reasoning).toEqual({ effort: "none" });
      else if (!requiredThinking) {
        expect(body?.thinking).toEqual({ type: "disabled" });
        expect(body?.output_config).toBeUndefined();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error !== undefined) reject(error); else resolve(); }); });
    }
  });
});
