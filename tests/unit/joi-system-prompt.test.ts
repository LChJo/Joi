import { buildJoiSystemPrompt } from "../../src/main/application/joi/joi-system-prompt.js";

const base = {
  avatarName: "Rex",
  personaSummary: "PERSONA_SENTINEL",
  projectLabel: "digital-life",
  scopeSummary: "SCOPE_SENTINEL",
  taskContextSummary: "TASK_SENTINEL",
};

describe("joi system prompt", () => {
  it("encodes the wayfinder orchestration method and injects the avatar context", () => {
    const prompt = buildJoiSystemPrompt(base);
    expect(prompt).toContain("foreman, never a worker");
    expect(prompt).toContain("Name the destination first");
    expect(prompt).toContain("do not spin up a team for a one-person job");
    expect(prompt).toContain("AFK");
    expect(prompt).toContain("HITL");
    expect(prompt).toContain("Agent-Brief skeleton");
    expect(prompt).toContain("out-of-scope");
    expect(prompt).toContain("model_list_sources");
    expect(prompt).toContain("pi-core engine");
    expect(prompt).toContain("sessionPolicy ephemeral");
    expect(prompt).toContain("Claim before work");
    expect(prompt).toContain("working-memory digest");
    expect(prompt).toContain("one opinionated answer");
    expect(prompt).toContain("Team-building requests are AFK-direct");
    expect(prompt).toContain("concrete options");
    expect(prompt).toContain("turn_complete");
    expect(prompt).toContain("Every Turn that uses a tool");
    expect(prompt).toContain("Avatar: Rex");
    expect(prompt).toContain("PERSONA_SENTINEL");
    expect(prompt).toContain("SCOPE_SENTINEL");
    expect(prompt).toContain("TASK_SENTINEL");
    expect(prompt).toContain("Project: digital-life");
    expect(prompt).not.toContain("not tool-verified");
    expect(prompt).not.toContain("Attachments:");
  });

  it("adds the fail-closed instruction and attachment list only when present", () => {
    const prompt = buildJoiSystemPrompt({
      ...base,
      attachments: [{ attachmentId: "att_1", filename: "brief.txt", mimeType: "text/plain", size: 5 }],
      modelCapability: "custom-unverified-tools",
    });
    expect(prompt).toContain("not tool-verified");
    expect(prompt).toContain("Attachments: att_1 brief.txt text/plain 5 bytes");
  });
});
