import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTestEnvironment } from "../support/test-environment";

describe("test environment isolation", () => {
  it("uses disposable paths and an opaque credential fake", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "joi-parent-"));
    const environment = await createTestEnvironment(parent);

    try {
      expect(environment.userDataPath.startsWith(parent)).toBe(true);
      expect(environment.databasePath.startsWith(parent)).toBe(true);
      const credentialId = await environment.credentials.store("test-secret-value");
      expect(credentialId).toMatch(/^cred_test_/);
      expect(JSON.stringify(environment)).not.toContain("test-secret-value");
      await expect(readFile(environment.databasePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await environment.dispose();
      await rm(parent, { force: true, recursive: true });
    }
  });
});
