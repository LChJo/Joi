import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import type {
  RemotePeerTransport,
  RemotePeerTransportEvent,
  RemoteTransportTicket,
} from "../../application/ports/remote-access.js";

const MAX_SIDECAR_LINE_BYTES = 512 * 1_024;

function isTicket(value: unknown): value is RemoteTransportTicket {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Partial<RemoteTransportTicket>;
  return item.version === 1 && typeof item.endpointId === "string"
    && Array.isArray(item.directAddresses) && item.directAddresses.every((address) => typeof address === "string")
    && Array.isArray(item.relayUrls) && item.relayUrls.every((url) => typeof url === "string");
}

export class IrohSidecarTransport implements RemotePeerTransport {
  readonly #arguments: string[];
  readonly #executablePath: string;
  readonly #listeners = new Set<(event: RemotePeerTransportEvent) => void>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #lines: ReadlineInterface | undefined;
  #stopping = false;

  constructor(executablePath: string, argumentsList: string[] = []) {
    this.#arguments = [...argumentsList];
    this.#executablePath = executablePath;
  }

  async start(input: { nodeSecret: string; relayAuthentication?: string; relayUrl: string }): Promise<RemoteTransportTicket> {
    if (this.#child !== undefined) throw new Error("remote_transport_already_started");
    this.#stopping = false;
    const child = spawn(this.#executablePath, this.#arguments, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stderr.resume();
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

    return new Promise<RemoteTransportTicket>((resolve, reject) => {
      let settled = false;
      const startTimer = setTimeout(() => {
        child.kill();
        failStart();
      }, 15_000);
      startTimer.unref();
      const failStart = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        reject(new Error("remote_transport_start_failed"));
      };
      child.stdin.on("error", () => {
        if (!settled) {
          this.#stopping = true;
          failStart();
          try { child.kill(); } catch { /* Process is already gone. */ }
          return;
        }
        if (this.#stopping) return;
        this.#stopping = true;
        this.#emit({ code: "remote_transport_write_failed", type: "error" });
      });
      child.once("error", failStart);
      child.once("exit", () => {
        this.#resetChild(child);
        failStart();
        if (!this.#stopping) this.#emit({ code: "remote_transport_stopped", type: "error" });
      });
      this.#lines?.on("line", (line) => {
        if (Buffer.byteLength(line, "utf8") > MAX_SIDECAR_LINE_BYTES) {
          this.#emit({ code: "remote_transport_frame_too_large", type: "error" });
          return;
        }
        let value: unknown;
        try { value = JSON.parse(line) as unknown; }
        catch { this.#emit({ code: "remote_transport_event_invalid", type: "error" }); return; }
        if (value === null || Array.isArray(value) || typeof value !== "object") return;
        const event = value as Record<string, unknown>;
        if (event.type === "ready" && isTicket(event.ticket)) {
          if (!settled) { settled = true; clearTimeout(startTimer); resolve(event.ticket); }
          return;
        }
        if (event.type === "peerOpen" && typeof event.connectionId === "string") {
          this.#emit({ connectionId: event.connectionId, type: "peerOpen" });
        } else if (event.type === "peerFrame" && typeof event.connectionId === "string") {
          this.#emit({ connectionId: event.connectionId, frame: event.frame, type: "peerFrame" });
        } else if (event.type === "peerClose" && typeof event.connectionId === "string") {
          this.#emit({ connectionId: event.connectionId, type: "peerClose" });
        } else if (event.type === "error" && typeof event.code === "string") {
          this.#emit({ code: event.code, type: "error" });
        }
      });
      this.#write({
        nodeSecret: undefined,
        relayAuthentication: input.relayAuthentication,
        relayUrl: input.relayUrl,
        secretKey: input.nodeSecret,
        type: "start",
      });
    });
  }

  send(connectionId: string, frame: unknown): Promise<void> {
    this.#write({ connectionId, frame, type: "send" });
    return Promise.resolve();
  }

  disconnect(connectionId: string): Promise<void> {
    this.#write({ connectionId, type: "close" });
    return Promise.resolve();
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#stopping = true;
    try { this.#write({ type: "shutdown" }); } catch { /* Process is already gone. */ }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
      timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.#resetChild(child);
  }

  subscribe(listener: (event: RemotePeerTransportEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: RemotePeerTransportEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #resetChild(child: ChildProcessWithoutNullStreams): void {
    if (this.#child !== child) return;
    this.#lines?.close();
    this.#lines = undefined;
    this.#child = undefined;
  }

  #write(command: unknown): void {
    const child = this.#child;
    if (child?.stdin.writable !== true) throw new Error("remote_transport_not_started");
    const line = JSON.stringify(command);
    if (Buffer.byteLength(line, "utf8") > MAX_SIDECAR_LINE_BYTES) throw new Error("remote_transport_frame_too_large");
    child.stdin.write(`${line}\n`);
  }
}
