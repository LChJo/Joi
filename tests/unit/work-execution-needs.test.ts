import { assertExecutionAccess, localExecutionCapabilities, readExecutionNeeds } from "../../src/main/domain/work/work-execution-needs.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";

describe("AC-WR-07 execution needs", () => {
  it("distinguishes legacy briefs from declared read-only work and validates declarations", () => {
    expect(readExecutionNeeds(undefined)).toBeUndefined();
    expect(readExecutionNeeds([])).toEqual([]);
    expect(readExecutionNeeds(["SHELL","SHELL","FILE_WRITE"])).toEqual(["SHELL","FILE_WRITE"]);
    for (const value of [null,"SHELL",["unknown"],[1]]) expect(() => readExecutionNeeds(value)).toThrow("Execution needs");
    expect(() => assertExecutionAccess("READ",undefined)).not.toThrow();
    expect(() => assertExecutionAccess("READ",[])).not.toThrow();
  });
  it("uses pinned capabilities and preserves sandboxed Codex reads", () => {
    const base = { capabilities: [], createdAt: "2026-10-13T00:00:00Z", displayName: "Fixture", kind: "local-pi" as const, partnerId: "p", partnerRevisionId: "r", registryRevision: 1, skills: [], tools: [] };
    expect(localExecutionCapabilities(createPartnerRevision({ ...base,kind: "a2a" }))).toBeUndefined();
    const read = localExecutionCapabilities(createPartnerRevision({ ...base,tools: ["read"],toolPolicyMode: "CUSTOM" }));
    expect(read).toMatchObject({ shell: false, fileWrites: false });
    expect(() => assertExecutionAccess("WRITE",["SHELL"],read)).toThrow();
    expect(() => assertExecutionAccess("WRITE",["FILE_WRITE"],read)).toThrow();
    expect(() => assertExecutionAccess("NONE",["SHELL"])).toThrow();
    const all = localExecutionCapabilities(createPartnerRevision(base));
    expect(() => assertExecutionAccess("WRITE",["SHELL","FILE_WRITE"],all)).not.toThrow();
    const shellWriter = localExecutionCapabilities(createPartnerRevision({ ...base,tools: ["bash"],toolPolicyMode: "CUSTOM" }));
    expect(() => assertExecutionAccess("WRITE",["SHELL","FILE_WRITE"],shellWriter)).not.toThrow();
    const codex = localExecutionCapabilities(createPartnerRevision({ ...base,engine: "codex",codexPermissions: { approvalPolicy: "never",sandboxMode: "read-only",networkAccessEnabled: false,webSearchMode: "disabled" } }));
    expect(() => assertExecutionAccess("READ",["SHELL"],codex)).not.toThrow();
    expect(() => assertExecutionAccess("WRITE",["FILE_WRITE"],codex)).toThrow();
  });
});
