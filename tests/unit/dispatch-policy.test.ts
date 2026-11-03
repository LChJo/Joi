import {
  DISPATCH_POLICY_REASONS,
  evaluateDispatchPolicy,
} from "../../src/main/application/work/dispatch-policy.js";

const facts = (overrides: Partial<Parameters<typeof evaluateDispatchPolicy>[1]> = {}) => ({
  leaseConflict: false,
  partnerKind: "LOCAL_PI",
  workspaceRef: "workbench_workspace:workbench-a",
  workspaceStatus: "READY",
  ...overrides,
});

const factsWithoutBinding = () => ({ leaseConflict: false, partnerKind: "LOCAL_PI" });

describe("dispatch policy decision", () => {
  it("allows NONE access regardless of partner or workspace facts", () => {
    expect(evaluateDispatchPolicy("NONE", facts({ partnerKind: "A2A", workspaceStatus: "FAILED" }))).toEqual({ allowed: true });
    expect(evaluateDispatchPolicy("NONE", factsWithoutBinding())).toEqual({ allowed: true });
  });

  it("forbids A2A partners from READ/WRITE workspace access even when the workspace is ready", () => {
    expect(evaluateDispatchPolicy("READ", facts({ partnerKind: "A2A" }))).toEqual({
      allowed: false,
      reason: DISPATCH_POLICY_REASONS.a2aWorkspaceAccessForbidden,
    });
    expect(evaluateDispatchPolicy("WRITE", facts({ partnerKind: "A2A" }))).toEqual({
      allowed: false,
      reason: DISPATCH_POLICY_REASONS.a2aWorkspaceAccessForbidden,
    });
  });

  it("requires a READY workspace binding before local file work", () => {
    expect(evaluateDispatchPolicy("WRITE", facts({ workspaceStatus: "PROVISIONING" }))).toEqual({
      allowed: false,
      reason: DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady,
    });
    expect(evaluateDispatchPolicy("READ", factsWithoutBinding())).toEqual({
      allowed: false,
      reason: DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady,
    });
  });

  it("denies file work while a conflicting workspace lease is held", () => {
    expect(evaluateDispatchPolicy("READ", facts({ leaseConflict: true }))).toEqual({
      allowed: false,
      reason: DISPATCH_POLICY_REASONS.workspaceLeaseConflict,
    });
  });

  it("allows local file work on a READY workspace without a conflicting lease", () => {
    expect(evaluateDispatchPolicy("READ", facts())).toEqual({ allowed: true });
    expect(evaluateDispatchPolicy("WRITE", facts())).toEqual({ allowed: true });
  });

  it("keeps a stable precedence: A2A before workspace readiness before lease conflict", () => {
    expect(evaluateDispatchPolicy("READ", facts({ leaseConflict: true, partnerKind: "A2A", workspaceStatus: "PROVISIONING" }))).toEqual({
      allowed: false,
      reason: DISPATCH_POLICY_REASONS.a2aWorkspaceAccessForbidden,
    });
    expect(evaluateDispatchPolicy("READ", facts({ leaseConflict: true, workspaceStatus: "PROVISIONING" }))).toEqual({
      allowed: false,
      reason: DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady,
    });
  });
});
