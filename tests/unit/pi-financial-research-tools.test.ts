import { BuiltinPiCodingToolFactory } from "../../src/main/infrastructure/pi/pi-coding-tool-factory.js";
import { PiFinancialResearchToolFactory } from "../../src/main/infrastructure/pi/pi-financial-research-tools.js";

function details(result: unknown): Record<string, unknown> {
  return (result as { details: Record<string, unknown> }).details;
}

describe("Pi deterministic financial research tools", () => {
  it("exposes both tools through the default partner catalog", () => {
    expect(new BuiltinPiCodingToolFactory().names).toEqual(expect.arrayContaining([
      "financial_calculate", "research_audit",
    ]));
  });

  it("verifies market capitalization and valuation ratios with decimal arithmetic", async () => {
    const [tool] = new PiFinancialResearchToolFactory().create(["financial_calculate"]);
    if (tool === undefined) throw new Error("financial tool missing");

    const cap = await tool.execute("cap", {
      inputs: { price: "123.45", reported: "123450000", shares: "1000000" },
      operation: "verify_market_cap",
    });
    expect(details(cap)).toMatchObject({ calculated: "123450000", differencePercent: "0", verified: true });

    const ratios = await tool.execute("ratios", {
      inputs: { earnings: "25000000", enterpriseValue: "500000000", revenue: "100000000" },
      operation: "valuation_ratios",
    });
    expect(details(ratios)).toMatchObject({ earningsYieldPercent: "5", evToRevenue: "5" });
  });

  it("runs scenarios, terminal-value IRR and Benford checks without arbitrary evaluation", async () => {
    const [tool] = new PiFinancialResearchToolFactory().create(["financial_calculate"]);
    if (tool === undefined) throw new Error("financial tool missing");

    const scenarios = await tool.execute("scenarios", {
      inputs: { base: "100", bearMultiplier: "0.7", baseMultiplier: "1", bullMultiplier: "1.4" },
      operation: "three_scenario",
    });
    expect(details(scenarios)).toMatchObject({ bear: "70", base: "100", bull: "140" });

    const irr = await tool.execute("irr", {
      inputs: { entryValue: "100", exitValue: "161.051", years: "5" },
      operation: "terminal_value_irr",
    });
    expect(Number(details(irr).irrPercent)).toBeCloseTo(10, 6);

    const benford = await tool.execute("benford", {
      inputs: { values: "12,15,21,27,31,44,58,63,79,88,91" },
      operation: "benford",
    });
    expect(details(benford)).toMatchObject({ sampleSize: 11 });

    const rejected = await tool.execute("eval", { inputs: { expression: "process.exit()" }, operation: "eval" });
    expect(rejected).toMatchObject({ isError: true });
  });

  it("audits bounded research claims without echoing the source document", async () => {
    const [tool] = new PiFinancialResearchToolFactory().create(["research_audit"]);
    if (tool === undefined) throw new Error("audit tool missing");
    const marker = "PRIVATE_RESEARCH_BODY_MARKER";
    const result = await tool.execute("audit", {
      claims: [
        { claim: "Revenue increased", source: "annual report p.10", verified: true },
        { claim: "Margin doubled", discrepancy: "reported margin was flat", source: "filing p.20", verified: false },
        { claim: "Market share is 40%", verified: false },
      ],
      markdown: `# Draft\n${marker}`,
    });
    expect(details(result)).toMatchObject({ discrepancies: 1, missingSources: 1, totalClaims: 3, verdict: "ACTION_REQUIRED", verifiedClaims: 1 });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
