/* Probe doubles resolve immediately by design. */
/* eslint-disable @typescript-eslint/require-await */
import type { ModelSourceRecord } from "../../src/main/application/ports/model-source-ports.js";
import { createModelSource } from "../../src/main/domain/model-sources/model-source.js";
import { PiModelSourceValidator } from "../../src/main/infrastructure/pi/pi-model-source-validator.js";

function record(): ModelSourceRecord {
  return {
    local: false,
    order: 0,
    primary: true,
    source: createModelSource({
      createdAt: "2026-07-28T10:00:00.000Z",
      credentialRef: "joi-source:test",
      credentialVersion: 1,
      displayName: "Kimi",
      kind: "kimi",
      modelCapability: "release-tested",
      modelId: "kimi-k2.5",
      modelRevisionId: "model-1",
      sourceId: "test",
      sourceRevisionId: "revision-1",
    }),
  };
}

describe("PiModelSourceValidator", () => {
  it("does not invoke a provider for an already-canceled background probe", async () => {
    const controller = new AbortController(); controller.abort();
    const probe = vi.fn(async () => undefined);
    const validator = new PiModelSourceValidator({ clock: { now: () => new Date("2026-10-20T00:00:00Z") }, probe });
    await validator.validate(record(), controller.signal);
    expect(probe).not.toHaveBeenCalled();
  });
  it("cancels an in-flight background probe through the caller signal", async () => {
    const controller = new AbortController();
    const probe = vi.fn((_record: ModelSourceRecord, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("probe aborted")), { once: true });
    }));
    const validator = new PiModelSourceValidator({ clock: { now: () => new Date("2026-10-20T00:00:00Z") }, probe });
    const result = validator.validate(record(), controller.signal);
    controller.abort();
    expect(await result).toMatchObject({ status: "DEGRADED", reasonCode: "timeout" });
    expect(probe).toHaveBeenCalledOnce();
  });
  it.each([
    [new Error("401 Unauthorized"), "NEEDS_AUTH", "auth_failed"],
    [new Error("connection refused"), "DEGRADED", "connection_error"],
    [new Error("model not found"), "DEGRADED", "model_unavailable"],
    [new Error("429 Too Many Requests"), "DEGRADED", "rate_limited"],
    [new Error("500 Internal Server Error"), "DEGRADED", "server_error"],
    [new Error("404 Not Found"), "DEGRADED", "not_found"],
    [new Error("400 Bad Request"), "DEGRADED", "bad_request"],
    [new Error("Connection error."), "DEGRADED", "connection_error"],
    [new Error("validation probe timed out"), "DEGRADED", "timeout"],
    [new Error("something completely unexpected"), "DEGRADED", "endpoint_unreachable"],
  ] as const)("classifies validation failures and preserves the raw error", async (failure, status, reasonCode) => {
    const validator = new PiModelSourceValidator({
      clock: { now: () => new Date("2026-07-28T10:00:30.000Z") },
      probe: async () => { throw failure; },
    });
    expect(await validator.validate(record())).toEqual({ error: failure.message, reasonCode, status, validatedAt: "2026-07-28T10:00:30.000Z" });
  });

  it("marks a minimal fixed-text probe ready", async () => {
    const validator = new PiModelSourceValidator({
      clock: { now: () => new Date("2026-07-28T10:00:30.000Z") },
      probe: async () => undefined,
    });
    expect(await validator.validate(record())).toEqual({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" });
  });

  it.each([
    ["403 invalid API key credential", "auth_forbidden"],
    ["403 model is not available for this account", "model_access_forbidden"],
    ["403 unavailable in this region", "region_forbidden"],
    ["403 request blocked by content policy", "request_policy_forbidden"],
    ["403 PRIVATE opaque denial", "http_403"],
  ])("persists only a safe 403 reason code for %s", async (message, reasonCode) => {
    const validator = new PiModelSourceValidator({
      clock: { now: () => new Date("2026-07-28T10:00:30.000Z") },
      probe: async () => { throw new Error(message); },
    });
    const result = await validator.validate(record());
    expect(result).toEqual({ reasonCode, status: "NEEDS_AUTH", validatedAt: "2026-07-28T10:00:30.000Z" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("classifies a status-bearing provider error even when its message has no status text", async () => {
    const failure = Object.assign(new Error("provider denied this request"), { status: 403 });
    const validator = new PiModelSourceValidator({
      clock: { now: () => new Date("2026-07-28T10:00:30.000Z") },
      probe: async () => { throw failure; },
    });

    await expect(validator.validate(record())).resolves.toEqual({
      reasonCode: "http_403",
      status: "NEEDS_AUTH",
      validatedAt: "2026-07-28T10:00:30.000Z",
    });
  });
});
