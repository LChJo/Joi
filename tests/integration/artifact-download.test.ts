import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OutboundNetworkPolicy } from "../../src/main/infrastructure/a2a/outbound-network-policy";
import { SecureArtifactDownloader } from "../../src/main/infrastructure/a2a/secure-artifact-downloader";

describe("secure Artifact download", () => {
  it("keeps Bearer on the confirmed Origin and atomically stores a hashed relative file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-artifact-"));
    const authorizations: (string | null)[] = [];
    const fakeFetch: typeof fetch = (_resource, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Promise.resolve(new Response("hello", { headers: { "content-length": "5", "content-type": "text/plain" } }));
    };
    const downloader = new SecureArtifactDownloader({
      fetchImpl: fakeFetch,
      policy: new OutboundNetworkPolicy({ resolve: () => Promise.resolve(["192.168.1.20"]) }),
      rootDirectory: root,
    });
    try {
      const result = await downloader.download({
        artifactId: "artifact_1",
        declaredOrigin: "http://agent.lan",
        filename: "report.txt",
        invocationId: "invocation_1",
        mimeType: "text/plain",
        size: 5,
        token: "secret-token",
        url: "http://agent.lan/artifacts/1",
      });
      expect(result).toEqual({
        relativePath: "invocation_1/artifact_1-report.txt",
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        size: 5,
      });
      expect(await readFile(path.join(root, ...result.relativePath.split("/")), "utf8")).toBe("hello");
      expect(authorizations).toEqual(["Bearer secret-token"]);
      expect(JSON.stringify(result)).not.toContain("secret-token");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects declaration mismatch and unsafe identifiers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-artifact-"));
    const downloader = new SecureArtifactDownloader({
      fetchImpl: () => Promise.resolve(new Response("hello")),
      policy: new OutboundNetworkPolicy({ resolve: () => Promise.resolve(["192.168.1.20"]) }),
      rootDirectory: root,
    });
    try {
      await expect(downloader.download({
        artifactId: "../escape", declaredOrigin: "http://agent.lan", filename: "file.txt", invocationId: "invocation_1",
        mimeType: "text/plain", size: 5, token: "secret", url: "http://agent.lan/a",
      })).rejects.toMatchObject({ code: "artifact_rejected" });
      await expect(downloader.download({
        artifactId: "artifact_1", declaredOrigin: "http://agent.lan", filename: "file.txt", invocationId: "invocation_1",
        mimeType: "text/plain", size: 4, token: "secret", url: "http://agent.lan/a",
      })).rejects.toMatchObject({ code: "artifact_rejected" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
