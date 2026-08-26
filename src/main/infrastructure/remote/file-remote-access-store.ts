import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RemoteAccessStoredState, RemoteAccessStore } from "../../application/ports/remote-access.js";

interface SerializedDevice {
  createdAt: string;
  deviceId: string;
  encryptedSecret: string;
  lastSeenAt: string;
  name: string;
}

interface SerializedState {
  devices: SerializedDevice[];
  enabled: boolean;
  encryptedRelayAuthentication?: string;
  hostId: string;
  relayUrl: string;
  version: 1;
}

function parseState(value: unknown): RemoteAccessStoredState {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("remote_access_state_invalid");
  const state = value as Partial<SerializedState>;
  if (state.version !== 1 || typeof state.enabled !== "boolean" || typeof state.hostId !== "string"
    || typeof state.relayUrl !== "string" || !Array.isArray(state.devices)) throw new Error("remote_access_state_invalid");
  const devices = (state.devices as unknown[]).map((device) => {
    if (device === null || typeof device !== "object") throw new Error("remote_access_state_invalid");
    const record = device as Record<string, unknown>;
    if (typeof record.createdAt !== "string" || typeof record.deviceId !== "string"
      || typeof record.encryptedSecret !== "string" || typeof record.lastSeenAt !== "string" || typeof record.name !== "string") {
      throw new Error("remote_access_state_invalid");
    }
    return {
      createdAt: record.createdAt,
      deviceId: record.deviceId,
      encryptedSecret: Buffer.from(record.encryptedSecret, "base64"),
      lastSeenAt: record.lastSeenAt,
      name: record.name,
    };
  });
  if (state.encryptedRelayAuthentication !== undefined && typeof state.encryptedRelayAuthentication !== "string") {
    throw new Error("remote_access_state_invalid");
  }
  return {
    devices,
    enabled: state.enabled,
    ...(state.encryptedRelayAuthentication === undefined ? {} : {
      encryptedRelayAuthentication: Buffer.from(state.encryptedRelayAuthentication, "base64"),
    }),
    hostId: state.hostId,
    relayUrl: state.relayUrl,
    version: 1,
  };
}

function serializeState(state: RemoteAccessStoredState): SerializedState {
  return {
    devices: state.devices.map((device) => ({ ...device, encryptedSecret: Buffer.from(device.encryptedSecret).toString("base64") })),
    enabled: state.enabled,
    ...(state.encryptedRelayAuthentication === undefined ? {} : {
      encryptedRelayAuthentication: Buffer.from(state.encryptedRelayAuthentication).toString("base64"),
    }),
    hostId: state.hostId,
    relayUrl: state.relayUrl,
    version: 1,
  };
}

export class FileRemoteAccessStore implements RemoteAccessStore {
  constructor(private readonly statePath: string) {}

  async load(): Promise<RemoteAccessStoredState | null> {
    try {
      return parseState(JSON.parse(await readFile(this.statePath, "utf8")) as unknown);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state: RemoteAccessStoredState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${String(process.pid)}.tmp`;
    await rm(temporary, { force: true });
    await writeFile(temporary, `${JSON.stringify(serializeState(state), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rm(this.statePath, { force: true });
    await rename(temporary, this.statePath);
  }
}
