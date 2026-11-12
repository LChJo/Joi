export function isBrowserTool(name: string): boolean {
  return name.startsWith("browser_");
}

/** Browser automation requires an explicit tool selection, including under ALL. */
export function isPartnerToolEnabled(name: string, mode: "ALL" | "CUSTOM", selected: readonly string[]): boolean {
  return selected.includes(name) || (mode === "ALL" && !isBrowserTool(name));
}
