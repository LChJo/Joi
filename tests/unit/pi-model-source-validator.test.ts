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
  it.each([
    [new Error("401 Unauthorized"), "NEEDS_AUTH", "auth_failed"],
    [new Error("connection refused"), "DEGRADED", "endpoint_unreachable"],
    [new Error("model not found"), "DEGRADED", "model_unavailable"],
  ] as const)("classifies validation failures without a tool-call probe", async (failure, status, reasonCode) => {
    const validator = new PiModelSourceValidator({
      clock: { now: () => new Date("2026-07-28T10:00:30.000Z") },
      probe: async () => { throw failure; },
    });
    expect(await validator.validate(record())).toEqual({ reasonCode, status, validatedAt: "2026-07-28T10:00:30.000Z" });
  });

  it("marks a minimal fixed-text probe ready", async () => {
    const validator = new PiModelSourceValidator({
      clock: { now: () => new Date("2026-07-28T10:00:30.000Z") },
      probe: async () => undefined,
    });
    expect(await validator.validate(record())).toEqual({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" });
  });
});
