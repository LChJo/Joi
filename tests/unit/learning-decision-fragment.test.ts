import { replayDecisionReads, type DecisionEvidenceRead } from "../../src/main/domain/evolution/learning-decision-fragment";

const read: DecisionEvidenceRead = { receiptId:"r1",resultId:"result",sourceRef:"body",start:0,end:2,
  digest:"fixture-digest", verification:"PASSED", residentReceipts:[], authority:"access-1" };

describe("RSI-02 decision fragment evidence", () => {
  it("preserves Unicode pages and verified receipt order while reusing only exact resident reads", () => {
    const events: DecisionEvidenceRead[] = [
      read, {...read,receiptId:"r2",residentReceipts:["r1"]},
      {...read,receiptId:"r3",residentReceipts:["r2"],start:2,end:4},
      {...read,receiptId:"r4",residentReceipts:[]},
      {...read,receiptId:"r5",residentReceipts:["r4"],authority:"access-2"},
      {...read,receiptId:"r6",residentReceipts:["r5"],verification:"FAILED"},
    ];
    const load = (event: DecisionEvidenceRead) => event.start === 0 ? "中🧭" : "好🌱";
    const baseline = replayDecisionReads(events, load, false);
    const candidate = replayDecisionReads(events, load, true);
    expect(baseline.reads).toBe(6);
    expect(candidate.reads).toBe(5);
    expect(candidate.observations).toEqual(baseline.observations);
    expect(replayDecisionReads([{...read,receiptId:"r2",residentReceipts:["r1"]}],load,true).reads).toBe(1);
  });
  it("labels unknown historic residency and limits the claimed equivalence to fixed-trace replay", () => {
    const historic = [{...read,residentReceipts:null,authority:null}, {...read,receiptId:"r2",residentReceipts:null,authority:null}];
    const compare = replayDecisionReads(historic, () => "中🧭", true);
    expect(compare).toMatchObject({reads:1,confirmedResidency:false});
  });
});
