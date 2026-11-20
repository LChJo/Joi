import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/* Pi's credential callbacks are asynchronous even when a mutation is immediate. */
/* eslint-disable @typescript-eslint/require-await */

import type { CredentialVault } from "../../application/ports/a2a-ports.js";
import type { ModelSourceOAuthCredential, PiCredentialRecordStore } from "../../application/ports/model-source-ports.js";
import type { CodexAccountDto } from "../../../shared/joi.js";

const PLAN_NAMES = new Map([
  ["free", "Free"], ["go", "Go"], ["plus", "Plus"], ["pro", "Pro"], ["team", "Team"],
  ["business", "Business"], ["enterprise", "Enterprise"], ["edu", "Edu"],
]);

function describeAccess(access: string): { maskedAccount?: string; plan?: string } {
  try {
    const payload = access.split(".")[1];
    if (payload === undefined) return {};
    const token = JSON.parse(Buffer.from(payload, "base64url").toString()) as { "https://api.openai.com/auth"?: Record<string, unknown> };
    const claims = token["https://api.openai.com/auth"];
    const id = claims?.chatgpt_account_id;
    const planType = claims?.chatgpt_plan_type;
    const plan = typeof planType === "string" ? PLAN_NAMES.get(planType.toLowerCase()) : undefined;
    return {
      ...(typeof id === "string" && /^[a-z0-9-]{8,80}$/iu.test(id) ? { maskedAccount: `••••${id.slice(-4)}` } : {}),
      ...(plan === undefined ? {} : { plan }),
    };
  } catch {
    return {};
  }
}

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
    return this.#version(providerId);
  }

  async saveOAuth(providerId: string, credential: ModelSourceOAuthCredential): Promise<number> {
    await this.modify(providerId, async () => ({ ...credential, type: "oauth" }));
    return this.#version(providerId);
  }

  async describeOAuth(providerId: string): Promise<CodexAccountDto | undefined> {
    const credential = await this.read(providerId);
    if (credential?.type !== "oauth" || !Number.isFinite(new Date(credential.expires).getTime())) return undefined;
    return { expiresAt: new Date(credential.expires).toISOString(), ...describeAccess(credential.access) };
  }

  async #version(providerId: string): Promise<number> {
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
