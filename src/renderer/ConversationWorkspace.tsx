import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowSquareOutIcon, FileTextIcon, FolderIcon, GitBranchIcon, GitCommitIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { parse } from "diff2html";
import { LineType } from "diff2html/lib/types";
import type { ConversationDto, GitCommandDto, GitCommandInput, GitWorkspaceDto, GitFileDto } from "../shared/conversations";
import { ApiError, type DigitalLifeApi } from "./api";
import { t, useI18n } from "./i18n";
import { randomUuid } from "./random-uuid";

type Tab = "changes" | "git" | "browser" | "files";
function GitFileGroup({ files,staged,disabled,onDiff,onRun }: { files: GitFileDto[];staged: boolean;disabled: boolean;onDiff: (path: string,staged: boolean) => Promise<void>;onRun: (input: Omit<GitCommandInput,"requestId">) => Promise<void> }) {
  const selected = files.filter(f => staged ? f.index.trim() !== "" && f.index !== "?" : f.workingTree.trim() !== "" || f.index === "?");
  if (selected.length === 0) return null;
  return <div className="chat-git-file-group"><h3>{staged ? t("chat.staged") : t("chat.unstaged")} <small>{selected.length}</small></h3>{selected.map(f => <div className="chat-git-file" key={f.path}><button onClick={() => void onDiff(f.path,staged)} type="button"><FileTextIcon /><span>{f.path}</span><small>{staged ? f.index : f.workingTree}</small></button><button aria-label={`${staged ? t("chat.unstage") : t("chat.stage")} ${f.path}`} disabled={disabled} onClick={() => void onRun({ action: staged ? "UNSTAGE" : "STAGE",paths: [f.path] })} type="button">{staged ? <MinusIcon /> : <PlusIcon />}</button></div>)}</div>;
}
function DiffView({ patch,sideBySide }: { patch: string;sideBySide: boolean }) {
  const files = useMemo(() => { try { return parse(patch); } catch { return []; } },[patch]);
  if (files.length === 0) return <p className="chat-empty-note">{t("chat.noDiff")}</p>;
  return <div className={`chat-diff ${sideBySide ? "side-by-side" : "unified"}`}>{files.map((file,index) => <section key={index}><strong>{file.newName}</strong>{file.blocks.map((block,i) => <div key={i}><pre className="chat-diff-header">{block.header}</pre>{sideBySide ? <div className="chat-diff-columns">{["old","new"].map(side => <table key={side}><tbody>{block.lines.filter(line => side === "old" ? line.type !== LineType.INSERT : line.type !== LineType.DELETE).map((line,j) => <tr className={`diff-${line.type}`} key={j}><td>{side === "old" ? line.oldNumber : line.newNumber}</td><td><pre>{line.content}</pre></td></tr>)}</tbody></table>)}</div> : <table><tbody>{block.lines.map((line,j) => <tr className={`diff-${line.type}`} key={j}><td>{line.oldNumber}</td><td>{line.newNumber}</td><td><pre>{line.content}</pre></td></tr>)}</tbody></table>}</div>)}</section>)}</div>;
}

