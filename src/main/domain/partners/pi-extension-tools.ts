export const PI_OPENWIKI_READ_TOOLS = ["openwiki_list_workspaces","openwiki_list_wikis","openwiki_search","openwiki_read"] as const;
export const PI_OPENWIKI_WRITE_TOOLS = ["openwiki_begin","openwiki_submit_plan","openwiki_next_page","openwiki_inspect_page_claims","openwiki_submit_page","openwiki_finish"] as const;
/** Even observational browser tools can provision a billable cloud session. */
export const PI_BROWSER_LOOP_TOOLS = ["browser_snapshot","browser_text","browser_find","browser_click","browser_hover","browser_drag","browser_fill","browser_scroll_to","browser_scroll","browser_type","browser_key","browser_navigate","browser_list_tabs","browser_new_tab","browser_screenshot","browser_evaluate","browser_wait_for"] as const;
export const PI_EXTENSION_TOOL_NAMES: readonly string[] = [...PI_OPENWIKI_READ_TOOLS,...PI_OPENWIKI_WRITE_TOOLS,...PI_BROWSER_LOOP_TOOLS];
