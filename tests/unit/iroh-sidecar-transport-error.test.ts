import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

interface FakeChildLike {
  exitCode: number | null;
  kill(): boolean;
  stderr: PassThrough;
  stdin: Writable;
  stdout: PassThrough;
}

const fixture = vi.hoisted(() => ({ child: null as FakeChildLike | null }));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => fixture.child),
}));

import { IrohSidecarTransport } from "../../src/main/infrastructure/remote/iroh-sidecar-transport.js";

class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const command = JSON.parse(Buffer.from(chunk).toString("utf8")) as { type?: string };
        if (command.type === "shutdown") {
          queueMicrotask(() => this.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
          queueMicrotask(() => {
            this.exitCode = 0;
            this.emit("exit", 0, null);
          });
        }
        callback();
      },
    });
  }

  kill(): boolean {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }
}

describe("IrohSidecarTransport error handling", () => {
  it("does not leak an uncaught exception when shutdown races an async stdin EPIPE", async () => {
    const child = new FakeChild();
    fixture.child = child;
    const transport = new IrohSidecarTransport("fake-sidecar");
    const start = transport.start({ nodeSecret: "secret", relayUrl: "https://relay.example.com" });
    child.stdout.write(`${JSON.stringify({
      ticket: { directAddresses: [], endpointId: "endpoint", relayUrls: [], version: 1 },
      type: "ready",
    })}\n`);
    await start;

    const uncaught = vi.fn();
    process.once("uncaughtException", uncaught);
    try {
      await transport.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.removeListener("uncaughtException", uncaught);
      fixture.child = null;
    }
  });
});
