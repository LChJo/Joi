import { ScenarioPackService } from "../../src/main/application/partners/scenario-pack-service.js";
import { SqliteScenarioPackRepository } from "../../src/main/infrastructure/persistence/sqlite-scenario-pack-repository.js";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture.js";

describe("SQLite scenario pack installer", () => {
  let fixture: RuntimeFixture;

  beforeEach(async () => { fixture = await createRuntimeFixture(); });
  afterEach(async () => { await fixture.close(); });

  function service() {
    return new ScenarioPackService({
      clock: fixture.clock,
      ids: fixture.ids,
      partners: fixture.partners,
      repository: new SqliteScenarioPackRepository(fixture.database),
    });
  }

  it("installs one team, reuses shared stable roles, and completes the full suite", async () => {
    const packs = await service().list();
    expect(packs.map((pack) => pack.id)).toEqual(["ai-berkshire-value-research", "programming", "research-analysis", "builtin-skills"]);
    expect(packs[0]).toMatchObject({ id: "ai-berkshire-value-research", installedRoleCount: 0, status: "NOT_INSTALLED", totalRoleCount: 15 });

    const first = await service().install("ai-berkshire-value-research", { teamIds: ["opportunity-screening"] });
    expect(first.outcomes).toHaveLength(6);
    expect(first.outcomes.every((outcome) => outcome.outcome === "CREATED")).toBe(true);
    expect(await fixture.partners.list()).toHaveLength(6);

    const repeated = await service().install("ai-berkshire-value-research", { teamIds: ["opportunity-screening"] });
    expect(repeated.outcomes.every((outcome) => outcome.outcome === "REUSED")).toBe(true);
    expect(await fixture.partners.list()).toHaveLength(6);

    const full = await service().install("ai-berkshire-value-research", {});
    expect(full.outcomes).toHaveLength(15);
    expect(full.outcomes.filter((outcome) => outcome.outcome === "CREATED")).toHaveLength(9);
    expect(full.outcomes.filter((outcome) => outcome.outcome === "REUSED")).toHaveLength(6);
    expect(await fixture.partners.list()).toHaveLength(15);
    expect((await service().list())[0]).toMatchObject({ installedRoleCount: 15, status: "ACTIVE" });
  });

  it("preserves user edits and surfaces disabled roles as action required", async () => {
    const installed = await service().install("ai-berkshire-value-research", { teamIds: ["research-publishing"] });
    const writer = installed.outcomes.find((outcome) => outcome.roleId === "longform-writer");
    if (writer === undefined) throw new Error("writer outcome missing");
    const current = await fixture.partners.inspect(writer.partnerId);
    await fixture.partners.update(writer.partnerId, {
      capabilities: current.capabilities,
      ...(current.description === undefined ? {} : { description: current.description }),
      displayName: "我的研究作者",
      skills: current.skills,
      tools: current.tools,
    });
    await fixture.partners.disable(writer.partnerId);

    const retried = await service().install("ai-berkshire-value-research", { teamIds: ["research-publishing"] });
    expect(retried.outcomes.find((outcome) => outcome.roleId === "longform-writer")).toMatchObject({
      outcome: "ACTION_REQUIRED", partnerId: writer.partnerId, reasonCode: "partner_disabled",
    });
    expect((await fixture.partners.inspect(writer.partnerId)).displayName).toBe("我的研究作者");
    expect(await fixture.partners.list()).toHaveLength(3);
    expect((await service().list())[0]).toMatchObject({ status: "ACTION_REQUIRED" });
  });

  it("rejects empty or unknown team selections without side effects", async () => {
    await expect(service().install("ai-berkshire-value-research", { teamIds: [] }))
      .rejects.toMatchObject({ code: "scenario_pack_team_selection_empty" });
    await expect(service().install("ai-berkshire-value-research", { teamIds: ["unknown"] }))
      .rejects.toMatchObject({ code: "scenario_pack_team_not_found" });
    await expect(service().install("unknown-pack", {}))
      .rejects.toMatchObject({ code: "scenario_pack_not_found" });
    expect(await fixture.partners.list()).toEqual([]);
  });

  it("recovers an already-created deterministic role after binding persistence was interrupted", async () => {
    const partnerId = "scenario_ai-berkshire-value-research_longform-writer";
    await fixture.partners.add({
      capabilities: ["investment-writing"], createdBy: "joi", displayName: "长篇研究作者", kind: "local-pi",
      partnerId, prompt: "portable prompt", skills: [], tools: ["read", "write", "research_audit"],
    });

    const recovered = await service().install("ai-berkshire-value-research", { teamIds: ["research-publishing"] });
    expect(recovered.outcomes.find((outcome) => outcome.roleId === "longform-writer")).toMatchObject({ outcome: "REUSED", partnerId });
    expect(await fixture.partners.list()).toHaveLength(3);
    expect((await service().list())[0]).toMatchObject({ installedRoleCount: 3, status: "ACTIVE" });
  });

  it("keeps committed roles after a full installation fails and reuses user edits on retry", async () => {
    const original = fixture.partners.add.bind(fixture.partners);
    const add = vi.spyOn(fixture.partners, "add");
    add.mockImplementationOnce(original).mockRejectedValueOnce(new Error("fixture interruption"));
    await expect(service().install("programming", {})).rejects.toThrow("fixture interruption");
    const partial = await fixture.partners.list();
    expect(partial).toHaveLength(1);
    const first = partial[0];
    if (first === undefined) throw new Error("missing partial partner");
    await fixture.partners.update(first.partnerId, { ...first, displayName: "User customized role" });
    const result = await service().install("programming", {});
    expect(result.outcomes.filter(role => role.outcome === "REUSED")).toHaveLength(1);
    expect(result.outcomes.filter(role => role.outcome === "CREATED")).toHaveLength(result.installedRoleCount - 1);
    expect(await fixture.partners.list()).toHaveLength(result.installedRoleCount);
    expect((await fixture.partners.inspect(first.partnerId)).displayName).toBe("User customized role");
  });
});
