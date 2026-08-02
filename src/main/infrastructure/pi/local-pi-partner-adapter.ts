import type { PartnerAdapterRunner, PartnerExecutor, PartnerRunRequest, PartnerRunResult } from "../../application/ports/partner-execution.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";

export class LocalPiPartnerAdapter implements PartnerExecutor {
  constructor(private readonly runner: PartnerAdapterRunner) {}

  async run(request: PartnerRunRequest, revision: PartnerRevision): Promise<PartnerRunResult> {
    if (revision.kind !== "local-pi") throw new Error("local Pi adapter requires a local Pi partner revision");
    const result = await this.runner.run(request, revision);
    return {
      actionId: request.actionId,
      artifacts: result.output.artifacts,
      body: result.output.body,
      externalRunId: result.externalRunId,
      status: result.status,
      workId: request.workId,
    };
  }
}