export function ConversationWorkspace({ api,conversation,workbenchId,workbenchName }: { api: DigitalLifeApi;conversation: ConversationDto | null;workbenchId: string;workbenchName: string }) {
  useI18n();
  const [tab,setTab] = useState<Tab>("changes");
  const [git,setGit] = useState<GitWorkspaceDto | null>(null);
  const [command,setCommand] = useState<GitCommandDto | null>(null);
  const [notice,setNotice] = useState<string | null>(null);
  const [commitMessage,setCommitMessage] = useState("");
  const [branch,setBranch] = useState("");
  const [diff,setDiff] = useState<{ path: string;patch: string;truncated: boolean } | null>(null);
  const [sideBySide,setSideBySide] = useState(false);
  const [directory,setDirectory] = useState("");
  const [files,setFiles] = useState<{ path: string;directory: boolean }[]>([]);
  const [file,setFile] = useState<{ path: string;text: string;truncated: boolean } | null>(null);
  const [urlDraft,setUrlDraft] = useState("http://localhost:5173");
  const [url,setUrl] = useState("");
  const epoch = useRef(0);
  const loading = useRef(false);
  const running = command?.status === "QUEUED" || command?.status === "RUNNING";
  const commandId = command?.commandId;
  const artifacts = conversation?.turns.flatMap(turn => turn.artifacts) ?? [];
  const changed = [...new Map(artifacts.map(a => [a.name,a])).values()];
  const fail = useCallback((error: unknown) => setNotice(error instanceof ApiError ? error.displayMessage : t("chat.error")),[]);
  const refresh = useCallback(async () => {
    if (!api.desktop || workbenchId === "" || loading.current) return;
    loading.current = true;const token = epoch.current;
    try { const value = await api.conversationGit(workbenchId);if (token === epoch.current) setGit(value); }
    catch (error) { if (token === epoch.current) fail(error); } finally { loading.current = false; }
  },[api,workbenchId,fail]);
  useEffect(() => {
    const revision = ++epoch.current;let current = true;
    const initial = setTimeout(() => { if (current) { setGit(null);setDiff(null);setFile(null);setDirectory("");setFiles([]);setCommand(null);setNotice(null);void refresh(); } },0);
    const timer = setInterval(() => { if (current) void refresh(); },5_000);
    return () => { current = false;epoch.current = revision + 1;clearTimeout(initial);clearInterval(timer); };
  },[workbenchId,refresh]);
  useEffect(() => {
    if (!api.desktop || workbenchId === "" || tab !== "files") return;
    let current = true;
    void api.conversationFiles(workbenchId,directory).then(page => { if (current) setFiles(page.items); }).catch(fail);
    return () => { current = false; };
  },[api,workbenchId,directory,tab,fail]);
  useEffect(() => {
    if (!running || commandId === undefined) return;
    let current = true,fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      void api.getConversationGitCommand(commandId).then(next => {
        if (!current) return;setCommand(next);
        if (next.status === "COMPLETED") { setNotice(t("chat.operationDone"));setCommitMessage("");void refresh(); }
        else if (next.status === "FAILED" || next.status === "INTERRUPTED") { setNotice(next.status === "INTERRUPTED" ? t("chat.interrupted") : t("chat.operationFailed"));void refresh(); }
      }).catch(fail).finally(() => { fetching = false; });
    },750);
    return () => { current = false;clearInterval(timer); };
  },[api,commandId,running,refresh,fail]);
  const run = async (input: Omit<GitCommandInput,"requestId">) => {
    if (running) return;setNotice(null);
    try { setCommand(await api.runConversationGit(workbenchId,{ ...input,requestId: randomUuid() })); }
    catch (error) { fail(error); }
  };
  const showDiff = useCallback(async (path: string,staged: boolean) => {
    const token = epoch.current;
    try { const result = await api.conversationDiff(workbenchId,path,staged);if (token === epoch.current) setDiff({ path,...result }); }
    catch (error) { fail(error); }
  },[api,workbenchId,fail]);
  const openFile = async (path: string) => {
    const token = epoch.current;
    try { const result = await api.conversationFile(workbenchId,path);if (token === epoch.current) setFile({ path,...result }); }
    catch (error) { fail(error); }
  };
  const openBrowser = () => {
    try { const value = new URL(urlDraft);if (!["http:","https:"].includes(value.protocol) || value.username !== "" || value.password !== "") throw new Error("invalid_url");setUrl(value.toString());setNotice(null); }
    catch { setNotice(t("chat.invalidUrl")); }
  };
  return <aside className="conversation-workspace" id="conversation-workspace"><header><FolderIcon /><strong>{t("chat.workspace")}</strong><small>{workbenchName}</small><button aria-label={t("chat.refresh")} className="icon-button" onClick={() => void refresh()} type="button"><ArrowClockwiseIcon /></button></header>
    <nav aria-label={t("chat.workspace")}>{(["changes","git","browser","files"] as const).map(key => <button aria-current={tab === key ? "page" : undefined} key={key} onClick={() => { setTab(key);setDiff(null);setFile(null); }} type="button">{key === "changes" ? t("chat.changes") : key === "git" ? t("chat.git") : key === "browser" ? t("chat.browser") : t("chat.files")}{key === "changes" && changed.length > 0 ? <small>{changed.length}</small> : null}</button>)}</nav>
    {notice === null ? null : <p className="chat-workspace-notice" role="status">{notice}</p>}
    <div className="chat-workspace-body">{diff !== null ? <><button className="chat-back" onClick={() => setDiff(null)} type="button"><ArrowLeftIcon />{t("chat.back")}</button><h3>{diff.path}</h3><div className="chat-view-switch"><button aria-pressed={!sideBySide} onClick={() => setSideBySide(false)} type="button">{t("chat.unified")}</button><button aria-pressed={sideBySide} onClick={() => setSideBySide(true)} type="button">{t("chat.sideBySide")}</button></div>{diff.truncated ? <p>{t("chat.truncated")}</p> : null}<DiffView patch={diff.patch} sideBySide={sideBySide} /></>
      : tab === "changes" ? <><p className="chat-workspace-caption">{t("chat.attributed")}</p>{changed.length === 0 ? <div className="chat-workspace-empty"><FileTextIcon /><p>{t("chat.noChanges")}</p></div> : changed.map(a => <div className="chat-change-file" key={a.name}><FileTextIcon /><span>{a.name}<small>{a.size.toLocaleString()} B</small></span></div>)}<button className="chat-link-button" onClick={() => { setTab("git");void refresh(); }} type="button"><GitBranchIcon />{t("chat.repository")}</button></>
      : tab === "browser" ? <><form className="chat-browser-form" onSubmit={e => { e.preventDefault();openBrowser(); }}><input aria-label={t("chat.browserUrl")} onChange={e => setUrlDraft(e.target.value)} type="url" value={urlDraft} /><button aria-label={t("chat.open")} type="submit"><ArrowSquareOutIcon /></button></form><p className="chat-workspace-caption">{t("chat.browserHint")}</p>{url === "" ? <div className="chat-workspace-empty"><ArrowSquareOutIcon /></div> : <iframe className="chat-browser-frame" referrerPolicy="no-referrer" sandbox="allow-scripts allow-forms" src={url} title={t("chat.browser")} />}</>
      : !api.desktop ? <p className="chat-empty-note">{t("chat.desktopOnly")}</p>
        : tab === "files" ? <><button className="chat-back" disabled={directory === "" && file === null} onClick={() => { if (file !== null) setFile(null);else setDirectory(directory.split("/").slice(0,-1).join("/")); }} type="button"><ArrowLeftIcon />{t("chat.back")}</button><small>{directory || t("chat.root")}</small>{file === null ? <div className="chat-file-tree">{files.length === 0 ? <p>{t("chat.emptyFiles")}</p> : files.map(f => <button key={f.path} onClick={() => f.directory ? setDirectory(f.path) : void openFile(f.path)} type="button">{f.directory ? <FolderIcon /> : <FileTextIcon />}<span>{f.path.split("/").at(-1)}</span></button>)}</div> : <><h3>{file.path}</h3><pre className="chat-file-preview">{file.text}</pre></>}</>
          : git?.available !== true ? <p className="chat-empty-note">{t("chat.gitUnavailable")}</p> : <>
            <p className="chat-workspace-caption">{t("chat.repository")}</p>
            <label className="chat-branch-label"><GitBranchIcon /><select aria-label={t("chat.branch")} disabled={running} onChange={e => void run({ action: "SWITCH",branch: e.target.value })} value={git.branch}>{git.branches.includes(git.branch) ? null : <option value={git.branch}>{git.branch || "HEAD"}</option>}{git.branches.map(b => <option key={b} value={b}>{b}</option>)}</select><small>↑{git.ahead} ↓{git.behind}</small></label>
            <div className="chat-git-sync"><button disabled={running} onClick={() => void run({ action: "FETCH" })} type="button">{t("chat.fetch")}</button><button disabled={running} onClick={() => void run({ action: "PULL" })} type="button">{t("chat.pull")}</button><button disabled={running} onClick={() => void run({ action: "PUSH" })} type="button">{t("chat.push")}</button></div>
            <details className="chat-new-branch"><summary>{t("chat.createBranch")}</summary><input aria-label={t("chat.newBranch")} onChange={e => setBranch(e.target.value)} placeholder="feature/…" value={branch} /><button disabled={running || branch.trim() === ""} onClick={() => void run({ action: "BRANCH",branch })} type="button">{t("chat.createBranch")}</button></details>
            <div className="chat-git-actions"><button disabled={running} onClick={() => void run({ action: "STAGE" })} type="button"><PlusIcon />{t("chat.stageAll")}</button><button disabled={running} onClick={() => void run({ action: "UNSTAGE" })} type="button"><MinusIcon />{t("chat.unstageAll")}</button></div>
            {git.files.length === 0 ? <p className="chat-empty-note">{t("chat.clean")}</p> : <><GitFileGroup files={git.files} staged disabled={running} onDiff={showDiff} onRun={run} /><GitFileGroup files={git.files} staged={false} disabled={running} onDiff={showDiff} onRun={run} /></>}
            <form className="chat-commit-form" onSubmit={e => { e.preventDefault();void run({ action: "COMMIT",message: commitMessage }); }}><textarea aria-label={t("chat.commitMessage")} maxLength={4000} onChange={e => setCommitMessage(e.target.value)} placeholder={t("chat.commitMessage")} rows={3} value={commitMessage} /><button disabled={running || commitMessage.trim() === "" || !git.files.some(f => f.index.trim() !== "" && f.index !== "?")} type="submit"><GitCommitIcon />{t("chat.commit")}</button></form>
            {running ? <p role="status">{command.status === "QUEUED" ? t("chat.queued") : t("chat.running")}</p> : null}
            <h3>{t("chat.history")}</h3><ol className="chat-git-history">{git.history.map(commit => <li key={commit.hash}><GitCommitIcon /><span>{commit.message}<small>{commit.hash.slice(0,8)} · {commit.date.slice(0,10)}</small></span></li>)}</ol>
          </>}
    </div><footer><LockBadge />{t("chat.locked")}</footer>
  </aside>;
}
function LockBadge() { return <span aria-hidden>◇</span>; }
