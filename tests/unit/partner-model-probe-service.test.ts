/* Test doubles resolve immediately by design. */
/* eslint-disable @typescript-eslint/require-await */
import { PartnerModelProbeService } from "../../src/main/application/partners/partner-model-probe-service.js";
import type { ModelSourceDto, PartnerDto } from "../../src/shared/joi.js";
import { TestClock } from "../support/runtime-fixture.js";

const partner: PartnerDto = {
  capabilities: [], createdBy: "user", displayName: "Coder", engine: "pi-core", inFlightCount: 0,
  kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", modelIdOverride: "gpt-5.6-sol-sub",
  modelSourceId: "source-ready", partnerId: "partner-1", partnerRevisionId: "revision-1", registryRevision: 1,
  skills: [], status: "ACTIVE", tools: [],
};

const source: ModelSourceDto = {
  accessMode: "api", activeModel: { capability: "release-tested", id: "gpt-5.6-sol-sub", revisionId: "model-1" },
  activeSourceRevisionId: "source-revision-1", credential: { configured: true, version: 1 }, displayName: "gpt-sub",
  kind: "generic-openai", order: 0, primary: true, protocol: "openai", sourceId: "source-ready", status: "READY",
};

describe("partner model probe", () => {
  it("validates the partner's effective Pi model without creating work or exposing provider errors", async () => {
    const validate = vi.fn(async () => ({ ...source, lastValidatedAt: "2026-08-25T08:00:00.000Z" }));
    const service = new PartnerModelProbeService({
      clock: new TestClock(), partners: { inspect: async () => partner }, sources: { list: async () => [source], validate },
    });

    await expect(service.test("partner-1")).resolves.toEqual({
      modelId: "gpt-5.6-sol-sub", partnerId: "partner-1", sourceDisplayName: "gpt-sub", sourceId: "source-ready",
      status: "READY", testedAt: "2026-08-25T08:00:00.000Z",
    });
    expect(validate).toHaveBeenCalledOnce();
  });

  it("fails safely before network access when the pinned model is not active on the selected source", async () => {
    const validate = vi.fn();
    const service = new PartnerModelProbeService({
      clock: new TestClock(),
      partners: { inspect: async () => ({ ...partner, modelIdOverride: "DeepSeek-V4-Pro" }) },
      sources: { list: async () => [source], validate },
    });

    await expect(service.test("partner-1")).resolves.toMatchObject({
      modelId: "DeepSeek-V4-Pro", reasonCode: "partner_model_override_not_ready", status: "FAILED",
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude-code"] as const)("actively tests the %s CLI partner without using managed model sources", async (engine) => {
    const test = vi.fn(async () => ({ available: true as const }));
    const service = new PartnerModelProbeService({
      clock: new TestClock(), engines: { test },
      partners: { inspect: async () => ({ ...partner, engine, engineModelId: "local-model" }) },
      sources: { list: vi.fn(), validate: vi.fn() },
    });
    await expect(service.test("partner-1")).resolves.toEqual({
      modelId: "local-model", partnerId: "partner-1", status: "READY", testedAt: "2026-07-15T12:00:00.000Z",
    });
    expect(test).toHaveBeenCalledWith(engine, "local-model");
  });

  it("returns a safe actionable result when a local CLI invocation fails", async () => {
    const service = new PartnerModelProbeService({
      clock: new TestClock(), engines: { test: async () => ({ available: false, reasonCode: "partner_cli_probe_timed_out" }) },
      partners: { inspect: async () => ({ ...partner, engine: "codex" }) },
      sources: { list: vi.fn(), validate: vi.fn() },
    });
    await expect(service.test("partner-1")).resolves.toMatchObject({
      partnerId: "partner-1", reasonCode: "partner_cli_probe_timed_out", status: "FAILED",
    });
  });

  it("fails closed when active CLI probing is not wired and keeps A2A unsupported", async () => {
    const unwired = new PartnerModelProbeService({
      clock: new TestClock(), partners: { inspect: async () => ({ ...partner, engine: "codex" }) },
      sources: { list: vi.fn(), validate: vi.fn() },
    });
    await expect(unwired.test("partner-1")).resolves.toMatchObject({
      reasonCode: "partner_engine_probe_unavailable", status: "FAILED",
    });

    const remote = new PartnerModelProbeService({
      clock: new TestClock(), partners: { inspect: async () => ({ ...partner, kind: "a2a" }) },
      sources: { list: vi.fn(), validate: vi.fn() },
    });
    await expect(remote.test("partner-1")).rejects.toMatchObject({ code: "partner_model_test_unsupported" });
  });

  it("reports missing and disabled pinned sources without attempting validation", async () => {
    const missingValidate = vi.fn();
    const missing = new PartnerModelProbeService({
      clock: new TestClock(), partners: { inspect: async () => partner },
      sources: { list: async () => [], validate: missingValidate },
    });
    await expect(missing.test("partner-1")).resolves.toMatchObject({
      modelId: "gpt-5.6-sol-sub", reasonCode: "partner_model_source_not_ready", status: "FAILED",
    });
    expect(missingValidate).not.toHaveBeenCalled();

    const disabledValidate = vi.fn();
    const disabled = new PartnerModelProbeService({
      clock: new TestClock(), partners: { inspect: async () => partner },
      sources: { list: async () => [{ ...source, status: "DISABLED" }], validate: disabledValidate },
    });
    await expect(disabled.test("partner-1")).resolves.toMatchObject({ reasonCode: "partner_model_source_not_ready", status: "FAILED" });
    expect(disabledValidate).not.toHaveBeenCalled();
  });

  it("uses the first configured global source and its active model when the partner follows global order", async () => {
    const first = { ...source, order: 0, primary: false, sourceId: "source-first" };
    const second = { ...source, order: 1, primary: true, sourceId: "source-primary" };
    const validate = vi.fn(async () => first);
    const globalPartner = structuredClone(partner);
    delete globalPartner.modelIdOverride;
    delete globalPartner.modelSourceId;
    const service = new PartnerModelProbeService({
      clock: new TestClock(),
      partners: { inspect: async () => globalPartner },
      sources: { list: async () => [second, first], validate },
    });
    await expect(service.test("partner-1")).resolves.toMatchObject({
      modelId: source.activeModel.id, sourceId: "source-first", status: "READY", testedAt: "2026-07-15T12:00:00.000Z",
    });
    expect(validate).toHaveBeenCalledWith("source-first");

    const draft = { ...first, status: "DRAFT" as const };
    const fallbackValidate = vi.fn(async () => first);
    const fallback = new PartnerModelProbeService({
      clock: new TestClock(), partners: { inspect: async () => globalPartner },
      sources: { list: async () => [draft], validate: fallbackValidate },
    });
    await expect(fallback.test("partner-1")).resolves.toMatchObject({ sourceId: "source-first", status: "READY" });
    expect(fallbackValidate).toHaveBeenCalledWith("source-first");
  });

  it("maps degraded validation and unexpected validator failure to stable safe reasons", async () => {
    const degraded = new PartnerModelProbeService({
      clock: new TestClock(), partners: { inspect: async () => partner },
      sources: {
        list: async () => [source],
        validate: async () => ({ ...source, lastValidatedAt: "2026-08-25T09:00:00.000Z", reasonCode: "model_source_http_500", status: "DEGRADED" }),
      },
    });
    await expect(degraded.test("partner-1")).resolves.toMatchObject({
      reasonCode: "model_source_http_500", status: "FAILED", testedAt: "2026-08-25T09:00:00.000Z",
    });

    const unknownStatus = new PartnerModelProbeService({
      clock: new TestClock(), partners: { inspect: async () => partner },
      sources: { list: async () => [source], validate: async () => ({ ...source, status: "NEEDS_AUTH" }) },
    });
    await expect(unknownStatus.test("partner-1")).resolves.toMatchObject({ reasonCode: "partner_model_test_failed", status: "FAILED" });

    const throws = new PartnerModelProbeService({
      clock: new TestClock(), partners: { inspect: async () => partner },
      sources: { list: async () => [source], validate: async () => { throw new Error("private provider error"); } },
    });
    const failure = await throws.test("partner-1");
    expect(failure).toMatchObject({ reasonCode: "partner_model_test_failed", status: "FAILED" });
    expect(JSON.stringify(failure)).not.toContain("private provider error");
  });
});
