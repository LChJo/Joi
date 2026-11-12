/** Observational browser tools can launch a local process and execute remote page scripts. */
export const PI_AGENT_BROWSER_TOOLS = ["browser_snapshot","browser_text","browser_click","browser_hover","browser_drag","browser_fill","browser_scroll_to","browser_scroll","browser_type","browser_key","browser_navigate","browser_list_tabs","browser_new_tab","browser_screenshot","browser_evaluate","browser_wait_for","browser_console","browser_errors","browser_network","browser_react","browser_vitals"] as const;
export const PI_EXTENSION_TOOL_NAMES: readonly string[] = PI_AGENT_BROWSER_TOOLS;
