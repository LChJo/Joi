/* In-memory port doubles intentionally resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import type { Credential } from "@earendil-works/pi-ai";

import type {
  EncryptedPiCredentialRecord,
  PiCredentialRecordStore,
} from "../../src/main/application/ports/model-source-ports.js";
import { SafeStoragePiCredentialStore } from "../../src/main/infrastructure/pi/pi-credential-store-adapter.js";

class MemoryEncryptedStore implements PiCredentialRecordStore {
  readonly records = new Map<string, EncryptedPiCredentialRecord>();
  async read(providerId: string) { return this.records.get(providerId) ?? null; }
  async list() { return [...this.records.values()].map(({ providerId, type, version }) => ({ providerId, type, version })); }
  async write(record: EncryptedPiCredentialRecord) { this.records.set(record.providerId, record); }
  async delete(providerId: string) { this.records.delete(providerId); }
}

class FakeSafeStorageVault {
  decrypt(ciphertext: Uint8Array): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(ciphertext.map((value) => value ^ 0x5a)));
  }
  encrypt(value: string): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(value).map((byte) => byte ^ 0x5a));
  }
  isAvailable(): boolean { return true; }
}

describe("Pi safeStorage credential adapter", () => {
  it("persists only encrypted credentials and lists non-secret metadata", async () => {
    const records = new MemoryEncryptedStore();
    const store = new SafeStoragePiCredentialStore({ records, vault: new FakeSafeStorageVault() });
    const providerId = "joi-source:source_1";
    const secret = "pi-contract-secret-123";

    const saved = await store.modify(providerId, async () => ({ key: secret, type: "api_key" }));
    expect(saved).toEqual({ key: secret, type: "api_key" });
    expect(await store.read(providerId)).toEqual(saved);
    expect(await store.list()).toEqual([{ providerId, type: "api_key" }]);

    const persisted = records.records.get(providerId);
    expect(persisted).toMatchObject({ providerId, type: "api_key", version: 1 });
    expect(new TextDecoder().decode(persisted?.encryptedBlob)).not.toContain(secret);
    expect(JSON.stringify(await store.list())).not.toContain(secret);
  });

  it("serializes modify operations per provider and never falls back after deletion", async () => {
    const records = new MemoryEncryptedStore();
    const store = new SafeStoragePiCredentialStore({ records, vault: new FakeSafeStorageVault() });
    const providerId = "joi-source:source_2";
    await store.modify(providerId, async () => ({ key: "v1", type: "api_key" }));

    const mutations = Array.from({ length: 4 }, (_, index) => store.modify(providerId, async (current) => {
      await Promise.resolve();
      const key = current?.type === "api_key" ? `${current.key ?? ""}:${String(index)}` : String(index);
      return { key, type: "api_key" } satisfies Credential;
    }));
    await Promise.all(mutations);
    expect(records.records.get(providerId)?.version).toBe(5);

    await store.delete(providerId);
    expect(await store.read(providerId)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});
