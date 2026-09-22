import { lookup } from "node:dns/promises";
import { StatisticsService } from "../application/statistics/statistics-service.js";

import type { Clock, IdGenerator } from "../application/ports/runtime-store.js";
import { ModelSourceService } from "../application/model-sources/model-source-service.js";
import { ReasoningSourceSelector } from "../application/model-sources/reasoning-source-selector.js";
import { ModelSourceNetworkPolicy } from "../infrastructure/pi/model-source-network-policy.js";
import { PiModelSourceCatalog } from "../infrastructure/pi/pi-model-source-catalog.js";
import { PiModelSourceValidator } from "../infrastructure/pi/pi-model-source-validator.js";
import { SafeStoragePiCredentialStore } from "../infrastructure/pi/pi-credential-store-adapter.js";
import { RepositoryPiConfiguredModelResolver } from "../infrastructure/pi/pi-configured-model-resolver.js";
import type { ElectronCredentialVault } from "../infrastructure/security/electron-credential-vault.js";
import type { PersistenceBundle } from "./wire-persistence.js";

export function wireModelSources(input: {
  clock: Clock;
  ids: IdGenerator;
  persistence: PersistenceBundle;
  vault: ElectronCredentialVault;
}) {
  const { clock, ids, persistence, vault } = input;
  const statistics = new StatisticsService({ store: persistence.usageStore, now: () => clock.now().toISOString(), id: () => ids.next("usage") });
  statistics.recover();
  const piCredentials = new SafeStoragePiCredentialStore({
    records: persistence.piCredentialRepository,
    vault,
  });
  const validator = new PiModelSourceValidator({ clock, credentials: piCredentials });
  const modelSources = new ModelSourceService({
    catalog: new PiModelSourceCatalog(),
    clock,
    endpointPolicy: new ModelSourceNetworkPolicy({
      resolve: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((record) => record.address),
    }),
    ids,
    repository: persistence.modelSourceRepository,
    secrets: piCredentials,
    validator,
  });
  return {
    statistics,
    configuredModelResolver: new RepositoryPiConfiguredModelResolver({
      credentials: piCredentials,
      repository: persistence.modelSourceRepository,
    }),
    modelSources,
    piCredentials,
    reasoningSources: new ReasoningSourceSelector(persistence.modelSourceRepository, { clock, validator }),
  };
}

export type ModelSourceBundle = ReturnType<typeof wireModelSources>;
