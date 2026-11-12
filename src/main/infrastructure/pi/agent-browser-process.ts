import { spawn,type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access,mkdir,mkdtemp,readdir,readFile,rm,stat,writeFile } from "node:fs/promises";
import { homedir,tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { maskSecretText } from "../../application/partners/agent-conversation-presentation.js";
import { DomainError } from "../../domain/errors.js";

export interface AgentBrowserSession {
  run(args: readonly string[],signal?: AbortSignal): Promise<{ content: { type: "text";text: string }[];details: Record<string,unknown> }>;
  screenshot(signal?: AbortSignal): Promise<{ content: ({ type: "text";text: string } | { type: "image";data: string;mimeType: "image/png" })[];details: Record<string,unknown> }>;
  close(): Promise<void>;
}

interface Options {
  temporaryRoot?: string;
  executable?: { file: string;args: string[] };
  browserPath?: string;
  timeoutMs?: number;
}
const MAX_BYTES = 512 * 1024;
const MAX_TEXT = 20_000;
const BROWSER_IDLE_MS = 15 * 60 * 1000;
const failed = () => new DomainError("agent_browser_command_failed","The browser command failed. Check the current page and take a fresh snapshot. The command was not retried.");

async function nativeExecutable() {
  const directory = path.dirname(fileURLToPath(import.meta.resolve("agent-browser/package.json"))).replace(/\.asar([\\/])/u,".asar.unpacked$1");
  const architecture = process.platform === "win32" && process.arch === "arm64" ? "x64" : process.arch;
  const platform = process.platform === "linux" && await access(`/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`).then(() => true,() => false) ? "linux-musl" : process.platform;
  const file = path.join(directory,"bin",`agent-browser-${platform}-${architecture}${process.platform === "win32" ? ".exe" : ""}`);
  await access(file).catch(() => { throw new DomainError("agent_browser_runtime_missing","The bundled Agent Browser runtime is missing for this platform. Reinstall Joi."); });
  return { file,args: [] as string[] };
}

async function browserExecutable(explicit?: string) {
  const configured = explicit ?? process.env.JOI_AGENT_BROWSER_EXECUTABLE;
  if (configured !== undefined) {
    if (path.isAbsolute(configured) && await access(configured).then(() => true,() => false)) return configured;
    throw new DomainError("agent_browser_browser_missing","The configured browser executable is unavailable. Check JOI_AGENT_BROWSER_EXECUTABLE and restart Joi.");
  }
  const cache = path.join(homedir(),".agent-browser","browsers");
  const versions = (await readdir(cache,{ withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && /^chrome-[\d.]+$/u.test(entry.name)).sort((a,b) => b.name.localeCompare(a.name,undefined,{ numeric: true }));
  const binary = process.platform === "win32" ? ["chrome-win64","chrome.exe"] : process.platform === "darwin" ? [`chrome-mac-${process.arch === "arm64" ? "arm64" : "x64"}`,"Google Chrome for Testing.app","Contents","MacOS","Google Chrome for Testing"] : ["chrome-linux64","chrome"];
  const candidates = [...versions.map(entry => path.join(cache,entry.name,...binary)),
    ...(process.platform === "win32" ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files","Google","Chrome","Application","chrome.exe"),path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)","Microsoft","Edge","Application","msedge.exe")]
      : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] : ["/usr/bin/google-chrome","/usr/bin/chromium","/usr/bin/chromium-browser"])];
  for (const file of candidates) if (await access(file).then(() => true,() => false)) return file;
  throw new DomainError("agent_browser_browser_missing","Install Chrome for Testing with agent-browser install, or set JOI_AGENT_BROWSER_EXECUTABLE to a Chrome executable and restart Joi. No browser API key is required.");
}

