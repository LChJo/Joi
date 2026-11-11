import type { Clock, IdGenerator } from "../application/ports/runtime-store.js";
import type { RuntimeDiagnostics } from "../application/ports/runtime-diagnostics.js";
import type { PartnerEngineRuntime } from "../application/ports/partner-instances.js";
import { PartnerKnowledgeService } from "../application/partners/partner-knowledge-service.js";
import { PartnerModelProbeService } from "../application/partners/partner-model-probe-service.js";
import { PartnerRegistryService } from "../application/partners/partner-registry-service.js";
import { ScenarioPackService } from "../application/partners/scenario-pack-service.js";
import { PartnerEngineCatalog } from "../application/partners/partner-engine-catalog.js";
import { PartnerInstanceManager } from "../application/partners/partner-instance-manager.js";
import { NATIVE_RUN_DEADLINES } from "../application/partners/partner-run-deadlines.js";
import { PartnerWorkMemoryService } from "../application/partners/partner-work-memory-service.js";
import { LocalSkillScanner } from "../infrastructure/skills/local-skill-scanner.js";
import { BuiltinPiCodingToolFactory } from "../infrastructure/pi/pi-coding-tool-factory.js";
import { PiPartnerEngineRuntime } from "../infrastructure/pi/pi-partner-engine-runtime.js";
import { PiPartnerMemorySummarizer } from "../infrastructure/pi/pi-partner-memory-summarizer.js";
import { ClaudeAgentSdkPartnerEngineRuntime } from "../infrastructure/mana/claude-agent-sdk-partner-engine-runtime.js";
import { CodexAgentSdkPartnerEngineRuntime } from "../infrastructure/mana/codex-agent-sdk-partner-engine-runtime.js";
import type { ModelSourceBundle } from "./wire-model-sources.js";
import type { PersistenceBundle } from "./wire-persistence.js";
import path from "node:path";

export function wirePartners(input: {
  clock: Clock;
  diagnostics: RuntimeDiagnostics;
  ids: IdGenerator;
  modelSourceStack: ModelSourceBundle;
  persistence: PersistenceBundle;
  userDataDirectory: string;
}) {
  const { clock, diagnostics, ids, modelSourceStack, persistence } = input;
  const partnerSkillCatalog = new LocalSkillScanner();
  const partnerKnowledge = new PartnerKnowledgeService({ clock, ids, store: persistence.partnerKnowledgeStore });
  const partners = new PartnerRegistryService({
    clock,
    ids,
    knowledge: partnerKnowledge,
    modelSources: modelSourceStack.modelSources,
    prompts: persistence.partnerPromptStore,
    repository: persistence.partnerRegistryRepository,
    skills: partnerSkillCatalog,
  });
  const piRuntime = new PiPartnerEngineRuntime({
      usage: modelSourceStack.statistics,
      diagnostics,
      contexts: persistence.workbenchContextRepository,
      prompts: persistence.partnerPromptStore,
      resolver: modelSourceStack.configuredModelResolver,
      sources: modelSourceStack.reasoningSources,
      tools: new BuiltinPiCodingToolFactory(),
    });
  const partnerEngines = new Map<string, PartnerEngineRuntime>([
    ["pi-core", piRuntime],
    ["claude-code", new ClaudeAgentSdkPartnerEngineRuntime({
      evidenceDirectory: path.join(input.userDataDirectory, "task-inputs"),
      usage: modelSourceStack.statistics,
      contexts: persistence.workbenchContextRepository,
      deadlines: { ...NATIVE_RUN_DEADLINES },
      diagnostics,
      prompts: persistence.partnerPromptStore,
    })],
    ["codex", new CodexAgentSdkPartnerEngineRuntime({
      evidenceDirectory: path.join(input.userDataDirectory, "task-inputs"),
      usage: modelSourceStack.statistics,
      contexts: persistence.workbenchContextRepository,
      deadlines: { ...NATIVE_RUN_DEADLINES },
      diagnostics,
      prompts: persistence.partnerPromptStore,
    })],
  ]);
  const scenarioPacks = new ScenarioPackService({ clock, ids, partners, repository: persistence.scenarioPackRepository, skills: partnerSkillCatalog });
  const engineCatalog = new PartnerEngineCatalog(partnerEngines);
  return {
    piRuntime,
    engineCatalog,
    partnerInstances: new PartnerInstanceManager({
      clock,
      diagnostics,
      engines: partnerEngines,
      ids,
      knowledge: partnerKnowledge,
      messages: persistence.partnerInstanceMessageStore,
      registry: partners,
      repository: persistence.partnerInstanceRepository,
      revisions: persistence.partnerRegistryRepository,
      skills: partnerSkillCatalog,
    }),
    partnerKnowledge,
    partnerModelProbe: new PartnerModelProbeService({ clock, engines: engineCatalog, partners, sources: modelSourceStack.modelSources }),
    partnerMemory: new PartnerWorkMemoryService({
      diagnostics,
      clock,
      ids,
      store: persistence.partnerWorkMemoryStore,
      summarizer: new PiPartnerMemorySummarizer({
        usage: modelSourceStack.statistics,
        resolver: modelSourceStack.configuredModelResolver,
        sources: modelSourceStack.reasoningSources,
      }),
    }),
    partnerSkillCatalog,
    partners,
    scenarioPacks,
  };
}

export type PartnerBundle = ReturnType<typeof wirePartners>;
