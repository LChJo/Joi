import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Decimal } from "decimal.js";

export const PI_FINANCIAL_RESEARCH_TOOL_NAMES = ["financial_calculate", "research_audit"] as const;

const decimalInput = Type.String({ maxLength: 10_000, minLength: 1 });
const financialParameters = Type.Object({
  inputs: Type.Object({
    base: Type.Optional(decimalInput),
    baseMultiplier: Type.Optional(decimalInput),
    bearMultiplier: Type.Optional(decimalInput),
    bullMultiplier: Type.Optional(decimalInput),
    earnings: Type.Optional(decimalInput),
    entryValue: Type.Optional(decimalInput),
    enterpriseValue: Type.Optional(decimalInput),
    exitValue: Type.Optional(decimalInput),
    expression: Type.Optional(decimalInput),
    primary: Type.Optional(decimalInput),
    price: Type.Optional(decimalInput),
    reported: Type.Optional(decimalInput),
    revenue: Type.Optional(decimalInput),
    secondary: Type.Optional(decimalInput),
    shares: Type.Optional(decimalInput),
    tolerancePercent: Type.Optional(decimalInput),
    values: Type.Optional(decimalInput),
    years: Type.Optional(decimalInput),
  }),
  operation: Type.Union([
    Type.Literal("verify_market_cap"),
    Type.Literal("valuation_ratios"),
    Type.Literal("cross_validate"),
    Type.Literal("three_scenario"),
    Type.Literal("terminal_value_irr"),
    Type.Literal("benford"),
  ]),
});

const auditParameters = Type.Object({
  claims: Type.Array(Type.Object({
    claim: Type.String({ maxLength: 2_000, minLength: 1 }),
    discrepancy: Type.Optional(Type.String({ maxLength: 2_000, minLength: 1 })),
    source: Type.Optional(Type.String({ maxLength: 2_000, minLength: 1 })),
    verified: Type.Boolean(),
  }), { maxItems: 200 }),
  markdown: Type.String({ maxLength: 120_000 }),
});

function textResult(message: string, details: Record<string, unknown>): { content: [{ text: string; type: "text" }]; details: Record<string, unknown> } {
  return { content: [{ text: message, type: "text" }], details };
}

function errorResult(code: string, message: string): ReturnType<typeof textResult> & { isError: true } {
  return { ...textResult(message, { code }), isError: true };
}

function required(inputs: Record<string, string | undefined>, key: string): Decimal {
  const value = inputs[key];
  if (value === undefined || value.trim() === "") throw new Error("financial_input_missing");
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error("financial_input_invalid");
  return parsed;
}

function display(value: Decimal, precision = 12): string {
  if (!value.isFinite()) throw new Error("financial_result_invalid");
  return value.toDecimalPlaces(precision, Decimal.ROUND_HALF_UP).toString();
}

