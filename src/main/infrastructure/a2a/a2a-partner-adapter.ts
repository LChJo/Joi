import type { PartnerExecutor, PartnerRunRequest, PartnerRunResult, PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";

interface A2aPartnerRunner {
  dispatch(request: PartnerRunRequest, revision: PartnerRevision): Promise<{ externalRunId: string; status: PartnerRunStatus }>;
}

export class A2aPartnerAdapter implements PartnerExecutor {
  constructor(private readonly runner: A2aPartnerRunner) {}

  async run(request: PartnerRunRequest, revision: PartnerRevision): Promise<PartnerRunResult> {
    if (revision.kind !== "a2a") throw new Error("A2A adapter requires an A2A partner revision");
    const result = await this.runner.dispatch(request, revision);
    return { actionId: request.actionId, artifacts: [], body: "", externalRunId: result.externalRunId, status: result.status, workId: request.workId };
  }
}
