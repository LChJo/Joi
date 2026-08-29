import type {
  ScenarioPackDto,
  ScenarioPackInstallResultDto,
  ScenarioPackRoleInstallOutcomeDto,
  ScenarioPackRoleStatusDto,
} from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { PartnerSkillCatalog } from "../ports/partner-skills.js";
import type { ScenarioPackBinding, ScenarioPackRepository } from "../ports/scenario-packs.js";
import type { ScenarioPackDefinition, ScenarioPackRoleDefinition } from "./ai-berkshire-scenario-pack.js";
import { defaultScenarioPacks } from "./builtin-scenario-packs.js";
import type { PartnerRegistryService } from "./partner-registry-service.js";

type PartnerAccess = Pick<PartnerRegistryService, "add" | "inspect">;

export class ScenarioPackService {
  constructor(private readonly dependencies: {
    clock: Clock;
    ids: IdGenerator;
    partners: PartnerAccess;
    repository: ScenarioPackRepository;
    packs?: readonly ScenarioPackDefinition[];
    skills?: Pick<PartnerSkillCatalog, "listForEngine">;
  }) {}

  async list(): Promise<ScenarioPackDto[]> {
    return Promise.all(this.#packs().map(async (pack) => this.#toDto(pack, await this.dependencies.repository.list(pack.id))));
  }

  async install(packId: string, input: { teamIds?: string[] }): Promise<ScenarioPackInstallResultDto> {
    const pack = this.#pack(packId);
    const roleIds = this.#selectedRoleIds(pack, input.teamIds);
    const outcomes: ScenarioPackRoleInstallOutcomeDto[] = [];
    for (const roleId of roleIds) {
      const role = pack.roles.find((candidate) => candidate.id === roleId);
      if (role === undefined) throw new DomainError("scenario_pack_definition_invalid", "Scenario pack role is missing.");
      outcomes.push(await this.#ensureRole(pack, role));
    }
    const current = await this.#toDto(pack, await this.dependencies.repository.list(pack.id));
    return { installedRoleCount: current.installedRoleCount, outcomes, packId, status: current.status };
  }

  #pack(packId: string): ScenarioPackDefinition {
    const pack = this.#packs().find((candidate) => candidate.id === packId);
    if (pack === undefined) throw new DomainError("scenario_pack_not_found", "Scenario pack was not found.");
    return pack;
  }

  #packs(): readonly ScenarioPackDefinition[] {
    if (this.dependencies.packs !== undefined) return this.dependencies.packs;
    return defaultScenarioPacks(this.dependencies.skills?.listForEngine("pi-core") ?? []);
  }

