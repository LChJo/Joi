import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export interface TestCredentialStore {
  store(secret: string): Promise<string>;
  reveal(credentialId: string): Promise<string | undefined>;
}

export interface TestEnvironment {
  credentials: TestCredentialStore;
  databasePath: string;
  dispose(): Promise<void>;
  userDataPath: string;
}

export async function createTestEnvironment(parentDirectory: string): Promise<TestEnvironment> {
  await mkdir(parentDirectory, { recursive: true });
  const userDataPath = await mkdtemp(path.join(parentDirectory, "joi-test-"));
  const databasePath = path.join(userDataPath, "runtime.sqlite");
  const secrets = new Map<string, string>();

  const credentials: TestCredentialStore = {
    store(secret) {
      const credentialId = `cred_test_${randomUUID()}`;
      secrets.set(credentialId, secret);
      return Promise.resolve(credentialId);
    },
    reveal(credentialId) {
      return Promise.resolve(secrets.get(credentialId));
    },
  };

  return {
    credentials,
    databasePath,
    async dispose() {
      secrets.clear();
      await rm(userDataPath, { force: true, recursive: true });
    },
    userDataPath,
  };
}
