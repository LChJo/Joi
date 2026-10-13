import { assertCodexWorkspaceProtocol } from "../../src/main/infrastructure/mana/codex-workspace-capabilities.js";

describe("AC-WR-04 native CLI capability gate", () => {
  it.each(["current", "classic"])("probes the actual read-only sandbox syntax of a %s CLI", async variant => {
    const calls: string[][] = [];
    await expect(assertCodexWorkspaceProtocol("fixture", (_executable, args) => {
      calls.push(args);
      if (args[0] === "exec") return Promise.resolve("--sandbox read-only workspace-write --output-schema --json");
      if (args[1] === "--help") return Promise.resolve(variant === "current" ? "--permission-profile" : "macos linux windows");
      if (variant === "classic" && args.includes("-P")) return Promise.reject(new Error("unsupported_profile_flag"));
      return Promise.resolve("verified");
    })).resolves.toBeUndefined();
    expect(calls).toContainEqual(["sandbox", "--help"]);
    expect(calls.at(-1)?.includes("-P")).toBe(variant === "current");
  });
  it("rejects CLI without read-only, schema and resume support before model execution", async () => {
    await expect(assertCodexWorkspaceProtocol("unsupported", () => Promise.resolve("old CLI"))).rejects.toMatchObject({ code: "codex_workspace_protocol_unsupported" });
  });
});
