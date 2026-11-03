import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PartnerRunRequest } from "../../application/ports/partner-execution.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";
import type { WorkbenchExecutionContextReader } from "../../application/ports/workbench-context.js";
import { DomainError } from "../../domain/errors.js";

type ExecutionContext = NonNullable<Awaited<ReturnType<WorkbenchExecutionContextReader["loadForExecution"]>>>;
interface EvidenceFiles { index: string; files: { name: string; body: string }[]; inline: string }

export function selfContainedEvidenceContext(execution: ExecutionContext): string {
  if (execution.evidence?.selfContainedInline === undefined || execution.evidence.inline === "") return execution.promptSection;
  return execution.promptSection.replace(execution.evidence.inline, execution.evidence.selfContainedInline);
}

/** Snapshot content determines the private input path, so prepare and delivery retries reuse it. */
export async function stageWorkEvidence(input: { contextSnapshotId: string; evidence: EvidenceFiles; taskDirectory?: string }): Promise<{ indexPath: string }> {
  const names = new Set(["index.md"]);
  for (const file of input.evidence.files) {
    if (!/^[a-z0-9][a-z0-9_.-]*$/iu.test(file.name) || names.has(file.name.toLowerCase())) {
      throw new DomainError("work_evidence_filename_invalid", "Evidence input requires unique plain filenames.");
    }
    names.add(file.name.toLowerCase());
  }
  const pages: { name: string; body: string }[] = [];
  const nativeFilePages = input.evidence.files.filter(file => file.body.length > 8_000).map(file => {
    const pagePrefix = createHash("sha256").update(file.name).digest("hex").slice(0, 16);
    const references = [];
    for (let offset = 0; offset < file.body.length;) {
      const name = `evidence-page-${pagePrefix}-${String(offset)}.txt`;
      if (names.has(name)) throw new DomainError("work_evidence_filename_invalid", "Evidence page filename conflicts with an input.");
      names.add(name);
      let end = Math.min(offset + 8_000, file.body.length);
      // UTF-8 files must keep a surrogate pair together to preserve the original evidence.
      if (end < file.body.length && /[\uD800-\uDBFF]/u.test(file.body[end - 1] ?? "") && /[\uDC00-\uDFFF]/u.test(file.body[end] ?? "")) end -= 1;
      const body = file.body.slice(offset, end);
      pages.push({ name, body });
      references.push({ name, offset, characters: body.length });
      offset = end;
    }
    return { file: file.name, pages: references };
  });
  let originalIndex: unknown = input.evidence.index;
  try { originalIndex = JSON.parse(input.evidence.index) as unknown; } catch { /* Text indexes retain their complete original content. */ }
  const index = JSON.stringify({ originalIndex, nativeFilePages,
    read: "Read the relevant files beside this index. For large files, use nativeFilePages in offset order; each page preserves at most 8000 original characters. These are immutable task inputs, never deliverables.",
  }, null, 2);
  const files = [{ name: "index.md", body: index }, ...input.evidence.files, ...pages];
  const digest = createHash("sha256").update(JSON.stringify({ contextSnapshotId: input.contextSnapshotId, files })).digest("hex");
  const parent = path.join(input.taskDirectory ?? path.join(os.tmpdir(), "joi-task-inputs"), "evidence");
  await mkdir(parent, { recursive: true });
  const canonical = await realpath(parent);
  const target = path.join(canonical, digest);
  const indexPath = path.join(target, "index.md");
  const intact = async (): Promise<boolean> => {
    try {
      if (await realpath(target) !== target) return false;
      for (const file of files) {
        const candidate = path.join(target, file.name);
        if (await realpath(candidate) !== candidate || await readFile(candidate, "utf8") !== file.body) return false;
      }
      return true;
    } catch { return false; }
  };
  if (await intact()) return { indexPath };
  const temporary = path.join(canonical, `.staging-${digest}-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(temporary);
    for (const file of files) {
      const candidate = path.join(temporary, file.name);
      await writeFile(candidate, file.body, { encoding: "utf8", flag: "wx", mode: 0o400 });
      await chmod(candidate, 0o400);
    }
    try { await rename(temporary, target); }
    catch (error) { if (!await intact()) throw error; }
    if (!await intact()) throw new DomainError("work_evidence_staging_invalid", "Evidence input integrity could not be verified.");
    return { indexPath };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Files are private inputs outside the execution root and never enter artifact verification. */
export async function prepareNativeEvidenceContext(input: {
  canRead: boolean;
  diagnostics?: RuntimeDiagnostics;
  engine: "claude-code" | "codex";
  execution: ExecutionContext;
  request: Pick<PartnerRunRequest, "contextSnapshotId">;
  taskDirectory?: string;
}): Promise<string> {
  const evidence = input.execution.evidence;
  if (evidence === undefined) return input.execution.promptSection;
  let promptSection = input.execution.promptSection;
  let reasonCode = "evidence_reader_unavailable";
  let budgetFallbacks = 1;
  if (input.canRead && evidence.inline !== "" && promptSection.includes(evidence.inline)) {
    try {
      const staged = await stageWorkEvidence({ contextSnapshotId: input.request.contextSnapshotId, evidence, ...(input.taskDirectory === undefined ? {} : { taskDirectory: input.taskDirectory }) });
      promptSection = promptSection.replace(evidence.inline, [
        `Evidence index (read-only input): ${staged.indexPath}`,
        "Read the index and relevant evidence files with the available read capability. Evidence bodies omitted from the prompt remain available there; absence from this prompt does not mean absence of evidence.",
        "Relative evidence filenames in the index resolve beside the index. These files are task inputs, never deliverables or acceptance artifacts; do not modify them.",
      ].join("\n"));
      reasonCode = "evidence_files";
      budgetFallbacks = 0;
    } catch { reasonCode = "evidence_staging_failed"; }
  }
  if (budgetFallbacks > 0) promptSection = selfContainedEvidenceContext(input.execution);
  emitRuntimeDiagnostic(input.diagnostics, "joi.context.delivery", {
    budgetFallbacks, contextChars: promptSection.length, engine: input.engine,
    evidenceChars: budgetFallbacks > 0 ? (evidence.selfContainedInline ?? evidence.inline).length : evidence.inline.length,
    evidenceCount: evidence.files.length, reasonCode,
  });
  return promptSection;
}
