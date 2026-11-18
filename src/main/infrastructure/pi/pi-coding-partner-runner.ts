import type { PartnerAdapterRunner, PartnerPromptStore, PartnerRunRequest } from "../../application/ports/partner-execution.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { WorkbenchExecutionContextReader } from "../../application/ports/workbench-context.js";
import type { PartnerSkillCatalog } from "../../application/ports/partner-skills.js";
import type { ReasoningSourceSelector } from "../../application/model-sources/reasoning-source-selector.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import type { RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";
import type { PiConfiguredModelResolver } from "./pi-configured-model-resolver.js";
import type { PiCodingToolFactory } from "./pi-coding-tool-factory.js";
import { PiPartnerEngineRuntime } from "./pi-partner-engine-runtime.js";

/** Compatibility entry delegates to the same SDK execution boundary as resident partners. */
export class PiCodingPartnerRunner implements PartnerAdapterRunner {
  readonly #runtime: PiPartnerEngineRuntime;
  constructor(private readonly dependencies: {
    usage?: UsageRecorder; diagnostics?: RuntimeDiagnostics; contexts: WorkbenchExecutionContextReader;
    prompts: Pick<PartnerPromptStore, "read">; resolver: PiConfiguredModelResolver; tools: PiCodingToolFactory;
    skills?: Pick<PartnerSkillCatalog, "resolveForPi">;
    sources: Pick<ReasoningSourceSelector, "selectInitial"> & Partial<Pick<ReasoningSourceSelector, "selectById">>;
  }) { this.#runtime = new PiPartnerEngineRuntime(dependencies); }

  async run(request: PartnerRunRequest, revision: PartnerRevision) {
    const skills = this.dependencies.skills?.resolveForPi(revision.skills);
    const result = await this.#runtime.runEphemeral(request, revision, { knowledgeSection: "", skillSection: skills?.promptSection ?? "", skillEnvironmentKeys: skills?.environmentKeys ?? [],
      ...(skills?.skillPaths === undefined ? {} : { skillPaths: skills.skillPaths }) });
    if (result.status === "SUSPENDED") throw new Error("pi_session_unsettled");
    return { externalRunId: result.externalRunId, output: result.output, status: result.status };
  }
}
