/* Adapter runner doubles resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import type { PartnerRunRequest } from "../../src/main/application/ports/partner-execution.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { A2aPartnerAdapter } from "../../src/main/infrastructure/a2a/a2a-partner-adapter.js";
import { LocalPiPartnerAdapter } from "../../src/main/infrastructure/pi/local-pi-partner-adapter.js";

const request: PartnerRunRequest = { actionId: "action-1", avatarId: "avatar-1", taskProjection: "bounded task", workId: "work-1" };

describe("local-pi-and-a2a-partner-contract", () => {
  it("normalizes both adapters and pins execution to the supplied immutable revision", async () => {
    const localRevision = createPartnerRevision({
      capabilities: ["write"], createdAt: "2026-07-28T10:00:00.000Z", displayName: "Local",
      kind: "local-pi", partnerId: "local", partnerRevisionId: "local-r1", registryRevision: 1,
      skills: [], tools: ["edit"], workspaceRef: "workspace-ref",
    });
    const a2aRevision = createPartnerRevision({
      capabilities: ["research"], createdAt: "2026-07-28T10:00:00.000Z", displayName: "Remote",
      kind: "a2a", partnerId: "remote", partnerRevisionId: "remote-r1", registryRevision: 2,
      skills: ["web"], tools: [],
    });
    const local = new LocalPiPartnerAdapter({ run: async (received, revision) => ({ externalRunId: `${revision.partnerRevisionId}:${received.actionId}`, status: "COMPLETED" }) });
    const a2a = new A2aPartnerAdapter({ dispatch: async (received, revision) => ({ externalRunId: `${revision.partnerRevisionId}:${received.actionId}`, status: "WAITING_INPUT" }) });
    expect(await local.run(request, localRevision)).toEqual({ actionId: "action-1", externalRunId: "local-r1:action-1", status: "COMPLETED", workId: "work-1" });
    expect(await a2a.run(request, a2aRevision)).toEqual({ actionId: "action-1", externalRunId: "remote-r1:action-1", status: "WAITING_INPUT", workId: "work-1" });
  });

  it("fails closed on kind mismatch and a local partner without a workspace", async () => {
    const local = new LocalPiPartnerAdapter({ run: async () => ({ externalRunId: "never", status: "COMPLETED" }) });
    const remote = createPartnerRevision({ capabilities: [], createdAt: "2026-07-28T10:00:00.000Z", displayName: "Remote", kind: "a2a", partnerId: "remote", partnerRevisionId: "r1", registryRevision: 1, skills: [], tools: [] });
    await expect(local.run(request, remote)).rejects.toThrow(/local Pi/iu);
  });
});
