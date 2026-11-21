export const stableDesktopVersion = /^(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})$/;
export const JOI_RELEASES_URL = "https://github.com/LChJo/Joi/releases";
export const JOI_RELEASE_WINDOW = "joi-release";

export function isJoiReleaseUrl(value: string): boolean {
  const prefix = `${JOI_RELEASES_URL}/tag/v`;
  return value.startsWith(prefix) && stableDesktopVersion.test(value.slice(prefix.length));
}

export type DesktopUpdateCommand =
  | { action: "check" }
  | { action: "download" | "install"; version: string };

export interface DesktopUpdateStatus {
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  mode: "disabled" | "manual" | "open" | "restart";
  phase: "idle" | "checking" | "unpublished" | "current" | "available" | "downloading" | "ready" | "installing";
  error?: "checkFailed" | "downloadFailed" | "installFailed";
  progress?: { bytes: number; totalBytes?: number };
}
