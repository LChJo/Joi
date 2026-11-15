import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishDesktopRelease } from "../../scripts/publish-desktop-release.mjs";

function fakeGithub(handler: (url: string, init?: RequestInit) => Response | undefined): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const response = handler(url, init)
      ?? (url.includes("/releases?") ? Response.json([]) : Response.json({}, { status: 404 }));
    return Promise.resolve(response);
  };
}

function jsonBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(init.body) as unknown;
}

describe("desktop release publication", () => {
  let directory: string;
  const sha = "a".repeat(40);
  const win = "joi-0.1.1-win-x64.exe";
  const mac = "joi-0.1.1-mac-arm64.dmg";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "joi-release-"));
    await writeFile(path.join(directory, win), "Windows installer");
    await writeFile(path.join(directory, mac), "macOS installer");
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("uploads both installers and checksums to a draft before making the version Latest", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl = fakeGithub((url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body });
      if (url.endsWith("/releases/tags/v0.1.1")) return Response.json({}, { status: 404 });
      if (url.includes("/git/ref/tags/")) return Response.json({}, { status: 404 });
      if (method === "POST" && url.endsWith("/releases")) {
        expect(jsonBody(init)).toMatchObject({
          tag_name: "v0.1.1", target_commitish: sha, draft: true, name: "joi 0.1.1",
        });
        return Response.json({ id: 123, draft: true, target_commitish: sha, assets: [] }, { status: 201 });
      }
      if (url.includes("/releases?")) return undefined;
      if (url.includes("/assets?name=")) {
        const name = new URL(url).searchParams.get("name");
        const body = init?.body;
        expect(body).toBeInstanceOf(Buffer);
        return Response.json({ name, state: "uploaded", size: Buffer.byteLength(body as Buffer) }, { status: 201 });
      }
      expect(method).toBe("PATCH");
      expect(jsonBody(init)).toEqual({ draft: false, make_latest: "true" });
      return Response.json({ html_url: "https://github.com/example/joi/releases/tag/v0.1.1" });
    });
    await publishDesktopRelease({ directory, version: "0.1.1", repository: "example/joi", sha, token: "fixture", fetchImpl });
    expect(calls.filter(call => call.url.includes("/assets?name=")).map(call => new URL(call.url).searchParams.get("name")))
      .toEqual([mac, win, "SHA256SUMS.txt"]);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "https://api.github.com/repos/example/joi/releases/123" });
    const checksums = await readFile(path.join(directory, "SHA256SUMS.txt"), "utf8");
    expect(checksums).toMatch(new RegExp(`^[a-f0-9]{64}  ${mac}\\n[a-f0-9]{64}  ${win}\\n$`));
  });

  function options(fetchImpl: typeof fetch) {
    return { directory, version: "0.1.1", repository: "example/joi", sha, token: "fixture", fetchImpl };
  }

  it("preserves published assets on subsequent commits and workflow reruns", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      draft: false, html_url: "https://github.com/example/joi/releases/tag/v0.1.1",
    }));
    expect(await publishDesktopRelease(options(fetchImpl))).toMatchObject({ skipped: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "wrong-version", "empty"])("does not create a release for a %s installer", async (scenario) => {
    if (scenario === "missing") await rm(path.join(directory, mac));
    if (scenario === "wrong-version") {
      await rm(path.join(directory, mac));
      await writeFile(path.join(directory, "joi-0.1.0-mac-arm64.dmg"), "old installer");
    }
    if (scenario === "empty") await writeFile(path.join(directory, mac), "");
    const methods: string[] = [];
    const fetchImpl = fakeGithub((_url, init) => {
      methods.push(init?.method ?? "GET");
      return undefined;
    });
    await expect(publishDesktopRelease(options(fetchImpl))).rejects.toThrow(/installer|EXE/);
    expect(methods.every(method => method === "GET")).toBe(true);
  });

  it("keeps the release unpublished when an installer upload fails", async () => {
    const methods: string[] = [];
    const fetchImpl = fakeGithub((url, init) => {
      methods.push(init?.method ?? "GET");
      if (url.includes("/tags/")) return Response.json({}, { status: 404 });
      if (url.includes("/releases?")) return undefined;
      if (url.endsWith("/releases")) return Response.json({ id: 123, assets: [] }, { status: 201 });
      if (url.endsWith(".dmg")) {
        return Response.json({ name: mac, state: "uploaded", size: 15 }, { status: 201 });
      }
      return Response.json({}, { status: 502 });
    });
    await expect(publishDesktopRelease(options(fetchImpl))).rejects.toThrow("HTTP 502");
    expect(methods).not.toContain("PATCH");
  });

  it("resumes an interrupted draft only for its original commit", async () => {
    const methods: string[] = [];
    const fetchImpl = fakeGithub((url, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (url.endsWith("/releases/tags/v0.1.1")) return undefined;
      if (url.includes("/releases?")) {
        return Response.json([{ id: 123, tag_name: "v0.1.1", draft: true, target_commitish: sha, assets: [{ id: 7, name: mac }] }]);
      }
      if (url.includes("/git/ref/")) return Response.json({}, { status: 404 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/assets?")) {
        return Response.json({
          name: new URL(url).searchParams.get("name"), state: "uploaded", size: Buffer.byteLength(init?.body as Buffer),
        });
      }
      return Response.json({ html_url: "https://github.com/example/joi/releases/tag/v0.1.1" });
    });
    expect(await publishDesktopRelease(options(fetchImpl))).toMatchObject({ skipped: false });
    expect(methods).toContain("DELETE");
    expect(methods.at(-1)).toBe("PATCH");
  });

  it.each(["draft", "tag"])("refuses a %s belonging to another commit", async (kind) => {
    const fetchImpl = fakeGithub((url) => {
      if (url.includes("/git/ref/")) return Response.json({ object: { type: "commit", sha: "b".repeat(40) } });
      if (url.includes("/releases?")) return undefined;
      return kind === "draft"
        ? Response.json({ draft: true, target_commitish: "b".repeat(40) })
        : Response.json({}, { status: 404 });
    });
    await expect(publishDesktopRelease(options(fetchImpl))).rejects.toThrow("different commit");
  });

  it("reports an authorization failure without treating it as a missing release", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 403 }));
    await expect(publishDesktopRelease(options(fetchImpl))).rejects.toThrow("HTTP 403");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses version 0.1.1 consistently in desktop metadata and the root lock entry", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
      version: string; packages: Record<string, { version: string }>;
    };
    expect(manifest.version).toBe("0.1.1");
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""]?.version).toBe(manifest.version);
  });
});
