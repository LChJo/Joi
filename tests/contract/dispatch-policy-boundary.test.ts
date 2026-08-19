import { readFile } from "node:fs/promises";

const REASON_LITERALS = [
  "a2a_workspace_access_forbidden",
  "workbench_workspace_not_ready",
  "workspace_lease_conflict",
] as const;

describe("dispatch policy boundary", () => {
  it("defines dispatch policy reason codes in the application layer", async () => {
    const policy = await readFile("src/main/application/work/dispatch-policy.ts", "utf8");
    for (const reason of REASON_LITERALS) {
      expect(policy).toContain(`"${reason}"`);
    }
  });

  it("does not redefine dispatch policy reasons inside infrastructure adapters", async () => {
    const gate = await readFile("src/main/infrastructure/persistence/sqlite-dispatch-policy-gate.ts", "utf8");
    const delivery = await readFile("src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.ts", "utf8");
    for (const reason of REASON_LITERALS) {
      expect(gate).not.toContain(`"${reason}"`);
      expect(delivery).not.toContain(`"${reason}"`);
    }
    expect(gate).toContain("evaluateDispatchPolicy");
    expect(delivery).toContain("evaluateDispatchPolicy");
    expect(delivery).not.toContain('row.workspace_status !== "READY"');
  });
});
