import type { Clock, IdGenerator } from "../application/ports/runtime-store.js";
import type { RuntimeDiagnostics } from "../application/ports/runtime-diagnostics.js";
import type { PartnerEngineRuntime } from "../application/ports/partner-instances.js";
import { PartnerKnowledgeService } from "../application/partners/partner-knowledge-service.js";
import { PartnerModelProbeService } from "../application/partners/partner-model-probe-service.js";
import { PartnerRegistryService } from "../application/partners/partner-registry-service.js";
import { ScenarioPackService } from "../application/partners/scenario-pack-service.js";
import { PartnerEngineCatalog } from "../application/partners/partner-engine-catalog.js";
import { PartnerInstanceManager } from "../application/partners/partner-instance-manager.js";
import { PartnerWorkMemoryService } from "../application/partners/partner-work-memory-service.js";
import { LocalSkillScanner } from "../infrastructure/skills/local-skill-scanner.js";
import { BuiltinPiCodingToolFactory } from "../infrastructure/pi/pi-coding-tool-factory.js";
import { PiPartnerEngineRuntime } from "../infrastructure/pi/pi-partner-engine-runtime.js";
import { PiPartnerMemorySummarizer } from "../infrastructure/pi/pi-partner-memory-summarizer.js";
import { LocalCliPartnerEngineRuntime } from "../infrastructure/mana/local-cli-partner-engine-runtime.js";
import type { ModelSourceBundle } from "./wire-model-sources.js";
import type { PersistenceBundle } from "./wire-persistence.js";

export function wirePartners(input: {
  clock: Clock;
  diagnostics: RuntimeDiagnostics;
  ids: IdGenerator;
  modelSourceStack: ModelSourceBundle;
  persistence: PersistenceBundle;
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
  const partnerEngines = new Map<string, PartnerEngineRuntime>([
    ["pi-core", new PiPartnerEngineRuntime({
      contexts: persistence.workbenchContextRepository,
      prompts: persistence.partnerPromptStore,
      resolver: modelSourceStack.configuredModelResolver,
      sources: modelSourceStack.reasoningSources,
      tools: new BuiltinPiCodingToolFactory(),
    })],
    ["claude-code", new LocalCliPartnerEngineRuntime({
      contexts: persistence.workbenchContextRepository,
      prompts: persistence.partnerPromptStore,
      protocol: "claude",
      store: persistence.localCliConversationStore,
    })],
    ["codex", new LocalCliPartnerEngineRuntime({
      contexts: persistence.workbenchContextRepository,
      prompts: persistence.partnerPromptStore,
      protocol: "codex",
      store: persistence.localCliConversationStore,
    })],
  ]);
  const scenarioPacks = new ScenarioPackService({ clock, ids, partners, repository: persistence.scenarioPackRepository, skills: partnerSkillCatalog });
  return {
    engineCatalog: new PartnerEngineCatalog(partnerEngines),
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
    partnerModelProbe: new PartnerModelProbeService({ clock, partners, sources: modelSourceStack.modelSources }),
    partnerMemory: new PartnerWorkMemoryService({
      clock,
      ids,
      store: persistence.partnerWorkMemoryStore,
      summarizer: new PiPartnerMemorySummarizer({
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
