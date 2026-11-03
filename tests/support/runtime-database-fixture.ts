import { copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { inject } from "vitest";

import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database";

/** Functional fixtures use the current schema; migration tests use the production opener. */
export async function openRuntimeDatabaseFixture(databasePath: string) {
  await mkdir(path.dirname(databasePath), { recursive: true });
  try {
    await copyFile(inject("runtimeDatabaseTemplate"), databasePath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  return openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
}
