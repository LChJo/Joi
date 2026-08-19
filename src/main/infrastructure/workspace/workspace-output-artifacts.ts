import { lstat, readdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type { PartnerRunOutput } from "../../application/ports/partner-execution.js";

interface WorkspaceFileState {
  mtimeMs: number;
  size: number;
}

export type WorkspaceSnapshot = ReadonlyMap<string, WorkspaceFileState>;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".txt": "text/plain",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

function mimeType(filename: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()];
}

async function walk(root: string, directory: string, files: Map<string, WorkspaceFileState>): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, candidate, files);
      continue;
    }
    if (!entry.isFile()) continue;
    let facts: Stats;
    try {
      facts = await lstat(candidate);
    } catch {
      continue;
    }
    if (!facts.isFile()) continue;
    const relativePath = path.relative(root, candidate).replaceAll(path.sep, "/");
    if (relativePath !== "") files.set(relativePath, { mtimeMs: facts.mtimeMs, size: facts.size });
  }
}

export async function captureWorkspaceSnapshot(workspacePath: string | undefined): Promise<WorkspaceSnapshot> {
  if (workspacePath === undefined) return new Map();
  let root: string;
  try {
    root = await realpath(workspacePath);
    const facts = await stat(root);
    if (!facts.isDirectory()) return new Map();
  } catch {
    return new Map();
  }
  const files = new Map<string, WorkspaceFileState>();
  await walk(root, root, files);
  return files;
}

export async function collectChangedWorkspaceArtifacts(
  workspacePath: string | undefined,
  before: WorkspaceSnapshot,
): Promise<PartnerRunOutput["artifacts"]> {
  if (workspacePath === undefined) return [];
  let root: string;
  try {
    root = await realpath(workspacePath);
    const facts = await stat(root);
    if (!facts.isDirectory()) return [];
  } catch {
    return [];
  }
  const after = new Map<string, WorkspaceFileState>();
  await walk(root, root, after);
  return [...after.entries()]
    .filter(([relativePath, state]) => {
      const previous = before.get(relativePath);
      if (previous === undefined) return true;
      return previous.size !== state.size || previous.mtimeMs !== state.mtimeMs;
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, state]) => {
      const type = mimeType(relativePath);
      return {
        ...(type === undefined ? {} : { mimeType: type }),
        name: path.basename(relativePath),
        size: state.size,
      };
    });
}
