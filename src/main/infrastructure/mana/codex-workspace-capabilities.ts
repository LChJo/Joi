import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DomainError } from "../../domain/errors.js";

const execute = promisify(execFile);
const verified = new Map<string, number>();
type CapabilityCommand = (executable: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string>;
const runCommand: CapabilityCommand = async (executable, args, options = {}) => {
  const result = await execute(executable, args, { ...options, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 512_000 });
  return result.stdout;
};

/** A CLI must both advertise the protocol and enforce a read-only filesystem before admission. */
export async function assertCodexWorkspaceProtocol(executable: string, run: CapabilityCommand = runCommand): Promise<void> {
  let root: string | undefined;
  try {
    const modifiedAt = run === runCommand ? (await stat(executable)).mtimeMs : 0;
    if (run === runCommand && verified.get(executable) === modifiedAt) return;
    const [help, resume, sandboxHelp] = await Promise.all([
      run(executable, ["exec", "--help"]), run(executable, ["exec", "resume", "--help"]), run(executable, ["sandbox", "--help"]),
    ]);
    if (!["--sandbox", "read-only", "workspace-write", "--output-schema", "--json"].every(flag => help.includes(flag)) || !resume.includes("--json")) {
      throw new Error("unsupported_cli_protocol");
    }
    root = await mkdtemp(path.join(os.tmpdir(), "joi-codex-capability-"));
    const workspace = path.join(root, "workspace");
    const configuration = path.join(root, "config");
    await mkdir(workspace); await mkdir(configuration);
    await writeFile(path.join(workspace, "input.txt"), "fixture");
    const environment: NodeJS.ProcessEnv = { CODEX_HOME: configuration, ELECTRON_RUN_AS_NODE: "1" };
    for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "PATHEXT"]) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    const probe = 'const fs=require("node:fs");if(fs.readFileSync("input.txt","utf8")!=="fixture")process.exit(2);try{fs.writeFileSync("marker.txt","violation");console.log("violation")}catch{console.log("verified")}';
    const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    if (!sandboxHelp.includes("--permission-profile") && !sandboxHelp.includes(platform)) throw new Error("unsupported_sandbox_protocol");
    const args = sandboxHelp.includes("--permission-profile") ? ["sandbox", "-P", ":read-only", "-C", workspace, "--", process.execPath, "-e", probe]
      : ["sandbox", platform, "-c", 'sandbox_mode="read-only"', "--", process.execPath, "-e", probe];
    const output = await run(executable, args, { cwd: workspace, env: environment });
    if (output.trim() !== "verified" || await stat(path.join(workspace, "marker.txt")).then(() => true, () => false)) throw new Error("sandbox_not_read_only");
    if (run === runCommand) verified.set(executable, modifiedAt);
  } catch {
    throw new DomainError("codex_workspace_protocol_unsupported", "This Codex CLI cannot enforce the required read-only and continuation protocol.");
  } finally {
    if (root !== undefined && path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}joi-codex-capability-`)) await rm(root, { recursive: true, force: true });
  }
}
