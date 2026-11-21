import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopUpdater } from "../../src/main/infrastructure/operations/desktop-updater";

const releases = "https://github.com/LChJo/Joi/releases";
const version = "0.10.0";
const installer = `joi-${version}-win-x64.exe`;
const bytes = "test installer bytes";
const digest = createHash("sha256").update(bytes).digest("hex");

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("GitHub desktop updater", () => {
  let directory: string;

  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "joi-update-test-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  function fakeRelease({ location = `${releases}/tag/v${version}`, filename = installer, sums = `${digest}  ${filename}\n`, asset = bytes, redirect }: {
    location?: string; filename?: string; sums?: string; asset?: string; redirect?: string;
  } = {}) {
    return vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = requestUrl(input);
      if (url === `${releases}/latest`) return Promise.resolve(new Response(null, { status: 302, headers: { location } }));
      if (url === `${releases}/download/v${version}/SHA256SUMS.txt`) {
        return Promise.resolve(redirect === undefined ? new Response(sums) : new Response(null, { status: 302, headers: { location: redirect } }));
      }
      if (url === redirect) return Promise.resolve(new Response(sums));
      if (url === `${releases}/download/v${version}/${filename}`) return Promise.resolve(new Response(asset));
      return Promise.reject(new Error("unexpected request"));
    });
  }

  function updater(fetchImpl: typeof fetch, currentVersion = "0.9.9") {
    const install = vi.fn<(installerPath: string) => Promise<void>>().mockResolvedValue(undefined);
    const service = new DesktopUpdater({ arch: "x64", currentVersion, directory, fetchImpl, install, mode: "restart" });
    return { service, install };
  }

  it("checks numerically, stages once, and only installs the requested verified version", async () => {
    const fetchImpl = fakeRelease();
    const { service, install } = updater(fetchImpl);
    expect(service.command({ action: "check" }).phase).toBe("checking");
    service.command({ action: "check" });
    await vi.waitFor(() => expect(service.status()).toMatchObject({ phase: "available", latestVersion: version, mode: "restart" }));
    expect(fetchImpl.mock.calls.map(([url]) => requestUrl(url))).toEqual([`${releases}/latest`, `${releases}/download/v${version}/SHA256SUMS.txt`]);
    service.command({ action: "download", version: "0.9.9" });
    expect(service.status().phase).toBe("available");
    expect(service.command({ action: "download", version }).phase).toBe("downloading");
    service.command({ action: "download", version });
    await vi.waitFor(() => expect(service.status().phase).toBe("ready"));
    expect(install).not.toHaveBeenCalled();
    expect(service.command({ action: "install", version }).phase).toBe("installing");
    service.command({ action: "install", version });
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    const installerPath = install.mock.calls[0]?.[0];
    if (installerPath === undefined) throw new Error("installer was not invoked");
    expect(await readFile(installerPath, "utf8")).toBe(bytes);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(service.status()).not.toHaveProperty("installerPath");
  });

  it("keeps equal and older releases current, and rejects other repositories and prereleases", async () => {
    for (const current of [version, "0.11.0"]) {
      const { service } = updater(fakeRelease(), current);
      service.command({ action: "check" });
      await vi.waitFor(() => expect(service.status().phase).toBe("current"));
    }
    for (const location of [`https://github.com/other/Joi/releases/tag/v${version}`, `${releases}/tag/v${version}-beta.1`]) {
      const fetchImpl = fakeRelease({ location });
      const { service } = updater(fetchImpl);
      service.command({ action: "check" });
      await vi.waitFor(() => expect(service.status().error).toBe("checkFailed"));
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("offers the release page when this architecture has no installer", async () => {
    const { service } = updater(fakeRelease({ sums: `${digest}  joi-${version}-mac-arm64.dmg\n` }));
    service.command({ action: "check" });
    await vi.waitFor(() => expect(service.status()).toMatchObject({ phase: "available", mode: "manual", releaseUrl: `${releases}/tag/v${version}` }));
    service.command({ action: "download", version });
    expect(service.status().phase).toBe("available");
  });

  it("accepts the GitHub asset CDN and opens a verified macOS disk image", async () => {
    const filename = `joi-${version}-mac-arm64.dmg`;
    const fetchImpl = fakeRelease({ filename, redirect: "https://release-assets.githubusercontent.com/manifest" });
    const install = vi.fn<(installerPath: string) => Promise<void>>().mockResolvedValue(undefined);
    const service = new DesktopUpdater({ arch: "arm64", currentVersion: "0.9.9", directory, fetchImpl, install, mode: "open" });
    service.command({ action: "check" });
    await vi.waitFor(() => expect(service.status()).toMatchObject({ phase: "available", mode: "open" }));
    service.command({ action: "download", version });
    await vi.waitFor(() => expect(service.status().phase).toBe("ready"));
    service.command({ action: "install", version });
    await vi.waitFor(() => expect(install).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(filename)));
    expect(service.status().phase).toBe("ready");
  });

  it("rejects checksum redirects outside the GitHub asset CDN", async () => {
    const fetchImpl = fakeRelease({ redirect: "https://invalid.example/manifest" });
    const { service } = updater(fetchImpl);
    service.command({ action: "check" });
    await vi.waitFor(() => expect(service.status()).toMatchObject({ phase: "idle", error: "checkFailed" }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("removes corrupt transfers and revalidates a staged file before launching it", async () => {
    const { service, install } = updater(fakeRelease({ asset: "tampered" }));
    service.command({ action: "check" });
    await vi.waitFor(() => expect(service.status().phase).toBe("available"));
    service.command({ action: "download", version });
    await vi.waitFor(() => expect(service.status()).toMatchObject({ phase: "available", error: "downloadFailed" }));
    expect(await readdir(directory)).toEqual([]);

    const retry = updater(fakeRelease());
    retry.service.command({ action: "check" });
    await vi.waitFor(() => expect(retry.service.status().phase).toBe("available"));
    retry.service.command({ action: "download", version });
    await vi.waitFor(() => expect(retry.service.status().phase).toBe("ready"));
    const [staging] = await readdir(directory);
    if (staging === undefined) throw new Error("installer was not staged");
    await writeFile(path.join(directory, staging, installer), "tampered");
    retry.service.command({ action: "install", version });
    await vi.waitFor(() => expect(retry.service.status()).toMatchObject({ phase: "available", error: "downloadFailed" }));
    expect(retry.install).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});
