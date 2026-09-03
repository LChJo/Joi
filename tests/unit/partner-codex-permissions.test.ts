import {
  DEFAULT_CODEX_PERMISSIONS,
  legacyToolPolicyMode,
  legacyCodexPermissions,
  normalizeCodexPermissions,
} from "../../src/main/domain/partners/partner.js";

describe("Codex partner permissions", () => {
  it("defaults new Codex partners to workspace write with network and live search", () => {
    expect(DEFAULT_CODEX_PERMISSIONS).toEqual({
      approvalPolicy: "never",
      networkAccessEnabled: true,
      sandboxMode: "workspace-write",
      webSearchMode: "live",
    });
  });

  it("interprets legacy empty tools as ALL and non-empty tools as CUSTOM", () => {
    expect(legacyToolPolicyMode([])).toBe("ALL");
    expect(legacyToolPolicyMode(["read"])).toBe("CUSTOM");
  });

  it("uses the safe default and maps each legacy tool policy deterministically", () => {
    expect(normalizeCodexPermissions(undefined)).toEqual(DEFAULT_CODEX_PERMISSIONS);
    expect(legacyCodexPermissions([])).toEqual({
      approvalPolicy: "never",
      networkAccessEnabled: true,
      sandboxMode: "workspace-write",
      webSearchMode: "live",
    });
    expect(legacyCodexPermissions(["read"])).toMatchObject({
      networkAccessEnabled: false,
      sandboxMode: "read-only",
      webSearchMode: "disabled",
    });
    expect(legacyCodexPermissions(["shell"])).toMatchObject({
      networkAccessEnabled: false,
      sandboxMode: "workspace-write",
      webSearchMode: "disabled",
    });
    expect(legacyCodexPermissions(["web_search"])).toMatchObject({
      networkAccessEnabled: true,
      sandboxMode: "read-only",
      webSearchMode: "live",
    });
  });

  it.each([
    { approvalPolicy: "on-request", networkAccessEnabled: false, sandboxMode: "read-only", webSearchMode: "disabled" },
    { approvalPolicy: "never", networkAccessEnabled: false, sandboxMode: "danger-full-access", webSearchMode: "disabled" },
    { approvalPolicy: "never", networkAccessEnabled: false, sandboxMode: "read-only", webSearchMode: "unknown" },
    { approvalPolicy: "never", networkAccessEnabled: "yes", sandboxMode: "read-only", webSearchMode: "disabled" },
  ])("rejects an invalid permission shape", (permissions) => {
    expect(() => normalizeCodexPermissions(permissions as never)).toThrow("Codex permissions are invalid.");
  });
});
