import type { ModelSourceAccessMode, ModelSourceProtocol } from "../../domain/model-sources/model-source.js";

export type DirectModelSourceKind = "kimi" | "glm" | "qwen" | "doubao" | "minimax" | "deepseek";
export type ModelSourceOptionKind = DirectModelSourceKind | "generic-openai";

export interface ModelPresetEntry {
  id: string;
  label: string;
  toolCapability: "release-tested";
}

export interface DirectModelSourcePreset {
  accessMode: Exclude<ModelSourceAccessMode, "custom">;
  defaultModelId: string;
  endpoint: string;
  endpointEditable: false;
  kind: DirectModelSourceKind;
  label: string;
  models: readonly ModelPresetEntry[];
  piProviderFamily: "anthropic-compatible" | "builtin" | "openai-compatible";
  presetVersion: string;
  protocol: ModelSourceProtocol;
}

const model = (id: string, label: string): ModelPresetEntry => ({ id, label, toolCapability: "release-tested" });
const presetVersion = "2026-07-30";

export const MODEL_SOURCE_PRESETS = [
  {
    accessMode: "api", defaultModelId: "kimi-k2.5", endpoint: "https://api.moonshot.cn/v1", endpointEditable: false,
    kind: "kimi", label: "Kimi API", models: [model("kimi-k2.5", "Kimi K2.5"), model("kimi-k2.6", "Kimi K2.6")],
    piProviderFamily: "builtin", presetVersion, protocol: "openai",
  },
  {
    accessMode: "coding-plan", defaultModelId: "kimi-for-coding", endpoint: "https://api.kimi.com/coding/v1", endpointEditable: false,
    kind: "kimi", label: "Kimi Code", models: [model("k3", "Kimi K3"), model("k3-256k", "Kimi K3-256K"), model("kimi-for-coding", "Kimi K2.7 Code"), model("kimi-for-coding-highspeed", "Kimi K2.7 Code HighSpeed")],
    piProviderFamily: "openai-compatible", presetVersion, protocol: "openai",
  },
  {
    accessMode: "coding-plan", defaultModelId: "kimi-for-coding", endpoint: "https://api.kimi.com/coding", endpointEditable: false,
    kind: "kimi", label: "Kimi Code", models: [model("k3", "Kimi K3"), model("k3-256k", "Kimi K3-256K"), model("kimi-for-coding", "Kimi K2.7 Code"), model("kimi-for-coding-highspeed", "Kimi K2.7 Code HighSpeed")],
    piProviderFamily: "anthropic-compatible", presetVersion, protocol: "anthropic",
  },
  {
    accessMode: "api", defaultModelId: "glm-4.7", endpoint: "https://open.bigmodel.cn/api/paas/v4", endpointEditable: false,
    kind: "glm", label: "GLM API", models: [model("glm-4.7", "GLM-4.7"), model("glm-4.5", "GLM-4.5")],
    piProviderFamily: "openai-compatible", presetVersion, protocol: "openai",
  },
  {
    accessMode: "coding-plan", defaultModelId: "glm-5.2", endpoint: "https://open.bigmodel.cn/api/coding/paas/v4", endpointEditable: false,
    kind: "glm", label: "GLM Coding Plan", models: [model("glm-5.2", "GLM-5.2"), model("glm-4.7", "GLM-4.7")],
    piProviderFamily: "openai-compatible", presetVersion, protocol: "openai",
  },
  {
    accessMode: "coding-plan", defaultModelId: "glm-5.2", endpoint: "https://open.bigmodel.cn/api/anthropic", endpointEditable: false,
    kind: "glm", label: "GLM Coding Plan", models: [model("glm-5.2", "GLM-5.2"), model("glm-4.7", "GLM-4.7")],
    piProviderFamily: "anthropic-compatible", presetVersion, protocol: "anthropic",
  },
  {
    accessMode: "api", defaultModelId: "qwen3.5-plus", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", endpointEditable: false,
    kind: "qwen", label: "Qwen API", models: [model("qwen3.5-plus", "Qwen 3.5 Plus"), model("qwen-plus", "Qwen Plus")],
    piProviderFamily: "openai-compatible", presetVersion, protocol: "openai",
  },
  {
    accessMode: "api", defaultModelId: "qwen3.5-plus", endpoint: "https://dashscope.aliyuncs.com/apps/anthropic", endpointEditable: false,
    kind: "qwen", label: "Qwen API", models: [model("qwen3.5-plus", "Qwen 3.5 Plus"), model("qwen-plus", "Qwen Plus")],
    piProviderFamily: "anthropic-compatible", presetVersion, protocol: "anthropic",
  },
  {
    accessMode: "coding-plan", defaultModelId: "qwen3.7-plus", endpoint: "https://coding.dashscope.aliyuncs.com/v1", endpointEditable: false,
    kind: "qwen", label: "百炼 Coding Plan", models: [model("qwen3.7-plus", "Qwen 3.7 Plus"), model("qwen3-coder-next", "Qwen 3 Coder Next")],
    piProviderFamily: "openai-compatible", presetVersion, protocol: "openai",
  },
  {
    accessMode: "coding-plan", defaultModelId: "qwen3.7-plus", endpoint: "https://coding.dashscope.aliyuncs.com/apps/anthropic", endpointEditable: false,
    kind: "qwen", label: "百炼 Coding Plan", models: [model("qwen3.7-plus", "Qwen 3.7 Plus"), model("qwen3-coder-next", "Qwen 3 Coder Next")],
    piProviderFamily: "anthropic-compatible", presetVersion, protocol: "anthropic",
  },
  {
    accessMode: "api", defaultModelId: "doubao-seed-2-0-pro-260215", endpoint: "https://ark.cn-beijing.volces.com/api/v3", endpointEditable: false,
    kind: "doubao", label: "Doubao API", models: [model("doubao-seed-2-0-pro-260215", "Doubao Seed 2.0 Pro"), model("doubao-seed-1-8-251228", "Doubao Seed 1.8")],
    piProviderFamily: "openai-compatible", presetVersion, protocol: "openai",
  },
  {
    accessMode: "coding-plan", defaultModelId: "ark-code-latest", endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3", endpointEditable: false,
    kind: "doubao", label: "方舟 Coding Plan", models: [model("ark-code-latest", "Ark Code Latest"), model("doubao-seed-2.0-code", "Doubao Seed 2.0 Code")],
    piProviderFamily: "openai-compatible", presetVersion, protocol: "openai",
  },
  {
    accessMode: "coding-plan", defaultModelId: "ark-code-latest", endpoint: "https://ark.cn-beijing.volces.com/api/coding", endpointEditable: false,
    kind: "doubao", label: "方舟 Coding Plan", models: [model("ark-code-latest", "Ark Code Latest"), model("doubao-seed-2.0-code", "Doubao Seed 2.0 Code")],
    piProviderFamily: "anthropic-compatible", presetVersion, protocol: "anthropic",
  },
  {
    accessMode: "api", defaultModelId: "MiniMax-M2.7", endpoint: "https://api.minimaxi.com/v1", endpointEditable: false,
    kind: "minimax", label: "MiniMax API", models: [model("MiniMax-M2.7", "MiniMax M2.7"), model("MiniMax-M2.7-highspeed", "MiniMax M2.7 HighSpeed")],
    piProviderFamily: "builtin", presetVersion, protocol: "openai",
  },
  {
    accessMode: "api", defaultModelId: "MiniMax-M2.7", endpoint: "https://api.minimaxi.com/anthropic", endpointEditable: false,
    kind: "minimax", label: "MiniMax API", models: [model("MiniMax-M2.7", "MiniMax M2.7"), model("MiniMax-M2.7-highspeed", "MiniMax M2.7 HighSpeed")],
    piProviderFamily: "anthropic-compatible", presetVersion, protocol: "anthropic",
  },
  {
    accessMode: "coding-plan", defaultModelId: "MiniMax-M2.7", endpoint: "https://api.minimaxi.com/v1", endpointEditable: false,
    kind: "minimax", label: "MiniMax Token Plan", models: [model("MiniMax-M2.7", "MiniMax M2.7"), model("MiniMax-M2.7-highspeed", "MiniMax M2.7 HighSpeed")],
    piProviderFamily: "openai-compatible", presetVersion, protocol: "openai",
  },
  {
    accessMode: "coding-plan", defaultModelId: "MiniMax-M2.7", endpoint: "https://api.minimaxi.com/anthropic", endpointEditable: false,
    kind: "minimax", label: "MiniMax Token Plan", models: [model("MiniMax-M2.7", "MiniMax M2.7"), model("MiniMax-M2.7-highspeed", "MiniMax M2.7 HighSpeed")],
    piProviderFamily: "anthropic-compatible", presetVersion, protocol: "anthropic",
  },
  {
    accessMode: "api", defaultModelId: "deepseek-chat", endpoint: "https://api.deepseek.com", endpointEditable: false,
    kind: "deepseek", label: "DeepSeek API", models: [model("deepseek-chat", "DeepSeek Chat"), model("deepseek-reasoner", "DeepSeek Reasoner")],
    piProviderFamily: "builtin", presetVersion, protocol: "openai",
  },
] as const satisfies readonly DirectModelSourcePreset[];