  #selectedRoleIds(pack: ScenarioPackDefinition, teamIds: string[] | undefined): string[] {
    if (pack.roles.length === 0) throw new DomainError("scenario_pack_empty", "Scenario pack has no installable roles.");
    if (teamIds === undefined) return pack.roles.map((role) => role.id);
    if (teamIds.length === 0) throw new DomainError("scenario_pack_team_selection_empty", "Select at least one scenario pack team.");
    const uniqueTeamIds = [...new Set(teamIds)];
    const teams = uniqueTeamIds.map((teamId) => {
      const team = pack.teams.find((candidate) => candidate.id === teamId);
      if (team === undefined) throw new DomainError("scenario_pack_team_not_found", "Scenario pack team was not found.");
      return team;
    });
    return [...new Set(teams.flatMap((team) => team.roleIds))];
  }

  async #ensureRole(pack: ScenarioPackDefinition, role: ScenarioPackRoleDefinition): Promise<ScenarioPackRoleInstallOutcomeDto> {
    const binding = await this.dependencies.repository.find(pack.id, role.id);
    if (binding !== null) {
      const existing = await this.#inspect(binding.partnerId);
      if (existing !== null && existing.status !== "DELETED") {
        if (binding.definitionVersion < pack.definitionVersion) {
          return { outcome: "ACTION_REQUIRED", partnerId: binding.partnerId, reasonCode: "scenario_pack_role_outdated", roleId: role.id };
        }
        if (existing.status === "DISABLED") {
          return { outcome: "ACTION_REQUIRED", partnerId: binding.partnerId, reasonCode: "partner_disabled", roleId: role.id };
        }
        if (existing.configuration?.status === "ACTION_REQUIRED") {
          return { outcome: "ACTION_REQUIRED", partnerId: binding.partnerId, reasonCode: existing.configuration.reasonCodes[0] ?? "partner_configuration_invalid", roleId: role.id };
        }
        return { outcome: "REUSED", partnerId: binding.partnerId, roleId: role.id };
      }
    }

    const firstInstallId = `scenario_${pack.id}_${role.id}`;
    const proposedPartnerId = binding === null ? firstInstallId : `${binding.partnerId}_replacement`;
    const partnerId = proposedPartnerId.length <= 240 ? proposedPartnerId : this.dependencies.ids.next("partner");
    const interrupted = await this.#inspect(partnerId);
    if (interrupted !== null && interrupted.status !== "DELETED") {
      const now = this.dependencies.clock.now().toISOString();
      await this.dependencies.repository.save({
        definitionVersion: pack.definitionVersion,
        installedAt: binding?.installedAt ?? now,
        packId: pack.id,
        partnerId,
        roleId: role.id,
        updatedAt: now,
      });
      if (interrupted.status === "DISABLED") {
        return { outcome: "ACTION_REQUIRED", partnerId, reasonCode: "partner_disabled", roleId: role.id };
      }
      if (interrupted.configuration?.status === "ACTION_REQUIRED") {
        return { outcome: "ACTION_REQUIRED", partnerId, reasonCode: interrupted.configuration.reasonCodes[0] ?? "partner_configuration_invalid", roleId: role.id };
      }
      return { outcome: "REUSED", partnerId, roleId: role.id };
    }
    const partner = await this.dependencies.partners.add({
      capabilities: [...role.capabilities],
      createdBy: "joi",
      description: role.blurb,
      displayName: role.title,
      kind: "local-pi",
      partnerId,
      prompt: role.prompt,
      skills: [...role.skills],
      tools: [...role.tools],
    });
    const now = this.dependencies.clock.now().toISOString();
    await this.dependencies.repository.save({
      definitionVersion: pack.definitionVersion,
      installedAt: binding?.installedAt ?? now,
      packId: pack.id,
      partnerId: partner.partnerId,
      roleId: role.id,
      updatedAt: now,
    });
    return { outcome: "CREATED", partnerId: partner.partnerId, roleId: role.id };
  }

  async #inspect(partnerId: string) {
    try {
      return await this.dependencies.partners.inspect(partnerId);
    } catch (error) {
      if (error instanceof DomainError && error.code === "partner_not_found") return null;
      throw error;
    }
  }

  async #toDto(pack: ScenarioPackDefinition, bindings: ScenarioPackBinding[]): Promise<ScenarioPackDto> {
    const byRole = new Map(bindings.map((binding) => [binding.roleId, binding]));
    const roleStatuses = new Map<string, ScenarioPackRoleStatusDto>();
    for (const role of pack.roles) {
      const binding = byRole.get(role.id);
      if (binding === undefined) {
        roleStatuses.set(role.id, { roleId: role.id, status: "NOT_INSTALLED" });
        continue;
      }
      const partner = await this.#inspect(binding.partnerId);
      if (partner === null || partner.status === "DELETED") {
        roleStatuses.set(role.id, { partnerId: binding.partnerId, roleId: role.id, status: "NOT_INSTALLED" });
      } else if (binding.definitionVersion < pack.definitionVersion) {
        roleStatuses.set(role.id, { partnerId: binding.partnerId, reasonCode: "scenario_pack_role_outdated", roleId: role.id, status: "OUTDATED" });
      } else if (partner.status === "DISABLED") {
        roleStatuses.set(role.id, { partnerId: binding.partnerId, reasonCode: "partner_disabled", roleId: role.id, status: "DISABLED" });
      } else if (partner.configuration?.status === "ACTION_REQUIRED") {
        roleStatuses.set(role.id, { partnerId: binding.partnerId, reasonCode: partner.configuration.reasonCodes[0] ?? "partner_configuration_invalid", roleId: role.id, status: "ACTION_REQUIRED" });
      } else {
        roleStatuses.set(role.id, { partnerId: binding.partnerId, roleId: role.id, status: "ACTIVE" });
      }
    }
    const statuses = [...roleStatuses.values()];
    const installedRoleCount = statuses.filter((item) => item.status !== "NOT_INSTALLED").length;
    const status = statuses.some((item) => item.status === "ACTION_REQUIRED" || item.status === "DISABLED") ? "ACTION_REQUIRED"
      : statuses.some((item) => item.status === "OUTDATED") ? "OUTDATED"
        : installedRoleCount === 0 ? "NOT_INSTALLED" : "ACTIVE";
    return {
      blurb: pack.blurb,
      definitionVersion: pack.definitionVersion,
      id: pack.id,
      installedRoleCount,
      source: { license: pack.source.license, repository: pack.source.repository, revision: pack.source.revision.slice(0, 8) },
      status,
      teams: pack.teams.map((team) => ({
        blurb: team.blurb,
        id: team.id,
        roles: team.roleIds.map((roleId) => {
          const definition = pack.roles.find((role) => role.id === roleId);
          const state = roleStatuses.get(roleId);
          if (definition === undefined || state === undefined) throw new DomainError("scenario_pack_definition_invalid", "Scenario pack role is missing.");
          return { blurb: definition.blurb, id: definition.id, title: definition.title, ...state };
        }),
        title: team.title,
      })),
      title: pack.title,
      totalRoleCount: pack.roles.length,
    };
  }
}
