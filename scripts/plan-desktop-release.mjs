import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function stableVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("Desktop release requires a stable version in major.minor.patch format.");
  }
  return value.split(".").map(BigInt);
}

export async function planDesktopRelease({
  version, repository, token, ref, eventName, fetchImpl = fetch,
}) {
  if (ref !== "refs/heads/main" || !["push", "workflow_dispatch"].includes(eventName)) {
    return { publish: false };
  }
  const candidate = stableVersion(version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !token) {
    throw new Error("Desktop release planning requires a repository and GitHub token.");
  }
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return { publish: true };
  if (!response.ok) throw new Error(`GitHub release planning failed (HTTP ${response.status}).`);
  const latest = await response.json();
  const published = stableVersion(latest.tag_name?.replace(/^v/, ""));
  const different = candidate.findIndex((part, index) => part !== published[index]);
  return {
    publish: different !== -1 && candidate[different] > published[different],
    previousTag: latest.tag_name, url: latest.html_url,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { GITHUB_REF: ref, GITHUB_EVENT_NAME: eventName } = process.env;
    let version;
    if (ref === "refs/heads/main" && ["push", "workflow_dispatch"].includes(eventName)) {
      const manifest = JSON.parse(await readFile("package.json", "utf8"));
      const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
      version = manifest.version;
      if (lock.version !== version || lock.packages?.[""]?.version !== version) {
        throw new Error("Desktop release package and lock versions must match.");
      }
    }
    const plan = await planDesktopRelease({
      version, repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, ref, eventName,
    });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${plan.publish}\n`);
    console.log(plan.publish ? `Desktop release planned: v${version}` : "Desktop release skipped: no eligible version upgrade.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Desktop release planning failed.");
    process.exitCode = 1;
  }
}
