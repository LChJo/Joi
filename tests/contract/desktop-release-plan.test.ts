import { planDesktopRelease } from "../../scripts/plan-desktop-release.mjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

describe("desktop version release plan", () => {
  const base = { version: "0.1.2", repository: "example/joi", token: "fixture", ref: "refs/heads/main", eventName: "push" };

  it.each([
    ["0.1.2", "0.1.1", true], ["0.1.2", "0.1.2", false], ["0.1.2", "0.2.0", false],
    ["0.10.0", "0.9.9", true], ["1.0.0", "0.99.99", true],
  ])("compares candidate %s with published %s numerically", async (version, latest, publish) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ tag_name: `v${latest}` }));
    expect(await planDesktopRelease({ ...base, version, fetchImpl })).toMatchObject({ publish });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/repos/example/joi/releases/latest", expect.objectContaining({ method: "GET" }));
  });

  it("allows an initial stable release when no release has been published", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 404 }));
    expect(await planDesktopRelease({ ...base, fetchImpl })).toMatchObject({ publish: true });
  });

  it.each([
    { ref: "refs/heads/test", eventName: "push" },
    { ref: "refs/heads/feature", eventName: "workflow_dispatch" },
    { ref: "refs/heads/main", eventName: "pull_request" },
    { ref: "refs/tags/v0.1.2", eventName: "push" },
  ])("skips non-release event $eventName on $ref without credentials or network", async (event) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await planDesktopRelease({ ...base, ...event, token: "", fetchImpl })).toMatchObject({ publish: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("manual runs obey the same version upgrade gate", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ tag_name: "v0.1.2" }));
    expect(await planDesktopRelease({ ...base, eventName: "workflow_dispatch", fetchImpl })).toMatchObject({ publish: false });
  });

  it.each(["0.1.2-beta.1", "01.1.2", "invalid"])("rejects invalid stable version %s before network access", async (version) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(planDesktopRelease({ ...base, version, fetchImpl })).rejects.toThrow(/stable version/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([403, 500])("fails closed for HTTP %s instead of assuming no previous release", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status }));
    await expect(planDesktopRelease({ ...base, fetchImpl })).rejects.toThrow(`HTTP ${String(status)}`);
  });

  it("rejects an unrecognized Latest tag rather than overwriting it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ tag_name: "nightly" }));
    await expect(planDesktopRelease({ ...base, fetchImpl })).rejects.toThrow(/stable version/);
  });

  it.each(["unchanged", "upgraded", "pull-request", "lock-mismatch"])("exports the %s plan through the actual Actions entry point", async (scenario) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-release-plan-"));
    try {
      const output = path.join(root, "output");
      const preload = path.join(root, "github.mjs");
      const version = scenario === "upgraded" ? "0.1.2" : "0.1.1";
      await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
      await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
        version, packages: { "": { version: scenario === "lock-mismatch" ? "0.1.0" : version } },
      }));
      await writeFile(preload, scenario === "pull-request"
        ? 'globalThis.fetch = () => { throw new Error("Network must not be used for a PR"); };'
        : 'globalThis.fetch = async () => Response.json({ tag_name: "v0.1.1" });');
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.resolve("scripts/plan-desktop-release.mjs")], {
        cwd: root, encoding: "utf8", env: {
          ...process.env, GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "example/joi",
          GITHUB_EVENT_NAME: scenario === "pull-request" ? "pull_request" : "push", GITHUB_TOKEN: "fixture", GITHUB_OUTPUT: output,
        },
      });
      if (scenario === "lock-mismatch") {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("package and lock versions must match");
        await expect(readFile(output)).rejects.toThrow(/ENOENT/);
      } else {
        expect(result.status).toBe(0);
        expect(await readFile(output, "utf8")).toBe(`publish=${String(scenario === "upgraded")}\n`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
