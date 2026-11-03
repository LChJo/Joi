import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database";

declare module "vitest" {
  export interface ProvidedContext {
    runtimeDatabaseTemplate: string;
  }
}

export default async function setup(project: TestProject) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "joi-test-schema-")));
  try {
    const databasePath = path.join(root, "template.sqlite");
    const database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      if (database.inspect().mode !== "read-write") throw new Error("Test database migrations failed.");
    } finally {
      database.close();
    }
    // Closing the sole WAL connection checkpoints the empty, fully migrated template.
    project.provide("runtimeDatabaseTemplate", databasePath);
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
  return async () => { await rm(root, { force: true, recursive: true }); };
}
