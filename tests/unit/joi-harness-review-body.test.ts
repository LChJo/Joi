import { composeReviewBody } from "../../src/main/application/joi/joi-harness-review-body.js";

describe("composeReviewBody", () => {
  it("starts at the roadmap and restricts each review to one decision", () => {
    const body = composeReviewBody({ goalInputId: "goal-1",resultRevision: 2 });
    expect(body).toContain("goalInputId=goal-1 resultRevision=2");
    expect(body).toContain("work_read_evidence(mode=roadmap)");
    expect(body).toContain("work_read_result");
    expect(body).toContain("Resolve at most ONE decision");
    expect(body).toContain("MAP_CLEARED only after");
  });

  it("does not close the map while the synthesis requests another layer", () => {
    const body = composeReviewBody({ goalInputId: "goal-1",resultRevision: 2,continuationRequested: true });
    expect(body).toContain("Do not call MAP_CLEARED");
  });
});
