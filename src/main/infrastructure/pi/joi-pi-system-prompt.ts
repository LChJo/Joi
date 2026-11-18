import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { piCodingGuidance } from "./pi-coding-guidance.js";

export interface JoiPiPromptOptions {
  promptRules?: readonly string[];
  backgroundContext?: string;
  skillContext?: string;
  now?: () => Date;
  timeZone?: string;
}

/** Prompt configuration uses the SDK's structured sections and leaves execution decisions to Pi. */
export function joiPiSystemPrompt(tools: readonly AgentTool[], options: JoiPiPromptOptions): ExtensionFactory {
  return pi => {
    pi.on("before_agent_start", event => {
      const prompt = event.systemPromptOptions;
      const hidden = new Set(prompt.hiddenTools);
      const registered = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
      const names = prompt.selectedTools.filter(name => !hidden.has(name) && registered.has(name));
      const labels = new Map(tools.map(tool => [tool.name, tool.label]));
      prompt.sections.tools = names.map(name => `- ${name}: ${prompt.toolSnippets[name] ?? labels.get(name) ?? registered.get(name)?.description.split("\n")[0] ?? name}`).join("\n") || "(none)";
      const rules = [
        ...names.flatMap(name => prompt.toolGuidelines[name] ?? []),
        ...piCodingGuidance(names, prompt.toolGuidelines), ...prompt.promptGuidelines, ...(options.promptRules ?? []),
        "Before substantial tool use, briefly explain your approach. During longer work, share material findings, changes of approach and blockers in concise public updates.",
        "Use the user's language. Keep updates concise and deliver a complete final answer supported by observed results; distinguish uncertainty and do not expose raw thinking.",
        "Show file paths clearly when working with files.",
      ].map(rule => rule.trim()).filter(Boolean);
      prompt.sections.rules = [...new Set(rules)].map(rule => `- ${rule}`).join("\n");
      if (options.backgroundContext?.trim()) prompt.sections.workbench_context = options.backgroundContext;
      if (options.skillContext?.trim()) prompt.sections.skills = options.skillContext;
      const now = (options.now ?? (() => new Date()))();
      const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      prompt.sections.system_date = `Current date: ${date}\nTime zone: ${timeZone}`;
    });
  };
}
