import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { JOI_RELEASES_URL, stableDesktopVersion, type DesktopUpdateCommand, type DesktopUpdateStatus } from "../../../shared/desktop-update.js";

const RELEASES = JOI_RELEASES_URL;
const ASSET_CDN = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const REQUEST_TIMEOUT = 15_000;
const DOWNLOAD_TIMEOUT = 30 * 60_000;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_INSTALLER_BYTES = 2 * 1024 ** 3;

interface UpdateAsset { name: string; version: string; sha256: string }
interface UpdateOptions {
  arch: string;
  currentVersion: string;
  directory: string;
  fetchImpl?: typeof fetch;
  install: (installerPath: string) => Promise<void>;
  mode: "disabled" | "open" | "restart";
}

/** The installer path remains in the desktop process for the lifetime of the staged update. */
export class DesktopUpdater {
  private state: DesktopUpdateStatus;
  private asset?: UpdateAsset | undefined;
  private staged?: { directory: string; installer: string } | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: UpdateOptions) {
    const { currentVersion, mode } = options;
    this.state = { currentVersion, mode: stableDesktopVersion.test(currentVersion) ? mode : "disabled", phase: "idle" };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  status(): DesktopUpdateStatus {
    return this.state;
  }

  command(command: DesktopUpdateCommand): DesktopUpdateStatus {
    const { mode, phase } = this.state;
    if (mode === "disabled" || phase === "checking" || phase === "downloading" || phase === "installing") return this.state;
    if (command.action === "check") {
      if (phase !== "ready") void this.check();
    } else if (this.asset?.version === command.version) {
      if (command.action === "download" && phase === "available") void this.download(this.asset);
      if (command.action === "install" && phase === "ready" && this.staged !== undefined) void this.install(this.asset, this.staged);
    }
    return this.state;
  }

  private async check(): Promise<void> {
    const previous = this.state;
    this.state = { ...previous, phase: "checking" };
    const { currentVersion, mode } = this.options;
    try {
      const response = await this.fetchImpl(`${RELEASES}/latest`, {
        method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      const location = response.headers.get("location");
      const releaseUrl = location === null ? undefined : new URL(location, RELEASES).href;
      if (response.status === 404 || (response.status === 302 && releaseUrl === RELEASES)) {
        this.asset = undefined;
        this.state = { currentVersion, mode, phase: "unpublished" };
        return;
      }
      const prefix = `${RELEASES}/tag/v`;
      const latestVersion = releaseUrl?.startsWith(prefix) === true ? releaseUrl.slice(prefix.length) : "";
      if (response.status !== 302 || !stableDesktopVersion.test(latestVersion)) throw new Error("invalid_latest_release");
      if (compareVersions(latestVersion, currentVersion) <= 0) {
        this.asset = undefined;
        this.state = { currentVersion, mode, phase: "current" };
        return;
      }

      const manifest = await this.fetchAsset(latestVersion, "SHA256SUMS.txt", REQUEST_TIMEOUT);
      const chunks: Uint8Array[] = [];
      for await (const chunk of responseChunks(manifest, MAX_MANIFEST_BYTES)) chunks.push(chunk);
      const filename = `joi-${latestVersion}-${mode === "restart" ? `win-${this.options.arch}.exe` : `mac-${this.options.arch}.dmg`}`;
      const entries = Buffer.concat(chunks).toString("utf8").split(/\r?\n/).map((line) => /^([a-f\d]{64})[ \t]+\*?(\S+)$/i.exec(line));
      const matches = entries.filter((entry) => entry?.[2] === filename);
      if (matches.length > 1 || !entries.some((entry) => entry !== null)) throw new Error("invalid_release_checksums");
      const sha256 = matches[0]?.[1]?.toLowerCase();
      this.asset = sha256 === undefined ? undefined : { name: filename, version: latestVersion, sha256 };
      this.state = { currentVersion, latestVersion, releaseUrl: `${prefix}${latestVersion}`, mode: this.asset === undefined ? "manual" : mode, phase: "available" };
    } catch {
      this.state = { ...previous, error: "checkFailed" };
    }
  }

  private async fetchAsset(version: string, filename: string, timeout: number): Promise<Response> {
    const signal = AbortSignal.timeout(timeout);
    const url = `${RELEASES}/download/v${version}/${filename}`;
    let response = await this.fetchImpl(url, { redirect: "manual", signal });
    if (response.status === 302) {
      const target = new URL(response.headers.get("location") ?? "", url);
      await response.body?.cancel();
      if (target.protocol !== "https:" || target.port !== "" || target.username !== "" || target.password !== ""
        || !ASSET_CDN.has(target.hostname)) throw new Error("invalid_asset_redirect");
      response = await this.fetchImpl(target, { redirect: "manual", signal });
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("asset_unavailable");
    }
    return response;
  }

  private async download(asset: UpdateAsset): Promise<void> {
    const previous = { ...this.state };
    delete previous.error;
    this.state = { ...previous, phase: "downloading", progress: { bytes: 0 } };
    let directory: string | undefined;
    try {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(path.join(this.options.directory, "stage-"));
      const installer = path.join(directory, asset.name);
      const response = await this.fetchAsset(asset.version, asset.name, DOWNLOAD_TIMEOUT);
      const length = Number(response.headers.get("content-length"));
      const totalBytes = Number.isSafeInteger(length) && length > 0 ? length : undefined;
      const hash = createHash("sha256");
      let bytes = 0;
      const progress = (chunk: Uint8Array) => {
        hash.update(chunk);
        bytes += chunk.byteLength;
        this.state = { ...previous, phase: "downloading", progress: { bytes, ...(totalBytes === undefined ? {} : { totalBytes }) } };
      };
      await pipeline(responseChunks(response, MAX_INSTALLER_BYTES, progress), createWriteStream(installer, { flags: "wx", mode: 0o600 }));
      if (bytes === 0 || hash.digest("hex") !== asset.sha256) throw new Error("invalid_installer_checksum");
      this.staged = { directory, installer };
      this.state = { ...previous, phase: "ready" };
    } catch {
      if (directory !== undefined) await removeStage(directory);
      this.state = { ...previous, error: "downloadFailed" };
    }
  }

  private async install(asset: UpdateAsset, staged: NonNullable<DesktopUpdater["staged"]>): Promise<void> {
    const previous = { ...this.state };
    delete previous.error;
    this.state = { ...previous, phase: "installing" };
    try {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(staged.installer)) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== asset.sha256) throw new Error("invalid_installer_checksum");
    } catch {
      await removeStage(staged.directory);
      this.staged = undefined;
      this.state = { ...previous, error: "downloadFailed", phase: "available" };
      return;
    }
    try {
      await this.options.install(staged.installer);
      if (previous.mode === "open") this.state = { ...previous, phase: "ready" };
    } catch {
      this.state = { ...previous, error: "installFailed" };
    }
  }
}

function compareVersions(left: string, right: string): number {
  const parts = right.split(".").map(Number);
  for (const [index, segment] of left.split(".").entries()) {
    const difference = Number(segment) - (parts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function* responseChunks(response: Response, limit: number, progress?: (chunk: Uint8Array) => void): AsyncGenerator<Uint8Array> {
  if (response.body === null) throw new Error("missing_asset_body");
  const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader();
  let bytes = 0;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("asset_too_large");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!(value instanceof Uint8Array)) throw new Error("invalid_asset_chunk");
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("asset_too_large");
      progress?.(value);
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function removeStage(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
