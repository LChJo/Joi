export interface ScenarioPackBinding {
  definitionVersion: number;
  installedAt: string;
  packId: string;
  partnerId: string;
  roleId: string;
  updatedAt: string;
}

export interface ScenarioPackRepository {
  find(packId: string, roleId: string): Promise<ScenarioPackBinding | null>;
  list(packId: string): Promise<ScenarioPackBinding[]>;
  save(binding: ScenarioPackBinding): Promise<void>;
}
