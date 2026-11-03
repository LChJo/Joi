import { DomainError } from "../errors.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const EXECUTABLE_EXTENSIONS = new Set([".app", ".bat", ".cmd", ".com", ".exe", ".js", ".msi", ".ps1", ".scr", ".sh"]);
const EXECUTABLE_MIME = new Set(["application/x-msdownload", "application/x-sh", "application/x-executable"]);

function extension(filename: string): string {
  const position = filename.lastIndexOf(".");
  return position < 0 ? "" : filename.slice(position).toLowerCase();
}

function previewKind(mimeType: string): "csv" | "image" | "json" | "markdown" | "none" | "text" {
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "text/csv") return "csv";
  if (mimeType === "application/json") return "json";
  if (mimeType.startsWith("text/")) return "text";
  if (["image/gif", "image/jpeg", "image/png", "image/webp"].includes(mimeType)) return "image";
  return "none";
}

export class ArtifactPolicy {
  validate(input: { declaredOrigin: string; filename: string; mimeType: string; size: number; url: string }) {
    if (input.filename.includes("..") || /[\\/]/.test(input.filename) || /^[A-Za-z]:/.test(input.filename)) {
      throw new DomainError("artifact_rejected", "Artifact filename contains traversal or an absolute path.");
    }
    const filename = Array.from(input.filename)
      .map((character) => character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? "_" : character)
      .join("")
      .trim();
    if (filename === "" || filename === "." || filename === "..") throw new DomainError("artifact_rejected", "Artifact filename is invalid.");
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new DomainError("artifact_rejected", "Artifact URL is invalid.");
    }
    if (url.origin !== input.declaredOrigin) throw new DomainError("artifact_rejected", "Artifact URL Origin does not match the Agent Origin.");
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_FILE_BYTES) {
      throw new DomainError("artifact_rejected", "Artifact exceeds the 100 MiB automatic download limit.");
    }
    if (EXECUTABLE_EXTENSIONS.has(extension(filename)) || EXECUTABLE_MIME.has(input.mimeType.toLowerCase())) {
      throw new DomainError("artifact_rejected", "Executable Artifacts are not accepted for automatic download.");
    }
    return { filename, mimeType: input.mimeType.toLowerCase(), preview: previewKind(input.mimeType.toLowerCase()), size: input.size, url: url.toString() };
  }
}
