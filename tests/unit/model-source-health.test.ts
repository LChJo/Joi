import { modelSourceRuntime } from "../../src/main/application/model-sources/model-source-health.js";

describe("model runtime health projection", () => {
  it("keeps an all-degraded installation configured and distinguishes transient from manual recovery", () => {
    expect(modelSourceRuntime([{ status: "DEGRADED", reasonCode: "server_error" }, { status: "NEEDS_AUTH", reasonCode: "auth_failed" }]))
      .toEqual({ configured: true, status: "DEGRADED", modelHealth: { ready: 0, recovering: 1, unavailable: 2 } });
    expect(modelSourceRuntime([{ status: "DEGRADED", reasonCode: "bad_request" }]).status).toBe("NEEDS_ATTENTION");
  });
  it("reports partial failures and clears the condition only once all enabled sources are healthy", () => {
    expect(modelSourceRuntime([{ status: "READY" }, { status: "DEGRADED", reasonCode: "timeout" }]))
      .toMatchObject({ configured: true, status: "DEGRADED", modelHealth: { ready: 1, recovering: 1, unavailable: 1 } });
    expect(modelSourceRuntime([{ status: "READY" }, { status: "DISABLED" }]))
      .toMatchObject({ configured: true, status: "READY", modelHealth: { ready: 1, recovering: 0, unavailable: 0 } });
    expect(modelSourceRuntime([{ status: "VALIDATING" }]).modelHealth).toEqual({ ready: 0, recovering: 1, unavailable: 1 });
    expect(modelSourceRuntime([{ status: "DRAFT" }, { status: "DISABLED" }]).configured).toBe(false);
  });
});
