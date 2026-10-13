import { decideWorkspaceAdmission, classifyLocalToolEffect } from "../../src/main/domain/work/workspace-write-scheduling.js";
import { LocalWriteGate, isWriteResumeWait } from "../../src/main/application/partners/local-write-gate.js";
import { DomainError } from "../../src/main/domain/errors.js";

describe("AC-WR-01/03 workspace admission", () => {
  it("keeps review and requirements maintenance in the resource queue", () => {
    for (const code of ["goal_execution_paused", "goal_requirements_pending", "goal_requirements_stale"]) expect(isWriteResumeWait(new DomainError(code, "fixture"))).toBe(true);
    expect(isWriteResumeWait(new DomainError("workspace_checkpoint_missing", "fixture"))).toBe(false);
    expect(isWriteResumeWait(new Error("fixture"))).toBe(false);
  });
  it("shares reads and excludes them during writes or behind queued writers", () => {
    expect(decideWorkspaceAdmission({ access: "READ", otherReaders: 2, writerHeld: false, earlierWriter: false })).toBe(true);
    expect(decideWorkspaceAdmission({ access: "READ", otherReaders: 0, writerHeld: true, earlierWriter: false })).toBe(false);
    expect(decideWorkspaceAdmission({ access: "READ", otherReaders: 0, writerHeld: false, earlierWriter: true })).toBe(false);
  });
  it("upgrades only a sole reader without an earlier writer", () => {
    expect(decideWorkspaceAdmission({ access: "WRITE", otherReaders: 0, writerHeld: false, earlierWriter: false })).toBe(true);
    expect(decideWorkspaceAdmission({ access: "WRITE", otherReaders: 1, writerHeld: false, earlierWriter: false })).toBe(false);
    expect(decideWorkspaceAdmission({ access: "WRITE", otherReaders: 0, writerHeld: false, earlierWriter: true })).toBe(false);
  });
  it("classifies every shell as writable and unknown tools as denied", () => {
    for (const tool of ["bash", "Bash", "edit", "Write", "NotebookEdit"]) expect(classifyLocalToolEffect(tool)).toBe("WRITE");
    for (const tool of ["read", "Read", "Glob", "grep", "ask_user", "financial_calculate", "research_audit"]) expect(classifyLocalToolEffect(tool)).toBe("READ");
    for (const tool of ["Agent", "Skill", "mcp__server__tool", "unknown"]) expect(classifyLocalToolEffect(tool)).toBe("DENY");
  });
  it("keeps ceilings authoritative, blocks indirect tools and freezes the suspended batch", () => {
    expect(new LocalWriteGate(undefined).beforeTool("unknown")).toBeUndefined();
    const readOnly = new LocalWriteGate({ phase: "READ_RUNNING", accessCeiling: "READ", generation: 1 });
    expect(readOnly.beforeTool("write")).toMatchObject({ reason: "workspace_write_forbidden" });
    expect(readOnly.suspended).toBe(false);
    const analysis = new LocalWriteGate({ phase: "READ_RUNNING", accessCeiling: "WRITE", generation: 1 });
    expect(analysis.beforeTool("read")).toBeUndefined();
    expect(analysis.beforeTool("Skill")).toMatchObject({ reason: "partner_tool_not_allowed" });
    expect(analysis.beforeTool("Bash")).toMatchObject({ reason: "workspace_write_required" });
    expect(analysis.beforeTool("read")).toMatchObject({ reason: "workspace_write_suspended" });
    expect(new LocalWriteGate({ phase: "WRITE_RUNNING", accessCeiling: "WRITE", generation: 2 }).beforeTool("write")).toBeUndefined();
  });
});
