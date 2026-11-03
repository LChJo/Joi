import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ArtifactService } from "../../src/main/infrastructure/artifacts/artifact-service";
import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { createRuntimeFixture } from "../support/runtime-fixture";

function cookieFrom(response: Response): string {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

describe("managed Artifact access", () => {
  it("scopes files to a Life, rechecks realpath/size/hash and exposes safe preview/download", async () => {
    const fixture = await createRuntimeFixture();
    const rootDirectory = path.join(fixture.root, "artifacts");
    const artifacts = new ArtifactService({ rootDirectory, store: fixture.database.store });
    const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, artifacts }), loopbackPort: 0 });
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.70/card.json", name: "Artifact Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId, name: "档案生命", personaSummary: "验证受控文件", timezone: "UTC",
      });
      const invocationId = "invocation_artifact_access";
      await fixture.database.store.createInvocation({
        agentConnectionId: agent.agentConnectionId,
        createdAt: fixture.clock.now().toISOString(),
        invocationId,
        messageId: "message_artifact_access",
        outboxId: "outbox_artifact_access",
        request: { parts: [{ kind: "text", text: "produce report" }] },
      });
      const bytes = Buffer.from("# safe report\n\nverified", "utf8");
      const directory = path.join(rootDirectory, invocationId);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "remote-report.md"), bytes);
      await fixture.database.store.createArtifact({
        artifactId: "artifact_access",
        createdAt: fixture.clock.now().toISOString(),
        filename: "报告.md",
        invocationId,
        lifeId: life.lifeId,
        mimeType: "text/markdown",
        relativePath: `${invocationId}/remote-report.md`,
        remoteArtifactId: "remote-report",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      });

      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const session = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }), headers: { "content-type": "application/json", origin: "null" }, method: "POST",
      });
      const cookie = cookieFrom(session);
      const preview = await fetch(`${listeners.loopback.url}/api/v1/lives/${life.lifeId}/artifacts/artifact_access/preview`, { headers: { cookie } });
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(preview.headers.get("content-security-policy")).toContain("sandbox");
      expect(await preview.text()).toBe(bytes.toString("utf8"));

      const download = await fetch(`${listeners.loopback.url}/api/v1/lives/${life.lifeId}/artifacts/artifact_access/download`, { headers: { cookie } });
      expect(download.headers.get("content-disposition")).toContain("attachment");
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
      const wrongLife = await fetch(`${listeners.loopback.url}/api/v1/lives/life_other/artifacts/artifact_access/download`, { headers: { cookie } });
      expect(wrongLife.status).toBe(404);

      await writeFile(path.join(directory, "remote-report.md"), "tampered", "utf8");
      await expect(artifacts.read({ artifactId: "artifact_access", lifeId: life.lifeId, preview: false }))
        .rejects.toMatchObject({ code: "artifact_integrity_failed" });
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("enforces the 500 MiB managed total for each Affair scope", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.71/card.json", name: "Quota Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId, name: "配额生命", personaSummary: "验证事务配额", timezone: "UTC",
      });
      await fixture.database.store.createInvocation({
        agentConnectionId: agent.agentConnectionId,
        createdAt: fixture.clock.now().toISOString(),
        invocationId: "invocation_quota",
        messageId: "message_quota",
        outboxId: "outbox_quota",
        request: { parts: [{ kind: "text", text: "quota" }] },
      });
      await fixture.database.store.createArtifact({
        artifactId: "artifact_quota",
        createdAt: fixture.clock.now().toISOString(),
        filename: "quota.bin",
        invocationId: "invocation_quota",
        lifeId: life.lifeId,
        mimeType: "application/octet-stream",
        remoteArtifactId: "remote_quota",
        size: 500 * 1024 * 1024,
      });
      await expect(fixture.database.store.assertArtifactQuota({ additionalBytes: 1, lifeId: life.lifeId }))
        .rejects.toMatchObject({ code: "artifact_quota_exceeded" });
    } finally {
      await fixture.close();
    }
  });
});