function calculate(operation: string, inputs: Record<string, string | undefined>): Record<string, unknown> {
  switch (operation) {
    case "verify_market_cap": { // market cap = price × diluted shares
      const calculated = required(inputs, "price").mul(required(inputs, "shares"));
      const reported = required(inputs, "reported");
      const differencePercent = reported.isZero() ? calculated.isZero() ? new Decimal(0) : new Decimal(Infinity) : calculated.minus(reported).abs().div(reported.abs()).mul(100);
      return { calculated: display(calculated), differencePercent: display(differencePercent), verified: differencePercent.lte(new Decimal("0.1")) };
    }
    case "valuation_ratios": {
      const enterpriseValue = required(inputs, "enterpriseValue");
      const revenue = required(inputs, "revenue");
      const earnings = required(inputs, "earnings");
      if (revenue.isZero() || enterpriseValue.isZero()) throw new Error("financial_division_by_zero");
      return {
        earningsYieldPercent: display(earnings.div(enterpriseValue).mul(100)),
        evToRevenue: display(enterpriseValue.div(revenue)),
      };
    }
    case "cross_validate": {
      const primary = required(inputs, "primary");
      const secondary = required(inputs, "secondary");
      const tolerance = inputs.tolerancePercent === undefined ? new Decimal("0.1") : required(inputs, "tolerancePercent");
      const differencePercent = secondary.isZero() ? primary.isZero() ? new Decimal(0) : new Decimal(Infinity) : primary.minus(secondary).abs().div(secondary.abs()).mul(100);
      return { difference: display(primary.minus(secondary)), differencePercent: display(differencePercent), verified: differencePercent.lte(tolerance) };
    }
    case "three_scenario": {
      const base = required(inputs, "base");
      return {
        base: display(base.mul(required(inputs, "baseMultiplier"))),
        bear: display(base.mul(required(inputs, "bearMultiplier"))),
        bull: display(base.mul(required(inputs, "bullMultiplier"))),
      };
    }
    case "terminal_value_irr": {
      const entryValue = required(inputs, "entryValue");
      const exitValue = required(inputs, "exitValue");
      const years = required(inputs, "years");
      if (entryValue.lte(0) || exitValue.lte(0) || years.lte(0)) throw new Error("financial_input_out_of_range");
      const irrPercent = exitValue.div(entryValue).pow(new Decimal(1).div(years)).minus(1).mul(100);
      return { irrPercent: display(irrPercent), multiple: display(exitValue.div(entryValue)), years: display(years) };
    }
    case "benford": {
      const raw = inputs.values;
      if (raw === undefined) throw new Error("financial_input_missing");
      const digits = raw.split(/[\s,;]+/u).filter(Boolean).map((value) => {
        const normalized = new Decimal(value).abs().toFixed().replace(/^0[.]?0*/u, "");
        return Number(normalized[0]);
      }).filter((digit) => digit >= 1 && digit <= 9);
      if (digits.length === 0) throw new Error("financial_sample_empty");
      const distribution = Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
        const digit = index + 1;
        const observedPercent = new Decimal(digits.filter((value) => value === digit).length).div(digits.length).mul(100);
        const expectedPercent = new Decimal(Math.log10(1 + (1 / digit))).mul(100);
        return [digit.toString(), { expectedPercent: display(expectedPercent, 6), observedPercent: display(observedPercent, 6) }];
      }));
      return { distribution, sampleSize: digits.length, warning: digits.length < 100 ? "SMALL_SAMPLE" : "NONE" };
    }
    default:
      throw new Error("financial_operation_not_allowed");
  }
}

export class PiFinancialResearchToolFactory {
  readonly names: readonly string[] = PI_FINANCIAL_RESEARCH_TOOL_NAMES;

  create(names: readonly string[]): AgentTool[] {
    return [...new Set(names)].map((name) => {
      if (name === "financial_calculate") return this.#financialTool();
      if (name === "research_audit") return this.#auditTool();
      throw new Error("partner_tool_not_allowed");
    });
  }

  #financialTool(): AgentTool<typeof financialParameters> {
    return {
      description: "Run one approved deterministic finance operation with decimal inputs. Never evaluates code or arbitrary expressions.",
      execute: (_toolCallId, parameters) => Promise.resolve().then(() => {
        try {
          const output = calculate(parameters.operation, parameters.inputs);
          return textResult("Financial calculation completed. Use the structured details as the verified result.", output);
        } catch (error) {
          const code = error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : "financial_calculation_failed";
          return errorResult(code, "The financial calculation could not be completed. Check the operation and numeric inputs.");
        }
      }),
      label: "Financial calculate",
      name: "financial_calculate",
      parameters: financialParameters,
    };
  }

  #auditTool(): AgentTool<typeof auditParameters> {
    return {
      description: "Audit bounded research claim metadata and return aggregate gaps without echoing the source document.",
      execute: (_toolCallId, parameters) => Promise.resolve().then(() => {
        const missingSources = parameters.claims.filter((claim) => claim.source === undefined || claim.source.trim() === "").length;
        const discrepancies = parameters.claims.filter((claim) => claim.discrepancy !== undefined).length;
        const verifiedClaims = parameters.claims.filter((claim) => claim.verified).length;
        const totalClaims = parameters.claims.length;
        const verdict = totalClaims > 0 && missingSources === 0 && discrepancies === 0 && verifiedClaims === totalClaims ? "PASS" : "ACTION_REQUIRED";
        return textResult("Research audit completed. Review the structured counts and verdict.", {
          discrepancies, documentCharacters: parameters.markdown.length, missingSources, totalClaims, verifiedClaims, verdict,
        });
      }),
      label: "Research audit",
      name: "research_audit",
      parameters: auditParameters,
    };
  }
}
