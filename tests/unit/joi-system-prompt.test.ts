import { buildJoiSystemPrompt } from "../../src/main/application/joi/joi-system-prompt.js";

const base = {
  workbenchName: "Rex",
  personaSummary: "PERSONA_SENTINEL",
  projectLabel: "digital-life",
  scopeSummary: "SCOPE_SENTINEL",
  taskContextSummary: "TASK_SENTINEL",
};

describe("joi system prompt", () => {
  it("requires actionable context for a continuation decision", () => {
    const prompt = buildJoiSystemPrompt(base);
    expect(prompt).toContain("For RESULT_CONTINUE, make the visible answer explain what is already established, what specifically remains unverified or missing, why it matters to the original goal, and what the next bounded evidence layer will try");
    expect(prompt).toContain("Do not merely say there are gaps or promise that another layer will resolve them");
  });

  it("encodes the wayfinder orchestration method and injects the workbench context", () => {
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
    expect(prompt).toContain("RETRY_REQUIRED");
    expect(prompt).toContain("Retry work_dispatch only once in the same Turn");
    expect(prompt).toContain("never substitute a partnerId or partnerRevisionId for instanceId");
    expect(prompt).toContain("Claim before work");
    expect(prompt).toContain("working-memory digest");
    expect(prompt).toContain("prefer a different suitable available partner");
    expect(prompt.indexOf("prefer a different suitable available partner")).toBeLessThan(prompt.indexOf("partner_set_model"));
    expect(prompt).toContain("one opinionated answer");
    expect(prompt).toContain("Team-building requests are AFK-direct");
    expect(prompt).toContain("durable capability cluster");
    expect(prompt).toContain("concrete options");
    expect(prompt).toContain("turn_complete");
    expect(prompt).toContain("Every Turn that uses a tool");
    expect(prompt).toContain("Use BODY_PRESENT for a textual answer");
    expect(prompt).toContain("always declare at least one acceptance check");
    expect(prompt).toContain("never an absolute or external path");
    expect(prompt).toContain("Grill the spec before dispatch");
    expect(prompt).toContain("one focused alignment question per turn");
    expect(prompt).toContain("Every dispatched work must carry the aligned spec");
    expect(prompt).toContain("Acceptance checks verify only this Work's own deliverable");
    expect(prompt).toContain("copy expectedText verbatim from its actual content");
    expect(prompt).toContain("Never dispatch a bare title");
    expect(prompt).toContain("copy it exactly as workspacePath");
    expect(prompt).toContain("never invent or broaden a path");
    expect(prompt).toContain("otherwise persists a user-visible clarification");
    expect(prompt).toContain("Maintain the goal map");
    expect(prompt).toContain("merge repeated supplements, apply explicit user corrections");
    expect(prompt).toContain("Partners receive the brief, not that history");
    expect(prompt).toContain("complete effective requirement list");
    expect(prompt).toContain("work_resume with complete replacement instructions");
    expect(prompt).toContain("harness_name_destination");
    expect(prompt).toContain("harness_chart_path");
    expect(prompt).toContain("harness_record_decision");
    expect(prompt).toContain("harness_note_fog");
    expect(prompt).toContain("Only advance to the next layer once the current layer's paths are complete");
    expect(prompt).toContain("Harness review turns resolve at most one decision");
    expect(prompt).toContain("MAP_CLEARED");
    expect(prompt).not.toContain("harness_refine_workbench");
    expect(prompt).toContain("never broaden");
    expect(prompt).toContain("Workbench: Rex");
    expect(prompt).toContain("Workbench workspace: no directory bound yet — file work needs workbench_bind_workspace first");
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
    expect(prompt).toContain("Attachment delivery: text attachments are inlined in the user message");
    expect(prompt).toContain("attachment_read");
    expect(prompt).toContain("Never invent attachment content");
  });

  it("reports the current workspace binding so a bound directory is never re-asked", () => {
    const prompt = buildJoiSystemPrompt({
      ...base,
      workspace: { displayName: "Zgame_20190440", kind: "BOUND", status: "READY" },
    });
    expect(prompt).toContain("Workbench workspace: Zgame_20190440 · BOUND · READY");
    expect(prompt).toContain("not READY, call workbench_bind_workspace before dispatching");
    expect(prompt).toContain("the tool reports the existing binding when one is already READY");
  });

  it("tells joi that partner work auto-receives the input attachments staged in the workspace", () => {
    const prompt = buildJoiSystemPrompt(base);
    expect(prompt).toContain("joi-attachments/<attachmentId>/<filename>");
    expect(prompt).toContain("read-only inputs");
  });
});
