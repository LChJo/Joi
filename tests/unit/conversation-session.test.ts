import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { conversationSeedMessages,pairSessionTools,sessionAssistant } from "../../src/main/infrastructure/pi/conversation-session.js";
import { withRequestPrompt } from "../../src/main/infrastructure/pi/pi-request-prompt.js";

it("CHAT-29 excludes UI activity from legacy model history",() => {
  const history = conversationSeedMessages({ actionId: "a",contextSnapshotId: "s",workbenchId: "wb",workId: "w",taskProjection: "Next",
    conversationHistory: [{ turnId: "old",text: "Original task",status: "COMPLETED",config: { partnerId: "p",partnerName: "p",networkId: "n",networkName: "n",modelName: "m",skills: [],attachmentIds: [] },entries: [
      { kind: "ACTIVITY",entryId: "activity",sequence: 1,createdAt: "2026-11-12",role: "SYSTEM",activity: { type: "THINKING",thinking: { phaseId: "phase",state: "COMPLETED",summary: "UI_ONLY_SUMMARY" } } },
      { kind: "MARKDOWN",entryId: "answer",sequence: 2,createdAt: "2026-11-12",role: "AGENT",text: "Retained answer" },
    ] }] });
  expect(JSON.stringify(history)).toContain("Retained answer");expect(JSON.stringify(history)).not.toContain("UI_ONLY_SUMMARY");
});

it("CHAT-25 preserves parallel native calls and complete results when transferring to Pi",() => {
  const a = sessionAssistant([{ type: "toolCall",id: "a",name: "Read",arguments: { path: "a" } }]);
  const b = sessionAssistant([{ type: "toolCall",id: "b",name: "Read",arguments: { path: "b" } }]);
  const ra: AgentMessage = { role: "toolResult",toolCallId: "a",toolName: "Read",content: [{ type: "text",text: "COMPLETE_A" }],isError: false,timestamp: 2 };
  const rb: AgentMessage = { ...ra,toolCallId: "b",content: [{ type: "text",text: "BUSINESS_FAILURE_B" }],isError: true };
  const source = [a,b,rb,ra];const original = JSON.stringify(source);
  const request = pairSessionTools(source);
  expect(request).toEqual([a,ra,b,rb]);expect(JSON.stringify(source)).toBe(original);
  expect(JSON.stringify(request)).not.toContain("unrecorded");
});
it("CHAT-18/20 replaces duplicate SDK prompt projections while retaining tool declarations",() => {
  const messages: AgentMessage[] = [{ role: "system",content: "STALE_POLICY",timestamp: 0 },{ role: "system",content: "STALE_POLICY",sections: { instructions: "STALE_POLICY" },toolsAdded: [{ name: "read",description: "Read",parameters: {} }],timestamp: 1 }];
  const request = withRequestPrompt(messages,"CURRENT_POLICY");
  expect(JSON.stringify(request)).not.toContain("STALE_POLICY");expect(JSON.stringify(request)).toContain("CURRENT_POLICY");
  expect(JSON.stringify(request)).toContain('"name":"read"');expect(JSON.stringify(messages)).toContain("STALE_POLICY");
});
