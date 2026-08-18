import type { Clock } from "../../application/ports/runtime-store.js";
import type {
  RuntimeDiagnosticEventMap,
  RuntimeDiagnosticName,
  RuntimeDiagnostics,
} from "../../application/ports/runtime-diagnostics.js";

let stderrWriteDisabled = false;
let stderrErrorHandlerInstalled = false;

function writeToProcessStderr(line: string): void {
  if (stderrWriteDisabled) return;
  if (!stderrErrorHandlerInstalled) {
    stderrErrorHandlerInstalled = true;
    // A Codux/terminal pipe can close asynchronously after write() returns.
    // Consume that sink failure so diagnostics never terminate the main process.
    process.stderr.on("error", () => { stderrWriteDisabled = true; });
  }
  try {
    process.stderr.write(line);
  } catch {
    stderrWriteDisabled = true;
  }
}

export class JsonLineRuntimeDiagnostics implements RuntimeDiagnostics {
  readonly #clock: Clock;
  readonly #filePath: string | undefined;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #write: (line: string) => void;

  constructor(input: { clock: Clock; directory?: string; maxBytes?: number; maxFiles?: number; write?: (line: string) => void }) {
    this.#clock = input.clock;
    this.#maxBytes = Math.max(256, Math.trunc(input.maxBytes ?? 2 * 1024 * 1024));
    this.#maxFiles = Math.max(1, Math.min(10, Math.trunc(input.maxFiles ?? 3)));
    this.#write = input.write ?? writeToProcessStderr;
    if (input.directory !== undefined) {
      mkdirSync(input.directory, { recursive: true });
      this.#filePath = path.join(input.directory, "joi-flow.jsonl");
    }
  }

  emit<Name extends RuntimeDiagnosticName>(event: Name, fields: Readonly<RuntimeDiagnosticEventMap[Name]>): void {
    try {
      if (!safeDiagnosticValue(fields)) return;
      const line = `${JSON.stringify({
        ...fields,
        at: this.#clock.now().toISOString(),
        event,
        scope: "joi-flow",
      })}\n`;
      this.#write(line);
      this.#append(line);
    } catch {
      // Runtime diagnostics are best-effort and may not affect the workflow they observe.
    }
  }

  #append(line: string): void {
    if (this.#filePath === undefined) return;
    const bytes = Buffer.byteLength(line, "utf8");
    if (existsSync(this.#filePath) && statSync(this.#filePath).size + bytes > this.#maxBytes) this.#rotate();
    appendFileSync(this.#filePath, line, "utf8");
  }

  #rotate(): void {
    if (this.#filePath === undefined) return;
    if (this.#maxFiles === 1) {
      if (existsSync(this.#filePath)) unlinkSync(this.#filePath);
      return;
    }
    for (let index = this.#maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.#filePath : `${this.#filePath}.${String(index - 1)}`;
      const target = `${this.#filePath}.${String(index)}`;
      if (!existsSync(source)) continue;
      if (existsSync(target)) unlinkSync(target);
      renameSync(source, target);
    }
  }
}

const UNSAFE_KEY = /(?:body|content|cookie|csrf|directory|memory|message|password|path|payload|persona|prompt|root|secret|text|token)/iu;
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|(?:^|\s)\/(?:Users|home|var|tmp|opt|mnt)\/)/u;
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:api[_-]?key|csrf|token|cookie|password|secret)\s*[:=])/iu;

function safeDiagnosticValue(value: unknown, key = ""): boolean {
  if (UNSAFE_KEY.test(key)) return false;
  if (typeof value === "string") return !ABSOLUTE_PATH.test(value) && !SECRET_VALUE.test(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every((item) => safeDiagnosticValue(item));
  if (typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(([childKey, child]) => safeDiagnosticValue(child, childKey));
}
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
