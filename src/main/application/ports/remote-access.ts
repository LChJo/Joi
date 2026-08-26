import type { RemoteAccessStatusDto, RemoteCommand, RemoteCommandResponse, RemotePairingDto } from "../../../shared/remote.js";

export interface RemoteAccessStoredDevice {
  createdAt: string;
  deviceId: string;
  encryptedSecret: Uint8Array;
  lastSeenAt: string;
  name: string;
}

export interface RemoteAccessStoredState {
  devices: RemoteAccessStoredDevice[];
  enabled: boolean;
  encryptedRelayAuthentication?: Uint8Array;
  hostId: string;
  relayUrl: string;
  version: 1;
}

export interface RemoteAccessStore {
  load(): Promise<RemoteAccessStoredState | null>;
  save(state: RemoteAccessStoredState): Promise<void>;
}

export interface RemoteAccessControl {
  close(): Promise<void>;
  createPairing(): Promise<RemotePairingDto>;
  revokeDevice(deviceId: string): Promise<void>;
  start(): Promise<void>;
  status(): Promise<RemoteAccessStatusDto>;
  update(input: { enabled?: boolean; relayAuthentication?: string | null; relayUrl?: string }): Promise<RemoteAccessStatusDto>;
}

export interface RemoteCommandHandler {
  handle(command: RemoteCommand): Promise<RemoteCommandResponse>;
}