export const MODEL_SOURCE_OPTIONS = [
  ...MODEL_SOURCE_PRESETS.map(({ accessMode, kind, label, protocol }) => ({ accessMode, kind, label, mode: "direct" as const, protocol })),
  { accessMode: "custom", kind: "generic-openai", label: "通用平台", mode: "openai-compatible" as const, protocol: "openai" },
  { accessMode: "custom", kind: "generic-openai", label: "通用平台", mode: "anthropic-compatible" as const, protocol: "anthropic" },
] as const;

export function defaultModelSourceProtocol(
  kind: DirectModelSourceKind,
  accessMode: Exclude<ModelSourceAccessMode, "custom">,
): ModelSourceProtocol {
  return kind === "kimi" && accessMode === "coding-plan" ? "anthropic" : "openai";
}

export function getDirectModelSourcePreset(
  kind: DirectModelSourceKind,
  accessMode: Exclude<ModelSourceAccessMode, "custom"> = "api",
  protocol: ModelSourceProtocol = defaultModelSourceProtocol(kind, accessMode),
): DirectModelSourcePreset {
  const preset = MODEL_SOURCE_PRESETS.find((candidate) => (
    candidate.kind === kind && candidate.accessMode === accessMode && candidate.protocol === protocol
  ));
  if (preset === undefined) throw new Error("unknown_model_source_preset");
  return preset;
}
