import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseNativeAgentSessionRef } from "../../application/partners/native-agent-session-reference.js";

/** Native history stays in its engine's private store; no content or path is projected. */
export async function nativeCheckpointAvailable(protocol: "claude" | "codex", reference: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const id = parseNativeAgentSessionRef(reference, protocol);
  if (id === undefined || !/^[a-z0-9_-]{1,128}$/iu.test(id)) return false;
  const home = process.platform === "win32" ? environment.USERPROFILE ?? environment.HOME ?? os.homedir() : environment.HOME ?? os.homedir();
  const root = protocol === "claude" ? path.join(environment.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects")
    : path.join(environment.CODEX_HOME ?? path.join(home, ".codex"), "sessions");
  const pending = [root];
  try {
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) return false;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile() && (protocol === "claude" ? entry.name === `${id}.jsonl` : entry.name.endsWith(`-${id}.jsonl`))) {
          if ((await stat(file)).size === 0) return false;
          await access(file, constants.R_OK);
          return true;
        }
      }
    }
  } catch { return false; }
  return false;
}
