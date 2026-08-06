/* eslint-disable @typescript-eslint/require-await */
import { PartnerEngineCatalog } from "../../src/main/application/partners/partner-engine-catalog.js";
import type { PartnerEngineRuntime } from "../../src/main/application/ports/partner-instances.js";

function fakeRuntime(available: boolean, reason?: string): PartnerEngineRuntime {
  return {
    engineOf: () => "pi-core",
    evictFromMemory: () => undefined,
    health: async () => (available ? { available: true } : { available: false, ...(reason === undefined ? {} : { reason }) }),
    runEphemeral: async () => ({ externalRunId: "x", output: { artifacts: [], body: "" }, status: "COMPLETED" }),
    runResidentTurn: async () => ({ externalRunId: "x", messages: [], output: { artifacts: [], body: "" }, status: "COMPLETED" }),
    toolOptions: () => ["read", "edit"],
  };
}

describe("partner engine catalog", () => {
  it("lists each engine with its tool options and availability reason", async () => {
    const catalog = new PartnerEngineCatalog(new Map([
      ["pi-core", fakeRuntime(true)],
      ["codex", fakeRuntime(false, "codex missing")],
    ]));
    const list = await catalog.list();
    expect(list).toEqual(expect.arrayContaining([
      { available: true, id: "pi-core", tools: ["read", "edit"] },
      { available: false, id: "codex", reason: "codex missing", tools: ["read", "edit"] },
    ]));
  });

  it("asserts availability and fails closed for missing or unhealthy engines", async () => {
    const catalog = new PartnerEngineCatalog(new Map([
      ["pi-core", fakeRuntime(true)],
      ["claude-code", fakeRuntime(false)],
      ["codex", fakeRuntime(false, "binary missing")],
    ]));
    await expect(catalog.assertAvailable("pi-core")).resolves.toBeUndefined();
    await expect(catalog.assertAvailable("claude-code")).rejects.toMatchObject({ code: "engine_unavailable" });
    await expect(catalog.assertAvailable("codex")).rejects.toMatchObject({
      code: "engine_unavailable",
      message: "Partner engine is unavailable: binary missing.",
    });
    await expect(new PartnerEngineCatalog(new Map()).assertAvailable("codex")).rejects.toMatchObject({ code: "engine_unavailable" });
  });
});
