import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/* Pi's credential callbacks are asynchronous even when a mutation is immediate. */
/* eslint-disable @typescript-eslint/require-await */

import type { CredentialVault } from "../../application/ports/a2a-ports.js";
import type { PiCredentialRecordStore } from "../../application/ports/model-source-ports.js";

function parseCredential(serialized: string): Credential {
  const value: unknown = JSON.parse(serialized);
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("pi_credential_invalid");
  const record = value as Record<string, unknown>;
  if (record.type === "api_key") {
    if (record.key !== undefined && typeof record.key !== "string") throw new Error("pi_credential_invalid");
    if (record.env !== undefined && (record.env === null || Array.isArray(record.env) || typeof record.env !== "object"
      || Object.values(record.env as Record<string, unknown>).some((item) => typeof item !== "string"))) {
      throw new Error("pi_credential_invalid");
    }
    return value as Credential;
  }
  if (record.type === "oauth" && typeof record.access === "string" && typeof record.refresh === "string" && typeof record.expires === "number") {
    return value as Credential;
  }
  throw new Error("pi_credential_invalid");
}

export class SafeStoragePiCredentialStore implements CredentialStore {
  readonly #locks = new Map<string, Promise<void>>();
  readonly #records: PiCredentialRecordStore;
  readonly #vault: CredentialVault;

  constructor(input: { records: PiCredentialRecordStore; vault: CredentialVault }) {
    this.#records = input.records;
    this.#vault = input.vault;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const record = await this.#records.read(providerId);
    if (record === null) return undefined;
    if (!this.#vault.isAvailable()) throw new Error("pi_credential_encryption_unavailable");
    return parseCredential(await this.#vault.decrypt(record.encryptedBlob));
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return (await this.#records.list()).map(({ providerId, type }) => ({ providerId, type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.#serialize(providerId, async () => {
      const record = await this.#records.read(providerId);
      const current = record === null ? undefined : await this.#decrypt(record.encryptedBlob);
      const next = await fn(current);
      if (next === undefined) return current;
      const encryptedBlob = await this.#vault.encrypt(JSON.stringify(next));
      await this.#records.write({
        encryptedBlob,
        providerId,
        type: next.type,
        version: (record?.version ?? 0) + 1,
      });
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#serialize(providerId, () => this.#records.delete(providerId));
  }

  async saveApiKey(providerId: string, apiKey: string | undefined): Promise<number> {
    await this.modify(providerId, async () => ({
      ...(apiKey === undefined ? {} : { key: apiKey }),
      type: "api_key",
    }));
    const record = await this.#records.read(providerId);
    if (record === null) throw new Error("pi_credential_write_failed");
    return record.version;
  }

  async #decrypt(blob: Uint8Array): Promise<Credential> {
    if (!this.#vault.isAvailable()) throw new Error("pi_credential_encryption_unavailable");
    return parseCredential(await this.#vault.decrypt(blob));
  }

  async #serialize<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(providerId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const barrier = run.then(() => undefined, () => undefined);
    this.#locks.set(providerId, barrier);
    try {
      return await run;
    } finally {
      if (this.#locks.get(providerId) === barrier) this.#locks.delete(providerId);
    }
  }
}
