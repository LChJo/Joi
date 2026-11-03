import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeCheckpointAvailable } from "../../src/main/infrastructure/mana/native-checkpoint-store.js";

describe("AC-WR-05 private native checkpoints", () => {
  it.each(["claude", "codex"] as const)("requires a readable durable %s session before WRITE admission", async protocol => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-checkpoint-"));
    const environment = { CLAUDE_CONFIG_DIR: root, CODEX_HOME: root };
    try {
      const ref = `native-agent:v1:${protocol}:fixture-session`;
      expect(await nativeCheckpointAvailable(protocol, ref, environment)).toBe(false);
      const directory = path.join(root, protocol === "claude" ? "projects" : "sessions", "nested");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, protocol === "claude" ? "fixture-session.jsonl" : "rollout-fixture-session.jsonl");
      await writeFile(file, "");
      expect(await nativeCheckpointAvailable(protocol, ref, environment)).toBe(false);
      await writeFile(file, '{"type":"fixture"}\n');
      expect(await nativeCheckpointAvailable(protocol, ref, environment)).toBe(true);
      expect(await nativeCheckpointAvailable(protocol, `native-agent:v1:${protocol}:../fixture-session`, environment)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
