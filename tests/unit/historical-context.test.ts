import { describe, expect, it } from "vitest";
import { renderHistoricalContext, type HistoricalEntry } from "../../src/main/domain/work/historical-context.js";

describe("HIST-01/07 historical context", () => {
  it("counts Unicode characters without dropping complete entries at the compaction threshold", () => {
    const candidates: HistoricalEntry[] = Array.from({ length: 40 }, (_, i) => ({
      section: "verified_methods", text: `${String(i)} ${"𠮷".repeat(110)}`,
    }));
    const partner = renderHistoricalContext("partner", candidates);
    expect(partner.text).toContain("## Effective methods\n");
    expect(partner.entries).toHaveLength(40);
    expect(Array.from(partner.text).length).toBeGreaterThan(1000);
    expect(partner.entries.every(entry => entry.text.endsWith("𠮷".repeat(110)))).toBe(true);
    expect(renderHistoricalContext("joi", candidates).text).toBe("");
  });

  it("keeps a concise source index only in the associated workbench projection", () => {
    const entries: HistoricalEntry[] = [{ section: "sources", text: "Goal outcome, revision 2", source: "ref:2" },
      { section: "preferences", text: "Use concise status updates" }];
    expect(renderHistoricalContext("workbench", entries).text).toContain("Goal outcome, revision 2 [ref:2]");
    expect(renderHistoricalContext("joi", entries).text).toBe("## Long-term preferences\n- Use concise status updates");
    expect(renderHistoricalContext("partner", entries).text).toBe("");
  });
});
