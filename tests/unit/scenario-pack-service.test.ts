import type { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import type { ScenarioPackDefinition } from "../../src/main/application/partners/ai-berkshire-scenario-pack.js";
import { ScenarioPackService } from "../../src/main/application/partners/scenario-pack-service.js";
import type { ScenarioPackBinding, ScenarioPackRepository } from "../../src/main/application/ports/scenario-packs.js";
import { DomainError } from "../../src/main/domain/errors.js";
import type { PartnerDto } from "../../src/shared/joi.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

class MemoryBindings implements ScenarioPackRepository {
  readonly records = new Map<string, ScenarioPackBinding>();
  find(packId: string, roleId: string) { return Promise.resolve(this.records.get(`${packId}:${roleId}`) ?? null); }
  list(packId: string) { return Promise.resolve([...this.records.values()].filter((binding) => binding.packId === packId)); }
  save(binding: ScenarioPackBinding) { this.records.set(`${binding.packId}:${binding.roleId}`, binding); return Promise.resolve(); }
}

function pack(roleIds = ["active", "disabled", "outdated", "deleted", "missing", "config"]): ScenarioPackDefinition {
  return {
    blurb: "pack", definitionVersion: 2, id: "test-pack",
    roles: roleIds.map((id) => ({ blurb: id, capabilities: [], id, prompt: `prompt ${id}`, skills: [], title: id, tools: [] })),
    source: { license: "MIT", repository: "example/test", revision: "1234567890" },
    sourceOverlays: [], sourceSkills: [],
    teams: [{ blurb: "team", id: "team", roleIds, title: "team" }], title: "pack",
  };
}

function partner(partnerId: string, status: PartnerDto["status"], configuration?: PartnerDto["configuration"]): PartnerDto {
  return {
    capabilities: [], createdBy: "joi", displayName: partnerId, engine: "pi-core", inFlightCount: 0,
    kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId,
    partnerRevisionId: `revision-${partnerId}`, registryRevision: 1, skills: [], status, tools: [],
    ...(configuration === undefined ? {} : { configuration }),
  };
}

function binding(roleId: string, definitionVersion = 2): ScenarioPackBinding {
  return {
    definitionVersion, installedAt: "2026-01-01T00:00:00.000Z", packId: "test-pack",
    partnerId: `partner-${roleId}`, roleId, updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("scenario pack service edge states", () => {
  it("projects missing, deleted, outdated, disabled and invalid partner states safely", async () => {
    const repository = new MemoryBindings();
    for (const roleId of ["active", "disabled", "outdated", "deleted", "missing", "config"]) {
      await repository.save(binding(roleId, roleId === "outdated" ? 1 : 2));
    }
    const records = new Map<string, PartnerDto>([
      ["partner-active", partner("partner-active", "ACTIVE")],
      ["partner-disabled", partner("partner-disabled", "DISABLED")],
      ["partner-outdated", partner("partner-outdated", "ACTIVE")],
      ["partner-deleted", partner("partner-deleted", "DELETED")],
      ["partner-config", partner("partner-config", "ACTIVE", { reasonCodes: [], status: "ACTION_REQUIRED" })],
    ]);
    const service = new ScenarioPackService({
      clock: new TestClock(), ids: new TestIds(), packs: [pack()], repository,
      partners: {
        add: () => Promise.reject(new Error("unexpected add")),
        inspect: (partnerId) => {
          const item = records.get(partnerId);
          return item === undefined ? Promise.reject(new DomainError("partner_not_found", "missing")) : Promise.resolve(item);
        },
      },
    });

    const listed = (await service.list())[0];
    expect(listed?.status).toBe("ACTION_REQUIRED");
    const states = new Map(listed?.teams[0]?.roles.map((role) => [role.id, role]) ?? []);
    expect(states.get("active")).toMatchObject({ status: "ACTIVE" });
    expect(states.get("disabled")).toMatchObject({ reasonCode: "partner_disabled", status: "DISABLED" });
    expect(states.get("outdated")).toMatchObject({ reasonCode: "scenario_pack_role_outdated", status: "OUTDATED" });
    expect(states.get("deleted")).toMatchObject({ status: "NOT_INSTALLED" });
    expect(states.get("missing")).toMatchObject({ status: "NOT_INSTALLED" });
    expect(states.get("config")).toMatchObject({ reasonCode: "partner_configuration_invalid", status: "ACTION_REQUIRED" });
  });

  it("returns outdated and configuration outcomes without overwriting existing roles", async () => {
    const repository = new MemoryBindings();
    await repository.save(binding("outdated", 1));
    await repository.save(binding("config"));
    const records = new Map([
      ["partner-outdated", partner("partner-outdated", "ACTIVE")],
      ["partner-config", partner("partner-config", "ACTIVE", { reasonCodes: [], status: "ACTION_REQUIRED" })],
    ]);
    const service = new ScenarioPackService({
      clock: new TestClock(), ids: new TestIds(), packs: [pack(["outdated", "config"])], repository,
      partners: {
        add: () => Promise.reject(new Error("must not overwrite")),
        inspect: (partnerId) => Promise.resolve(records.get(partnerId) ?? partner(partnerId, "DELETED")),
      },
    });
    const result = await service.install("test-pack", {});
    expect(result.outcomes).toEqual([
      { outcome: "ACTION_REQUIRED", partnerId: "partner-outdated", reasonCode: "scenario_pack_role_outdated", roleId: "outdated" },
      { outcome: "ACTION_REQUIRED", partnerId: "partner-config", reasonCode: "partner_configuration_invalid", roleId: "config" },
    ]);
    expect(result.status).toBe("ACTION_REQUIRED");
  });

  it("replaces deleted bindings, retains installation time, and rejects malformed definitions", async () => {
    const repository = new MemoryBindings();
    await repository.save(binding("deleted"));
    const created: PartnerDto[] = [];
    const createdInputs: Parameters<PartnerRegistryService["add"]>[0][] = [];
    const service = new ScenarioPackService({
      clock: new TestClock(), ids: new TestIds(), packs: [pack(["deleted"])], repository,
      partners: {
        add: (input: Parameters<PartnerRegistryService["add"]>[0]) => {
          createdInputs.push(input);
          const item = partner(input.partnerId ?? "generated", "ACTIVE");
          created.push(item);
          return Promise.resolve(item);
        },
        inspect: () => Promise.resolve(partner("partner-deleted", "DELETED")),
      },
    });
    const result = await service.install("test-pack", { teamIds: ["team", "team"] });
    expect(result.outcomes[0]).toMatchObject({ outcome: "CREATED", partnerId: "partner-deleted_replacement" });
    expect(created).toHaveLength(1);
    expect(createdInputs[0]).toMatchObject({ toolPolicyMode: "ALL" });
    expect((await repository.find("test-pack", "deleted"))?.installedAt).toBe("2026-01-01T00:00:00.000Z");

    const malformed = { ...pack(["active"]), teams: [{ blurb: "bad", id: "bad", roleIds: ["missing-role"], title: "bad" }] };
    const malformedService = new ScenarioPackService({
      clock: new TestClock(), ids: new TestIds(), packs: [malformed], repository: new MemoryBindings(),
      partners: { add: () => Promise.reject(new Error("unused")), inspect: () => Promise.reject(new Error("unused")) },
    });
    await expect(malformedService.install("test-pack", { teamIds: ["bad"] })).rejects.toMatchObject({ code: "scenario_pack_definition_invalid" });
    await expect(malformedService.list()).rejects.toMatchObject({ code: "scenario_pack_definition_invalid" });
  });

  it("propagates unexpected registry failures", async () => {
    const repository = new MemoryBindings();
    await repository.save(binding("active"));
    const service = new ScenarioPackService({
      clock: new TestClock(), ids: new TestIds(), packs: [pack(["active"])], repository,
      partners: { add: () => Promise.reject(new Error("unused")), inspect: () => Promise.reject(new Error("registry unavailable")) },
    });
    await expect(service.list()).rejects.toThrow("registry unavailable");
  });

  it("recovers interrupted disabled and invalid deterministic roles without duplicating them", async () => {
    const repository = new MemoryBindings();
    const service = new ScenarioPackService({
      clock: new TestClock(), ids: new TestIds(), packs: [pack(["disabled", "config"])], repository,
      partners: {
        add: () => Promise.reject(new Error("must not duplicate")),
        inspect: (partnerId) => Promise.resolve(partnerId.endsWith("disabled")
          ? partner(partnerId, "DISABLED")
          : partner(partnerId, "ACTIVE", { reasonCodes: [], status: "ACTION_REQUIRED" })),
      },
    });

    const result = await service.install("test-pack", {});
    expect(result.outcomes).toEqual([
      expect.objectContaining({ outcome: "ACTION_REQUIRED", reasonCode: "partner_disabled", roleId: "disabled" }),
      expect.objectContaining({ outcome: "ACTION_REQUIRED", reasonCode: "partner_configuration_invalid", roleId: "config" }),
    ]);
    expect(await repository.list("test-pack")).toHaveLength(2);
  });
});
