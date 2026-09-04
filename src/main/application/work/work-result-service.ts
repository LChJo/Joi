import { DomainError } from "../../domain/errors.js";
import type { WorkResultRepository, WorkVerificationProjection } from "../ports/work-results.js";

const CHUNK_SIZE = 4_000;

export class WorkResultService {
  constructor(private readonly repository: WorkResultRepository) {}

  async read(input: { workbenchId: string; cursor?: string; resultId: string }): Promise<{
    content: string;
    nextCursor?: string;
    resultId: string;
    verification?: WorkVerificationProjection;
  }> {
    if (input.cursor !== undefined && !/^(?:0|[1-9]\d*)$/u.test(input.cursor)) {
      throw new DomainError("work_result_cursor_invalid", "Work result cursor is invalid.");
    }
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DomainError("work_result_cursor_invalid", "Work result cursor is invalid.");
    const row = await this.repository.readBody({ workbenchId: input.workbenchId, limit: CHUNK_SIZE, offset, resultId: input.resultId });
    if (row === null) throw new DomainError("work_result_not_found", "Work result was not found in this Workbench.");
    // The first chunk carries the acceptance verdict so readers can weigh the body; later
    // chunks stay pure content.
    const verification = offset === 0 ? await this.repository.readVerification(input.resultId) : null;
    const next = offset + row.body.length;
    return {
      content: row.body,
      ...(next < row.total ? { nextCursor: String(next) } : {}),
      resultId: input.resultId,
      ...(verification === null ? {} : { verification }),
    };
  }
}
