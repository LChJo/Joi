import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { PartnerSessionState, ResidentTurnResult } from "../../application/ports/partner-instances.js";
import { DomainError } from "../../domain/errors.js";
import { restorePiSnapshot } from "./joi-pi-session.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import { PiSessionUsage, type PiUsageCursor } from "./pi-session-usage.js";

type NativeReference = NonNullable<PartnerSessionState["piNativeSession"]>;

/** Identity-derived files are private SDK history; SQLite messages remain a disposable projection. */
export class PiNativeSessionStore {
  constructor(private readonly directory: string) {}

  async readContext(identity: readonly string[],reference?: NativeReference): Promise<{ manager: SessionManager; reference: NativeReference } | null> {
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    if (reference !== undefined && (!validReference(reference) || reference.key !== key)) throw new DomainError("pi_session_identity_mismatch","The source session belongs to another execution.");
    try {
      const text = await readFile(path.join(this.directory,key,"session.jsonl"),"utf8");
      const parsed = text.trim().split("\n").map(line => JSON.parse(line) as unknown);
      const manager = restorePiSnapshot(".",{ version: 1,header: parsed[0],entries: parsed.slice(1),leafId: null });
      if (reference !== undefined && reference.sessionId !== manager.getSessionId()) throw new DomainError("pi_session_identity_mismatch","The source session identity changed.");
      const selected = reference ?? await readFile(path.join(this.directory,key,"migration.json"),"utf8").then(value => JSON.parse(value) as Pick<NativeReference,"leafId" | "lastEntryId">,(error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (selected?.lastEntryId === (manager.getEntries().at(-1)?.id ?? null)) {
        if (selected.leafId === null) manager.resetLeaf(); else manager.branch(selected.leafId);
      } else {
        const leaf = manager.getEntries().at(-1)?.id;
        if (leaf !== undefined) manager.branch(leaf);
      }
      return { manager,reference: { version: 1,key,sessionId: manager.getSessionId(),leafId: manager.getLeafId(),lastEntryId: manager.getEntries().at(-1)?.id ?? null } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && reference === undefined) return null;
      if (error instanceof DomainError) throw error;
      throw new DomainError("conversation_handoff_failed","The source session cannot be read; the conversation is preserved.");
    }
  }

  /** Acknowledged numeric progress survives restart; unchanged histories need no replay. */
  async reconcileUsage(recorder: UsageRecorder, degraded: () => void = () => undefined): Promise<void> {
    const directories = await readdir(this.directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of directories) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
      try {
        const directory = path.join(this.directory,entry.name),file = path.join(directory,"session.jsonl"),cursorFile = path.join(directory,"usage-cursor.json");
        const fingerprint = await stat(file);
        const persisted = await readFile(cursorFile,"utf8").then(value => {
          const candidate: unknown = JSON.parse(value);
          if (!validUsageCursor(candidate)) throw new Error("pi_usage_cursor_invalid");
          return candidate;
        }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") degraded();return undefined; });
        const saved = persisted?.cursor.lastInvocationId !== undefined && recorder.hasRecorded?.(persisted.cursor.lastInvocationId) === false ? undefined : persisted;
        if (saved?.complete === true && saved.size === fingerprint.size && saved.mtimeMs === fingerprint.mtimeMs && saved.ctimeMs === fingerprint.ctimeMs) continue;
        const text = await readFile(file, "utf8");
        const entries = text.trim().split("\n").map(line => JSON.parse(line) as unknown);
        const manager = restorePiSnapshot(".", { version: 1, header: entries[0], entries: entries.slice(1), leafId: null });
        const cursor = new PiSessionUsage(recorder,saved?.cursor).reconcile(manager);
        const temporary = path.join(directory,`${randomUUID()}.usage`);
        try {
          await writeFile(temporary,JSON.stringify({ version: 2,size: fingerprint.size,mtimeMs: fingerprint.mtimeMs,ctimeMs: fingerprint.ctimeMs,
            complete: cursor.offset === manager.getEntries().length,cursor }),{ encoding: "utf8",flag: "wx" });
          await rename(temporary,cursorFile);
        } finally { await rm(temporary,{ force: true }); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") degraded(); }
    }
  }

  startUsageReconciliation(recorder: UsageRecorder, degraded: () => void): () => Promise<void> {
    let stopped = false;
    let running: Promise<void> | undefined;
    const sweep = async () => {
      if (stopped || running) return;
      const operation = async () => { try { await this.reconcileUsage(recorder, degraded); } catch { degraded(); } };
      running = operation();
      try { await running; } finally { running = undefined; }
    };
    const timer = setInterval(() => { void sweep(); }, 60_000); timer.unref();
    void sweep();
    return async () => { stopped = true; clearInterval(timer); await running; };
  }

  async readSettledResult(identity: readonly string[], actionId: string): Promise<ResidentTurnResult | null> {
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const file = path.join(this.directory, key, "session.jsonl");
    try {
      const text = await readFile(file, "utf8");
      if (text.trim() === "") return null;
      const parsed = text.trim().split("\n").map(line => JSON.parse(line) as unknown);
      restorePiSnapshot(".", { version: 1, header: parsed[0], entries: parsed.slice(1), leafId: null });
      const manager = SessionManager.open(file);
      const entry = manager.getEntries().findLast(candidate => candidate.type === "custom" && candidate.customType === "joi.work_result"
        && (candidate.data as { actionId?: unknown } | null)?.actionId === actionId);
      if (entry?.type !== "custom") return null;
      const result = (entry.data as { result?: unknown } | null)?.result;
      if (!validResult(result)) {
        throw new DomainError("pi_result_invalid", "The persisted SDK result is invalid.");
      }
      return structuredClone(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof DomainError) throw error;
      throw new DomainError("pi_session_restore_failed", "The native SDK result cannot be read.");
    }
  }

  async open(input: { identity: readonly string[]; cwd: string; state?: PartnerSessionState; legacySource?: unknown }): Promise<{ manager: SessionManager; reference: () => NativeReference }> {
    const key = createHash("sha256").update(JSON.stringify(input.identity)).digest("hex");
    const reference = input.state?.piNativeSession;
    if (reference !== undefined && !validReference(reference)) {
      throw new DomainError("pi_session_reference_invalid", "The native session reference is invalid.");
    }
    if (input.state?.piNativeSession !== undefined && input.state.piNativeSession.key !== key) {
      throw new DomainError("pi_session_identity_mismatch", "The private session belongs to a different execution identity.");
    }
    const directory = path.join(this.directory, key), file = path.join(directory, "session.jsonl");
    await mkdir(directory, { recursive: true });
    const existing = await readFile(file, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new DomainError("pi_session_storage_failed", "The native session cannot be read.");
    });
    let manager: SessionManager;
    try {
      if (existing === undefined) {
        if (input.state?.piNativeSession !== undefined) throw new DomainError("pi_session_missing", "The native session is unavailable; it cannot be replaced with an empty conversation.");
        if (input.state !== undefined) await this.#backup(directory, input.legacySource ?? input.state);
        const parent = input.state?.handoff?.sourcePiSession;
        if (parent !== undefined && !validReference(parent)) throw new DomainError("pi_session_reference_invalid","The handoff parent reference is invalid.");
        const imported = input.state?.piSession === undefined ? SessionManager.inMemory(input.cwd,parent === undefined ? undefined : { parentSession: path.join(this.directory,parent.key,"session.jsonl") }) : restorePiSnapshot(input.cwd, input.state.piSession);
        if (input.state?.piSession === undefined) for (const message of input.state?.messages ?? []) imported.appendMessage(message as Message);
        const source = JSON.stringify(input.legacySource ?? input.state ?? { engine: "pi-core", messages: [] });
        const temporary = path.join(directory, `${randomUUID()}.import`);
        await writeFile(temporary, [imported.getHeader(), ...imported.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
        const leafId = imported.getLeafId();
        const metadata = { version: 1, sourceHash: createHash("sha256").update(source).digest("hex"), targetSessionId: imported.getSessionId(), leafId,
          lastEntryId: imported.getEntries().at(-1)?.id ?? null };
        await writeFile(path.join(directory, "migration.json"), JSON.stringify({ ...metadata, status: "prepared" }), "utf8");
        await rename(temporary, file);
        manager = SessionManager.open(file, directory, input.cwd);
        if (leafId === null) manager.resetLeaf(); else manager.branch(leafId);
        await writeFile(path.join(directory, "migration.json"), JSON.stringify({ ...metadata, status: "completed" }), "utf8");
      } else {
        const parsed = existing.trim().split("\n").map(line => JSON.parse(line) as unknown);
        restorePiSnapshot(input.cwd, { version: 1, header: parsed[0], entries: parsed.slice(1), leafId: null });
        manager = SessionManager.open(file, directory, input.cwd);
        const reference = input.state?.piNativeSession;
        if (reference?.sessionId !== undefined && reference.sessionId !== manager.getSessionId()) throw new DomainError("pi_session_identity_mismatch", "The native session identity changed.");
        const selected = reference ?? await readFile(path.join(directory, "migration.json"), "utf8").then(value => JSON.parse(value) as Pick<NativeReference, "leafId" | "lastEntryId">, (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (selected?.lastEntryId === (manager.getEntries().at(-1)?.id ?? null)) {
          if (selected.leafId === null) manager.resetLeaf(); else manager.branch(selected.leafId);
        }
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("pi_session_restore_failed", "The native session could not be restored; its source is preserved.");
    }
    const active = manager;
    return { manager, reference: () => ({ version: 1, key, sessionId: active.getSessionId(), leafId: active.getLeafId(), lastEntryId: active.getEntries().at(-1)?.id ?? null }) };
  }

  async #backup(directory: string, value: unknown): Promise<void> {
    const file = path.join(directory, "legacy-source.json"), source = JSON.stringify(value);
    try { await writeFile(file, source, { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readFile(file, "utf8") !== source) throw new DomainError("pi_session_migration_conflict", "The interrupted import has a different preserved source.");
    }
  }
}

interface StoredUsageCursor { version: 2;size: number;mtimeMs: number;ctimeMs: number;complete: boolean;cursor: PiUsageCursor; }
function validUsageCursor(value: unknown): value is StoredUsageCursor {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string,unknown>;
  if (row.cursor === null || typeof row.cursor !== "object") return false;
  const cursor = row.cursor as Record<string,unknown>;
  return row.version === 2 && typeof row.size === "number" && typeof row.mtimeMs === "number" && typeof row.ctimeMs === "number"
    && typeof row.complete === "boolean" && typeof cursor.sessionId === "string"
    && typeof cursor.offset === "number" && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && (cursor.lastEntryId === null || typeof cursor.lastEntryId === "string")
    && (cursor.lastInvocationId === undefined || typeof cursor.lastInvocationId === "string")
    && typeof cursor.tracedSummaries === "boolean";
}

function validReference(value: unknown): value is NativeReference {
  if (value === null || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return ref.version === 1 && typeof ref.key === "string" && typeof ref.sessionId === "string"
    && (ref.leafId === null || typeof ref.leafId === "string") && (ref.lastEntryId === null || typeof ref.lastEntryId === "string");
}

function validResult(value: unknown): value is ResidentTurnResult {
  if (value === null || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (typeof result.status !== "string" || !["COMPLETED", "FAILED", "UNKNOWN", "WAITING_INPUT"].includes(result.status)
    || typeof result.externalRunId !== "string" || result.output === null || typeof result.output !== "object") return false;
  const output = result.output as Record<string, unknown>;
  return typeof output.body === "string" && Array.isArray(output.artifacts);
}
