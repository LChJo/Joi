export type DirectModelSourceKind = "kimi" | "glm" | "qwen" | "doubao" | "minimax" | "deepseek";
export type ModelSourceOptionKind = DirectModelSourceKind | "generic-openai";

export interface ModelPresetEntry {
  id: string;
  label: string;
  toolCapability: "release-tested";
}

export interface DirectModelSourcePreset {
  defaultModelId: string;
  endpoint: string;
  endpointEditable: false;
  kind: DirectModelSourceKind;
  label: string;
  models: readonly ModelPresetEntry[];
  piProviderFamily: "builtin" | "openai-compatible";
  presetVersion: "2026-07-28";
}

const model = (id: string, label: string): ModelPresetEntry => ({ id, label, toolCapability: "release-tested" });

export const MODEL_SOURCE_PRESETS = [
  {
    defaultModelId: "kimi-k2.5",
    endpoint: "https://api.moonshot.cn/v1",
    endpointEditable: false,
    kind: "kimi",
    label: "Kimi",
    models: [model("kimi-k2.5", "Kimi K2.5"), model("kimi-k2-turbo-preview", "Kimi K2 Turbo")],
    piProviderFamily: "builtin",
    presetVersion: "2026-07-28",
  },
  {
    defaultModelId: "glm-4.7",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    endpointEditable: false,
    kind: "glm",
    label: "GLM",
    models: [model("glm-4.7", "GLM-4.7"), model("glm-4.5", "GLM-4.5")],
    piProviderFamily: "openai-compatible",
    presetVersion: "2026-07-28",
  },
  {
    defaultModelId: "qwen3.5-plus",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    endpointEditable: false,
    kind: "qwen",
    label: "Qwen",
    models: [model("qwen3.5-plus", "Qwen 3.5 Plus"), model("qwen-plus", "Qwen Plus")],
    piProviderFamily: "openai-compatible",
    presetVersion: "2026-07-28",
  },
  {
    defaultModelId: "doubao-seed-2-0-pro-260215",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    endpointEditable: false,
    kind: "doubao",
    label: "Doubao",
    models: [model("doubao-seed-2-0-pro-260215", "Doubao Seed 2.0 Pro"), model("doubao-seed-1-8-251228", "Doubao Seed 1.8")],
    piProviderFamily: "openai-compatible",
    presetVersion: "2026-07-28",
  },
  {
    defaultModelId: "MiniMax-M2.5",
    endpoint: "https://api.minimaxi.com/v1",
    endpointEditable: false,
    kind: "minimax",
    label: "MiniMax",
    models: [model("MiniMax-M2.5", "MiniMax M2.5"), model("MiniMax-M2.1", "MiniMax M2.1")],
    piProviderFamily: "builtin",
    presetVersion: "2026-07-28",
  },
  {
    defaultModelId: "deepseek-chat",
    endpoint: "https://api.deepseek.com",
    endpointEditable: false,
    kind: "deepseek",
    label: "DeepSeek",
    models: [model("deepseek-chat", "DeepSeek Chat"), model("deepseek-reasoner", "DeepSeek Reasoner")],
    piProviderFamily: "builtin",
    presetVersion: "2026-07-28",
  },
] as const satisfies readonly DirectModelSourcePreset[];

export const MODEL_SOURCE_OPTIONS = [
  ...MODEL_SOURCE_PRESETS.map(({ kind, label }) => ({ kind, label, mode: "direct" as const })),
  { kind: "generic-openai", label: "通用平台", mode: "openai-compatible" as const },
] as const;

export function getDirectModelSourcePreset(kind: DirectModelSourceKind): DirectModelSourcePreset {
  const preset = MODEL_SOURCE_PRESETS.find((candidate) => candidate.kind === kind);
  if (preset === undefined) throw new Error("unknown_model_source_preset");
  return preset;
}
