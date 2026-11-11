import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { createStaticRendererHandler } from "../../src/main/interfaces/http/static-renderer-handler";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("same-origin renderer hosting", () => {
  it("serves the SPA and immutable assets while preserving API routes", async () => {
    const fixture = await createRuntimeFixture();
    const renderer = path.join(fixture.root, "renderer");
    await mkdir(path.join(renderer, "assets"), { recursive: true });
    await writeFile(path.join(renderer, "index.html"), "<main>joi</main>");
    await writeFile(path.join(renderer, "assets", "app.js"), "export {};");
    const listeners = await startRuntimeListeners({
      handler: createStaticRendererHandler(createApiHandler(fixture), renderer),
      loopbackPort: 0,
    });
    try {
      const home = await fetch(listeners.loopback.url);
      expect(await home.text()).toContain("joi");
      expect(home.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(home.headers.get("content-security-policy")).toContain("frame-src http: https:");
      expect((await fetch(`${listeners.loopback.url}/life/example`)).status).toBe(200);
      const asset = await fetch(`${listeners.loopback.url}/assets/app.js`);
      expect(asset.headers.get("cache-control")).toContain("immutable");
      expect((await fetch(`${listeners.loopback.url}/api/v1/health`)).status).toBe(200);
      expect((await fetch(`${listeners.loopback.url}/missing.js`)).status).toBe(404);
      expect((await fetch(`${listeners.loopback.url}/`, { method: "POST" })).status).toBe(401);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
