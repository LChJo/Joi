import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileRemoteAccessStore } from "../../src/main/infrastructure/remote/file-remote-access-store.js";

describe("FileRemoteAccessStore native migration", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { force: true, recursive: true });
  });

  it("migrates the browser gateway state to the existing iroh relay without reusing its bearer", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "joi-remote-store-"));
    const statePath = path.join(directory, "remote-access.json");
    await writeFile(statePath, JSON.stringify({
      devices: [],
      enabled: true,
      encryptedRelayAuthentication: Buffer.from("legacy-browser-token").toString("base64"),
      hostId: "host-legacy",
      relayUrl: "https://remote.joilab.top",
      version: 1,
    }));

    await expect(new FileRemoteAccessStore(statePath).load()).resolves.toEqual({
      devices: [],
      enabled: true,
      hostId: "host-legacy",
      relayUrl: "https://cudex.joilab.top",
      version: 2,
    });
  });
});
