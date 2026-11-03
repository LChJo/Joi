import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/**
 * Confines a partner run's file writes to its workspace.
 *
 * Until this existed, the workspace scope was prompt governance rather than tool enforcement: the
 * `write` and `edit` tools carried no path check at all, and the system prompt explicitly invited
 * writing outside — "you may also read and write paths outside the workspace". So a partner that
 * had been granted write tools could write anywhere joi's process could, with nothing but a
 * sentence in a prompt in the way. Of the three engines, pi was the only one with no boundary
 * beneath the prompt: Codex has an OS-level sandbox, and the Claude CLI has its own.
 *
 * The check sits in the tools' file operations rather than in argument inspection, because the
 * operations receive the path pi itself already resolved. Re-deriving the resolution here would
 * mean reproducing its `~` expansion and its relative-to-cwd rule, and any divergence between the
 * two — a spelling pi resolves outward that this resolves inward — would be a hole rather than a
 * false refusal. Enforcing one layer below the parser leaves nothing to diverge from.
 *
 * Reads are deliberately not confined. The task legitimately needs them — installed skills, user
 * configuration, reference trees — and reading is not what this is protecting. Refusing a write does
 * not silently degrade: the tool throws, and pi turns that into an error result the model reads, so
 * it learns the boundary from the boundary rather than from a promise in its instructions.
 */

/** Why a write was refused, phrased for the model that attempted it. */
export class WorkspaceBoundaryError extends Error {
  constructor(readonly attempted: string, readonly workspace: string) {
    super(`Refused: ${attempted} is outside the assigned workspace. Writes are confined to ${workspace}; `
      + "reading outside it is allowed. If the task needs a write elsewhere, say so instead of retrying this path.");
    this.name = "WorkspaceBoundaryError";
  }
}

/**
 * Whether a path resolves inside the workspace, following symlinks.
 *
 * The deepest existing ancestor is canonicalized rather than the whole path, because the target of
 * a write usually does not exist yet. That is what makes a symlinked directory a real escape
 * rather than a theoretical one: `<workspace>/link/new.txt` looks contained as a string and lands
 * wherever `link` points, so containment is decided after the filesystem has resolved it.
 */
export async function isWithinWorkspace(root: string, candidate: string): Promise<boolean> {
  let existing = candidate;
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      // Reached the filesystem root without finding anything that exists.
      if (parent === existing) return false;
      existing = parent;
    }
  }
  const relative = path.relative(root, existing);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The subset of pi's operation interfaces this guards; the rest are reads and pass through. */
export interface GuardedWriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
}

export function guardedWriteFile(root: string): GuardedWriteOperations["writeFile"] {
  return async (absolutePath, content) => {
    if (!await isWithinWorkspace(root, absolutePath)) throw new WorkspaceBoundaryError(absolutePath, root);
    await writeFile(absolutePath, content, "utf-8");
  };
}

/**
 * The `write` tool's operations, matching pi's local-filesystem defaults apart from the boundary.
 * `mkdir` is guarded too: creating a directory tree outside the workspace is the same escape by a
 * slower route, and it is the one pi calls on its own initiative to place a file.
 */
export const guardedWriteOperations = (root: string) => ({
  mkdir: async (directory: string): Promise<void> => {
    if (!await isWithinWorkspace(root, directory)) throw new WorkspaceBoundaryError(directory, root);
    await mkdir(directory, { recursive: true });
  },
  writeFile: guardedWriteFile(root),
});

/**
 * The `edit` tool's operations. Only `writeFile` is guarded: `readFile` and `access` are how the
 * tool finds the text to replace, and refusing them would break edits to files the run may
 * legitimately read without protecting anything.
 */
export const guardedEditOperations = (root: string) => ({
  access: async (absolutePath: string): Promise<void> => {
    await access(absolutePath, constants.R_OK | constants.W_OK);
  },
  readFile: async (absolutePath: string): Promise<Buffer> => await readFile(absolutePath),
  writeFile: guardedWriteFile(root),
});
