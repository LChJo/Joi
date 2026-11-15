import { describe, expect, it } from "vitest";
import { deriveMethodExperience } from "../../src/main/domain/evolution/method-experience";
import { baselineMethodPolicy } from "../../src/main/domain/evolution/learning-policy";

describe("method comparison experience", () => {
  const comparison={scenarioId:"development",baseline:[false,false,true],candidate:[true,true,true],baselineCalls:12,candidateCalls:12,violations:0};
  const input={parent:baselineMethodPolicy,candidate:{version:2 as const,context:[],planning:[],completion:["acceptance_matrix" as const]},
    comparisons:[comparison]};
  it("records measured development improvements and counterexamples without copying traces", () => {
    expect(deriveMethodExperience(input)).toMatchObject({baselineSuccesses:1,candidateSuccesses:3,baselineCalls:12,candidateCalls:12,runs:3});
    expect(deriveMethodExperience({...input,comparisons:[{...comparison,candidate:[false,false,false]}]})).toMatchObject({candidateSuccesses:0});
    expect(deriveMethodExperience({...input,comparisons:[{...comparison,candidate:[false,false,true]}]})).toBeNull();
  });
});
