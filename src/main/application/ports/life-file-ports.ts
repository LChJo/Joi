export interface StagedLifeFileDeletion {
  quarantineDirectory: string;
  moves: { destination: string; source: string }[];
}

export interface LifeFileDeletionPort {
  commit(plan: StagedLifeFileDeletion): Promise<void>;
  rollback(plan: StagedLifeFileDeletion): Promise<void>;
  stage(lifeId: string): Promise<StagedLifeFileDeletion>;
}