function privateEnvironment(directory: string,session: string,config: string) {
  const systemKeys = new Set(["systemroot","windir","path","comspec","programfiles","programfiles(x86)","programw6432","systemdrive"]);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key,value]) => systemKeys.has(key.toLowerCase()) && value !== undefined));
  // Unix IPC names resolve against the private cwd shared by the daemon and every command.
  return { ...environment,HOME: directory,USERPROFILE: directory,APPDATA: directory,LOCALAPPDATA: directory,TEMP: directory,TMP: directory,TMPDIR: directory,
    XDG_CONFIG_HOME: directory,XDG_CACHE_HOME: directory,XDG_STATE_HOME: directory,XDG_DATA_HOME: directory,
    AGENT_BROWSER_CONFIG: config,AGENT_BROWSER_SESSION: session,AGENT_BROWSER_SOCKET_DIR: process.platform === "win32" ? directory : ".",
    AGENT_BROWSER_NO_VERSION_CHECK: "1",AGENT_BROWSER_DEFAULT_TIMEOUT: "10000",AGENT_BROWSER_IDLE_TIMEOUT_MS: String(BROWSER_IDLE_MS),AGENT_BROWSER_NO_WEBMCP: "1",AGENT_BROWSER_ENABLE: "react-devtools" };
}

async function stop(child: ChildProcess | undefined) {
  if (child?.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve,reject) => {
    child.once("exit",() => { clearTimeout(force);clearTimeout(deadline);resolve(); });
    const force = setTimeout(() => { child.kill("SIGKILL"); },1_000);
    const deadline = setTimeout(() => { reject(new DomainError("agent_browser_cleanup_failed","The owned browser process did not finish closing.")); },3_000);
    child.kill();
  });
}

