import { lstat, readdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type { PartnerRunOutput } from "../../application/ports/partner-execution.js";
import { workspaceArtifactReference } from "../../domain/work/workspace-artifact-reference.js";

interface WorkspaceFileState {
  kind: "DIRECTORY" | "FILE";
  mtimeMs: number;
  size: number;
}

export type WorkspaceSnapshot = ReadonlyMap<string, WorkspaceFileState>;
const snapshotCoverage = new WeakMap<WorkspaceSnapshot, { root: string | undefined; unreadable: Set<string> }>();

/**
 * Tooling and dependency trees are outside the deliverable set at every depth.
 */
function isIgnoredDirectory(name: string): boolean {
  return name === "node_modules" || name === "__pycache__" || name.startsWith(".");
}

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

/**
 * A serial walk leaves the disk idle between every round-trip, which dominates a snapshot on a
 * large bound repository. The traversal is bounded rather than unlimited so a wide tree cannot
 * exhaust file handles.
 */
const WALK_CONCURRENCY = 64;

/** Hands out a fixed number of slots so only that many filesystem operations are in flight. */
class WalkLimiter {
  #available: number;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#available = limit;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#available === 0) {
      await new Promise<void>((resolve) => { this.#waiting.push(resolve); });
    } else {
      this.#available -= 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#available += 1;
      else next();
    }
  }
}

async function walk(root: string, directory: string, files: Map<string, WorkspaceFileState>, limiter: WalkLimiter, unreadable: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await limiter.run(() => readdir(directory, { withFileTypes: true }));
  } catch {
    unreadable.add(path.relative(root, directory).replaceAll(path.sep, "/"));
    return;
  }
  const pending: Promise<void>[] = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDirectory(entry.name)) continue;
      pending.push((async () => {
        try {
          const facts = await limiter.run(() => lstat(candidate));
          const relativePath = path.relative(root, candidate).replaceAll(path.sep, "/");
          if (relativePath !== "") files.set(relativePath, { kind: "DIRECTORY", mtimeMs: facts.mtimeMs, size: 0 });
        } catch {
          unreadable.add(path.relative(root, candidate).replaceAll(path.sep, "/"));
          return;
        }
        await walk(root, candidate, files, limiter, unreadable);
      })());
      continue;
    }
    if (!entry.isFile() || /\.py[co]$/iu.test(entry.name)) continue;
    pending.push((async () => {
      let facts: Stats;
      try {
        facts = await limiter.run(() => lstat(candidate));
      } catch {
        unreadable.add(path.relative(root, candidate).replaceAll(path.sep, "/"));
        return;
      }
      if (!facts.isFile()) return;
      const relativePath = path.relative(root, candidate).replaceAll(path.sep, "/");
      if (relativePath !== "") files.set(relativePath, { kind: "FILE", mtimeMs: facts.mtimeMs, size: facts.size });
    })());
  }
  await Promise.all(pending);
}

export async function captureWorkspaceSnapshot(workspacePath: string | undefined): Promise<WorkspaceSnapshot> {
  const files = new Map<string, WorkspaceFileState>();
  const coverage = { root: undefined as string | undefined, unreadable: new Set<string>() };
  snapshotCoverage.set(files, coverage);
  if (workspacePath === undefined) return files;
  let root: string;
  try {
    root = await realpath(workspacePath);
    const facts = await stat(root);
    if (!facts.isDirectory()) return files;
  } catch {
    return files;
  }
  coverage.root = root;
  await walk(root, root, files, new WalkLimiter(WALK_CONCURRENCY), coverage.unreadable);
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
  const coverage = snapshotCoverage.get(before);
  if (coverage !== undefined && coverage.root !== root) return [];
  const after = new Map<string, WorkspaceFileState>();
  await walk(root, root, after, new WalkLimiter(WALK_CONCURRENCY), new Set());
  return [...after.entries()]
    .filter(([relativePath, state]) => {
      if (state.kind !== "FILE") return false;
      if (coverage !== undefined && coverage.unreadable.size > 0 && [...coverage.unreadable].some(prefix => prefix === "" || relativePath === prefix || relativePath.startsWith(`${prefix}/`))) return false;
      const previous = before.get(relativePath);
      if (previous === undefined) return true;
      return previous.size !== state.size || previous.mtimeMs !== state.mtimeMs;
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, state]) => {
      const type = mimeType(relativePath);
      return {
        artifactRef: workspaceArtifactReference(relativePath),
        ...(type === undefined ? {} : { mimeType: type }),
        name: path.basename(relativePath),
        size: state.size,
      };
    });
}
