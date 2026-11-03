import { OperationsService } from "../application/operations/operations-service.js";
import { SqliteDatabaseIntegrityMonitor } from "../infrastructure/persistence/sqlite-database-integrity-monitor.js";

type OperationsDependencies = ConstructorParameters<typeof OperationsService>[0];

export function wireOperations(input: Omit<OperationsDependencies, "integrity"> & { databasePath: string }) {
  const { databasePath, ...dependencies } = input;
  const integrity = new SqliteDatabaseIntegrityMonitor({ clock: dependencies.clock, databasePath });
  return {
    integrity,
    operations: new OperationsService({ ...dependencies, integrity }),
  };
}