/** The owned daemon handle lets cancellation terminate its browser even when a command cannot respond. */
export async function createAgentBrowserSession(options: Options = {}): Promise<AgentBrowserSession> {
  const executable = options.executable ?? await nativeExecutable();
  const browser = options.executable === undefined ? await browserExecutable(options.browserPath) : options.browserPath;
  const directory = await mkdtemp(path.join(options.temporaryRoot ?? tmpdir(),"joi-browser-"));
  const session = `joi-${randomUUID().replaceAll("-","").slice(0,12)}`,config = path.join(directory,"config.json"),profile = path.join(directory,"profile");
  let daemon: ChildProcess | undefined,active: ChildProcess | undefined,closed = false,poisoned = false;
  let tail = Promise.resolve(),closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  const environment = privateEnvironment(directory,session,config);
  const globalArguments = ["--config",config,"--session",session,"--profile",profile,"--json","--no-webmcp","--enable","react-devtools","--max-output","16000","--idle-timeout",String(BROWSER_IDLE_MS),...(browser === undefined ? [] : ["--executable-path",browser])];
  const text = (data: unknown) => {
    const result = JSON.stringify(data === undefined ? null : data, (key: string,value: unknown) => /^(?:headers|cookies?|authorization|password|token|apiKey|secret|csrf|postData|requestBody)$/iu.test(key) ? "[redacted]" : value);
    const safe = maskSecretText(result.replaceAll(directory,"[browser-temp]").replaceAll(directory.replaceAll("\\","/"),"[browser-temp]"));
    return safe.length > MAX_TEXT ? `${safe.slice(0,MAX_TEXT)}\n[Browser output omitted after 20000 characters.]` : safe;
  };
  const command = (args: readonly string[],signal?: AbortSignal,shutdown = false) => new Promise<unknown>((resolve,reject) => {
    if (poisoned || daemon?.exitCode !== null || daemon.signalCode !== null) { reject(new DomainError("agent_browser_interrupted","The local browser was interrupted. Its actions were not replayed; start a new execution."));return; }
    const combined = shutdown ? new AbortController().signal : signal === undefined ? lifetime.signal : AbortSignal.any([signal,lifetime.signal]);
    combined.throwIfAborted();
    const child = spawn(executable.file,[...executable.args,...globalArguments,...args],{ cwd: directory,env: environment,windowsHide: true,stdio: ["ignore","pipe","pipe"] });active = child;
    let output = "",bytes = 0,settled = false;
    const fail = (error: unknown) => { if (settled) return;settled = true;poisoned = true;clearTimeout(timer);combined.removeEventListener("abort",abort);void stop(child).catch(() => undefined);void stop(daemon).catch(() => undefined);reject(error instanceof Error ? error : failed()); };
    const abort = () => fail(combined.reason as unknown);
    const timer = setTimeout(() => fail(new DomainError("agent_browser_outcome_unknown","The browser command timed out. Its outcome is unknown and it was not retried.")),options.timeoutMs ?? 30_000);
    combined.addEventListener("abort",abort,{ once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",(chunk: string) => { bytes += Buffer.byteLength(chunk);if (bytes > MAX_BYTES) fail(new DomainError("agent_browser_output_limit","The browser output exceeded its limit. The execution has been stopped."));else output += chunk; });
    child.stderr.resume();
    child.once("error",() => fail(failed()));
    child.once("close",code => {
      active = undefined;if (settled) return;settled = true;clearTimeout(timer);combined.removeEventListener("abort",abort);
      try {
        const response = JSON.parse(output) as { success?: unknown;data?: unknown;code?: unknown };
        if (response.success !== true || code !== 0) {
          if (response.code === "outcome_unknown") { poisoned = true;void stop(daemon).catch(() => undefined);reject(new DomainError("agent_browser_outcome_unknown","The browser action has an unknown outcome and was not retried.")); }
          else reject(failed());
        } else resolve(response.data);
      } catch { poisoned = true;void stop(daemon).catch(() => undefined);reject(failed()); }
    });
  });
  try {
    await mkdir(profile);await writeFile(config,"{}",{ mode: 0o600 });
    daemon = spawn(executable.file,executable.args,{ cwd: directory,env: { ...environment,AGENT_BROWSER_DAEMON: "1",AGENT_BROWSER_PROFILE: profile,...(browser === undefined ? {} : { AGENT_BROWSER_EXECUTABLE_PATH: browser }) },windowsHide: true,stdio: "ignore" });
    daemon.once("error",() => undefined);
    const readyFile = path.join(directory,`${session}${process.platform === "win32" ? ".port" : ".sock"}`);
    let ready = false;
    for (let attempt = 0;attempt < 100;attempt++) {
      if (daemon.exitCode !== null || daemon.signalCode !== null) break;
      const pid = await readFile(path.join(directory,`${session}.pid`),"utf8").catch(() => "");
      if (pid.trim() === String(daemon.pid) && await access(readyFile).then(() => true,() => false)) { ready = true;break; }
      await delay(50);
    }
    if (!ready) throw new DomainError("agent_browser_start_failed","The isolated local browser service could not start. Verify the bundled runtime and browser installation.");
    // The pinned CLI accepts its daemon's stored configuration when debug mode matches.
    await writeFile(path.join(directory,`${session}.config`),JSON.stringify({ debug: false }),{ mode: 0o600 });
  } catch (error) { await stop(daemon);await rm(directory,{ recursive: true,force: true });throw error; }
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new DomainError("agent_browser_closed","The local browser execution has ended."));
    const result = tail.then(operation);tail = result.then(() => undefined,() => undefined);return result;
  };
  return {
    run: (args,signal) => enqueue(async () => ({ content: [{ type: "text",text: text(await command(args,signal)) }],details: {} })),
    screenshot: signal => enqueue(async () => {
      const file = path.join(directory,`screenshot-${randomUUID()}.png`);
      await command(["screenshot",file],signal);
      if ((await stat(file)).size > 8 * 1024 * 1024) throw new DomainError("agent_browser_image_invalid","The browser screenshot exceeded its limit.");
      const image = await readFile(file);
      if (image.length > 8 * 1024 * 1024 || image.subarray(0,8).toString("hex") !== "89504e470d0a1a0a") throw new DomainError("agent_browser_image_invalid","The browser did not produce a bounded PNG screenshot.");
      await rm(file,{ force: true });
      return { content: [{ type: "image",data: image.toString("base64"),mimeType: "image/png" }],details: {} };
    }),
    close: () => closing ??= (async () => {
      closed = true;lifetime.abort();
      try { await stop(active);await tail;if (!poisoned && daemon.exitCode === null && daemon.signalCode === null) await command(["close"],undefined,true).catch(() => undefined); }
      finally { await stop(daemon);await rm(directory,{ recursive: true,force: true,maxRetries: 3,retryDelay: 100 }); }
    })(),
  };
}
