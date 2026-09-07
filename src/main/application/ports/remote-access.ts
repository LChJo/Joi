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
  encryptedNodeSecret?: Uint8Array;
  encryptedRelayAuthentication?: Uint8Array;
  hostId: string;
  relayUrl: string;
  version: 3;
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
  handle(command: RemoteCommand, scope?: string): Promise<RemoteCommandResponse>;
  release?(scope: string): void;
}

export interface RemoteTransportTicket {
  directAddresses: string[];
  endpointId: string;
  relayUrls: string[];
  version: 1;
}

export type RemotePeerTransportEvent =
  | { connectionId: string; type: "peerOpen" }
  | { connectionId: string; frame: unknown; type: "peerFrame" }
  | { connectionId: string; type: "peerClose" }
  | { code: string; type: "error" };

export interface RemotePeerTransport {
  close(): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
  send(connectionId: string, frame: unknown): Promise<void>;
  start(input: { nodeSecret: string; relayAuthentication?: string; relayUrl: string }): Promise<RemoteTransportTicket>;
  subscribe(listener: (event: RemotePeerTransportEvent) => void): () => void;
}
