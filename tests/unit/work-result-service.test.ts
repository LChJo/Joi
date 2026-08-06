/* In-memory async ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { WorkResultService } from "../../src/main/application/work/work-result-service.js";
import type { WorkResultRepository } from "../../src/main/application/ports/work-results.js";

describe("WorkResultService", () => {
  it("returns bounded chunks only inside the current Workbench scope", async () => {
    const full = "a".repeat(4_000) + "tail";
    const repository: WorkResultRepository = {
      readBody: async (input) => input.workbenchId === "workbench-a" && input.resultId === "result-a"
        ? { body: full.slice(input.offset, input.offset + input.limit), total: full.length }
        : null,
      record: async () => { throw new Error("not used"); },
    };
    const service = new WorkResultService(repository);
    await expect(service.read({ workbenchId: "workbench-a", resultId: "result-a" })).resolves.toEqual({
      content: "a".repeat(4_000), nextCursor: "4000", resultId: "result-a",
    });
    await expect(service.read({ workbenchId: "workbench-a", cursor: "4000", resultId: "result-a" })).resolves.toEqual({
      content: "tail", resultId: "result-a",
    });
    await expect(service.read({ workbenchId: "workbench-b", resultId: "result-a" }))
      .rejects.toMatchObject({ code: "work_result_not_found" });
  });

  it("rejects non-canonical cursors instead of partially parsing them", async () => {
    const service = new WorkResultService({
      readBody: async () => ({ body: "", total: 0 }),
      record: async () => { throw new Error("not used"); },
    });
    await expect(service.read({ workbenchId: "workbench-a", cursor: "1junk", resultId: "result-a" }))
      .rejects.toMatchObject({ code: "work_result_cursor_invalid" });
    await expect(service.read({ workbenchId: "workbench-a", cursor: "999999999999999999999", resultId: "result-a" }))
      .rejects.toMatchObject({ code: "work_result_cursor_invalid" });
  });
});
