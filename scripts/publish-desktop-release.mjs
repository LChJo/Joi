import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function publishDesktopRelease({
  directory, version, repository, sha, token, fetchImpl = fetch,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[\w.-]+\/[\w.-]+$/.test(repository)
    || !/^[a-f0-9]{40}$/.test(sha) || !token) {
    throw new Error("Release requires a stable version, repository, commit SHA and GitHub token.");
  }
  const base = `https://api.github.com/repos/${repository}`;
  const tag = `v${version}`;
  async function request(url, { method = "GET", json, bytes, missing = false } = {}) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        ...(json ? { "Content-Type": "application/json" } : {}),
        ...(bytes ? { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) } : {}),
      },
      body: bytes ?? (json ? JSON.stringify(json) : undefined),
      signal: AbortSignal.timeout(300_000),
    });
    if (missing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub release ${method} failed (HTTP ${response.status}).`);
    return response.status === 204 ? undefined : response.json();
  }

  let release = await request(`${base}/releases/tags/${tag}`, { missing: true });
  // Pending draft tags need the authenticated release listing rather than the published-tag endpoint.
  for (let page = 1; !release; page += 1) {
    const releases = await request(`${base}/releases?per_page=100&page=${page}`);
    release = releases.find(candidate => candidate.tag_name === tag);
    if (releases.length < 100) break;
  }
  // Published versions remain immutable across later commits and workflow reruns.
  if (release && !release.draft) return { skipped: true, url: release.html_url };
  if (release && release.target_commitish !== sha) throw new Error("Release draft belongs to a different commit.");
  const ref = await request(`${base}/git/ref/tags/${tag}`, { missing: true });
  if (ref && (ref.object.type !== "commit" || ref.object.sha !== sha)) {
    throw new Error("Release tag already points to a different commit.");
  }

  const names = (await readdir(directory)).filter(name => /\.(exe|dmg)$/.test(name)).sort();
  const prefix = `joi-${version}-`;
  if (names.length !== 2 || !names.every(name => name.startsWith(prefix))
    || names.filter(name => name.endsWith(".exe")).length !== 1
    || names.filter(name => name.endsWith(".dmg")).length !== 1) {
    throw new Error("Release requires exactly one Windows EXE and one macOS DMG for the package version.");
  }
  const checksums = [];
  for (const name of names) {
    const bytes = await readFile(path.join(directory, name));
    if (bytes.length === 0) throw new Error("Release installer must not be empty.");
    checksums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
  }
  await writeFile(path.join(directory, "SHA256SUMS.txt"), checksums.join(""));
  names.push("SHA256SUMS.txt");

  if (!release) {
    release = await request(`${base}/releases`, {
      method: "POST",
      json: {
        tag_name: tag, target_commitish: sha, name: `joi ${version}`, draft: true,
        body: "Windows NSIS (.exe) and macOS (.dmg) installers built after both platform quality gates passed.\n\n"
          + "SHA-256 checksums: SHA256SUMS.txt.\n\n"
          + "Windows installer is unsigned. macOS app is ad-hoc signed and is not notarized.\n\n"
          + `Source commit: ${sha}`,
      },
    });
  }
  for (const name of names) {
    // Only unpublished draft assets may be replaced when resuming an interrupted upload.
    for (const asset of release.assets ?? []) {
      if (asset.name === name) await request(`${base}/releases/assets/${asset.id}`, { method: "DELETE" });
    }
    const bytes = await readFile(path.join(directory, name));
    const asset = await request(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: "POST", bytes,
    });
    if (asset.name !== name || asset.size !== bytes.length || asset.state !== "uploaded") {
      throw new Error("Release asset upload was not confirmed.");
    }
  }
  const published = await request(`${base}/releases/${release.id}`, {
    method: "PATCH", json: { draft: false, make_latest: "true" },
  });
  return { skipped: false, url: published.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { version } = JSON.parse(await readFile("package.json", "utf8"));
    const result = await publishDesktopRelease({
      directory: path.resolve("release-assets"), version,
      repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA,
      token: process.env.GITHUB_TOKEN,
    });
    console.log(`${result.skipped ? "Existing release preserved" : "Published"}: ${result.url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Desktop release publication failed.");
    process.exitCode = 1;
  }
}
