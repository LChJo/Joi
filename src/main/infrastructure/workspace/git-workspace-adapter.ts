import { simpleGit } from "simple-git";
import { isUtf8 } from "node:buffer";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../../domain/errors.js";
import { sanitizeAgentConversationText } from "../../application/partners/agent-conversation-presentation.js";
import type { ConversationWorkspacePort } from "../../application/ports/conversation-workspace.js";
import type { WorkbenchArtifactOpener } from "../../application/ports/workbench-artifacts.js";
import type { ConversationWorkspaceFileDto, ConversationWorkspaceOpenMode, GitCommandInput, GitWorkspaceDto } from "../../../shared/conversations.js";

const MAX_TEXT_PREVIEW_BYTES = 512_000;

function safePreview(value: string): string {
  return sanitizeAgentConversationText(value)
    .replace(/(["']?[\w.-]*(?:token|api[_-]?key|password|secret|cookie|csrf|authorization)[\w.-]*["']?\s*[:=]\s*)(["'])([^\r\n]*?)\2/giu, "$1$2[redacted]$2")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,"[redacted private key]")
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/giu,"https://[redacted]@");
}

export class GitWorkspaceAdapter implements ConversationWorkspacePort {
  constructor(private readonly roots: { root(workbenchId: string): Promise<string> }, private readonly opener?: WorkbenchArtifactOpener) {}
  async #git(workbenchId: string,signal?: AbortSignal) {
    const root = await realpath(await this.roots.root(workbenchId));
    return simpleGit({ baseDir: root,maxConcurrentProcesses: 1,timeout: { block: 60_000 },...(signal === undefined ? {} : { abort: signal }) });
  }
  async #path(workbenchId: string, relative: string, allowRoot = false): Promise<string> {
    if ((!allowRoot && relative === "") || relative.includes("\0") || relative.includes(":") || /^[\\/]/u.test(relative)
      || relative.split(/[\\/]/u).some(s => s === ".." || s.toLowerCase() === ".git")) throw new DomainError("workspace_path_invalid", "Choose a file within this workspace.");
    const root = await realpath(await this.roots.root(workbenchId));
    const target = path.resolve(root,relative || ".");
    const resolved = await realpath(target).catch(async () => path.join(await realpath(path.dirname(target)),path.basename(target)));
    const resolvedRelative = path.relative(root,resolved);
    if (path.isAbsolute(resolvedRelative) || resolvedRelative.split(path.sep).some(segment => segment === ".." || segment.toLowerCase() === ".git")) {
      throw new DomainError("workspace_path_invalid", "Choose a file within this workspace.");
    }
    return resolved;
  }
  async #workspaceFile(workbenchId: string, relativePath: string) {
    try {
      const targetPath = await this.#path(workbenchId,relativePath);
      const info = await lstat(targetPath);
      if (info.isFile()) return { targetPath,size: info.size };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
    }
    throw new DomainError("workspace_file_not_found", "The file is no longer available in this workspace.");
  }
  async status(workbenchId: string): Promise<GitWorkspaceDto> {
    try {
      const git = await this.#git(workbenchId);
      if (!await git.checkIsRepo()) return { available: false,reasonCode: "git_not_repository",branch: "",branches: [],ahead: 0,behind: 0,files: [],history: [] };
      const s = await git.status();
      const b = await git.branchLocal();
      const history = await git.log({ maxCount: 30 }).catch(() => ({ all: [] }));
      return { available: true,branch: s.current ?? "",branches: b.all,ahead: s.ahead,behind: s.behind,
        files: s.files.slice(0,500).map(f => ({ path: f.path,index: f.index,workingTree: f.working_dir })),
        history: history.all.map(h => ({ hash: h.hash,message: sanitizeAgentConversationText(h.message),date: h.date })) };
    } catch { return { available: false,reasonCode: "git_unavailable",branch: "",branches: [],ahead: 0,behind: 0,files: [],history: [] }; }
  }
  async diff(workbenchId: string, relativePath: string, staged: boolean) {
    await this.#path(workbenchId,relativePath);
    const git = await this.#git(workbenchId);
    let patch = await git.raw(["--literal-pathspecs","diff","--no-ext-diff","--no-textconv",...(staged ? ["--cached"] : []),"--",relativePath]);
    if (patch === "" && !staged) {
      const target = await this.#path(workbenchId,relativePath);
      const meta = await stat(target).catch(() => null);
      if (meta?.isFile() === true && meta.size <= 256_000 && (await git.status()).not_added.includes(relativePath)) {
        const body = await readFile(target,"utf8");
        if (!body.includes("\0")) patch = `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${String(body.split("\n").length)} @@\n${body.split("\n").map(l => `+${l}`).join("\n")}\n`;
      }
    }
    return { patch: safePreview(patch.slice(0,512_000)),truncated: patch.length > 512_000 };
  }
  async files(workbenchId: string, directory: string) {
    const root = await realpath(await this.roots.root(workbenchId));
    const target = await this.#path(workbenchId,directory,true);
    const entries = await readdir(target,{ withFileTypes: true });
    return { items: entries.filter(e => e.name !== ".git" && !e.isSymbolicLink()).sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0,500)
      .map(e => ({ path: path.relative(root,path.join(target,e.name)).split(path.sep).join("/"),directory: e.isDirectory() })) };
  }
  async file(workbenchId: string, relativePath: string): Promise<ConversationWorkspaceFileDto> {
    const { targetPath,size } = await this.#workspaceFile(workbenchId,relativePath);
    if (size > MAX_TEXT_PREVIEW_BYTES) return { text: "",truncated: false,unavailable: "TOO_LARGE" };
    const bytes = await readFile(targetPath);
    if (bytes.length > MAX_TEXT_PREVIEW_BYTES) return { text: "",truncated: false,unavailable: "TOO_LARGE" };
    if (bytes.includes(0) || !isUtf8(bytes)) return { text: "",truncated: false,unavailable: "BINARY" };
    return { text: safePreview(bytes.toString("utf8")),truncated: false };
  }
  async open(workbenchId: string, relativePath: string, mode: ConversationWorkspaceOpenMode): Promise<void> {
    if (this.opener === undefined) throw new DomainError("conversation_workspace_unavailable", "Workspace unavailable.");
    const { targetPath } = await this.#workspaceFile(workbenchId,relativePath);
    await this.opener.open({ kind: "FILE",mode,targetPath });
  }
  async execute(workbenchId: string, input: GitCommandInput,signal?: AbortSignal): Promise<void> {
    const git = await this.#git(workbenchId,signal);
    if (!await git.checkIsRepo()) throw new DomainError("git_not_repository", "The workspace is not a Git repository.");
    if (input.action === "STAGE" || input.action === "UNSTAGE") {
      const paths = input.paths ?? [];
      if (paths.length > 500) throw new DomainError("workspace_path_invalid", "Too many selected paths.");
      for (const item of paths) await this.#path(workbenchId,item);
      if (input.action === "STAGE") await git.raw(["--literal-pathspecs","add",...(paths.length === 0 ? ["--all"] : []),"--",...(paths.length === 0 ? ["."] : paths)]);
      else if (await git.revparse(["--verify","HEAD"]).then(() => true,() => false)) await git.raw(["--literal-pathspecs","reset","HEAD","--",...(paths.length === 0 ? ["."] : paths)]);
      else await git.raw(["--literal-pathspecs","rm","--cached","--recursive","--ignore-unmatch","--",...(paths.length === 0 ? ["."] : paths)]);
    } else if (input.action === "COMMIT") {
      if (typeof input.message !== "string" || input.message.trim() === "" || input.message.length > 4_000) throw new DomainError("git_message_invalid", "Enter a commit message.");
      if ((await git.diff(["--cached","--name-only"])).trim() === "") throw new DomainError("git_nothing_staged", "Stage changes before committing.");
      await git.raw(["commit","-m",input.message]);
    } else if (input.action === "SWITCH" || input.action === "BRANCH") {
      const branch = input.branch ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,159}$/u.test(branch) || branch.includes("..") || branch.endsWith("/")) throw new DomainError("git_branch_invalid", "Enter a valid local branch name.");
      await git.raw(["check-ref-format","--branch",branch]);
      if (input.action === "SWITCH" && !(await git.branchLocal()).all.includes(branch)) throw new DomainError("git_branch_invalid", "Select an existing local branch.");
      await git.raw(["switch",...(input.action === "BRANCH" ? ["--create"] : []),branch]);
    } else if (input.action === "FETCH") await git.raw(["fetch","--all"]);
    else if (input.action === "PULL") await git.raw(["pull","--ff-only"]);
    else await git.raw(["push"]);
  }
}
