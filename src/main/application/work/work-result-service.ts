import type { GoalEvidenceChangesQuery,GoalEvidenceRepository,GoalEvidenceScope } from "../ports/goal-evidence.js";
import { DomainError } from "../../domain/errors.js";
import type { WorkResultRepository, WorkVerificationProjection } from "../ports/work-results.js";

const CHUNK_SIZE = 8_000;

export class WorkResultService {
  constructor(private readonly repository: WorkResultRepository, private readonly evidence?: GoalEvidenceRepository) {}

  async index(input: GoalEvidenceScope & { cursor?: string }) {
    if (this.evidence === undefined) throw new DomainError("work_evidence_unavailable", "Evidence indexing is unavailable.");
    return this.evidence.index(input);
  }

  async readConclusion(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }) {
    if (this.evidence === undefined) throw new DomainError("work_evidence_unavailable", "Evidence indexing is unavailable.");
    return this.evidence.readConclusion(input);
  }

  async readChanges(input: GoalEvidenceChangesQuery) {
    if (this.evidence?.readChanges === undefined) throw new DomainError("work_evidence_unavailable", "Semantic evidence changes are unavailable.");
    return this.evidence.readChanges(input);
  }

  async readHandoff(input: GoalEvidenceScope & { resultId: string; cursor?: string }) {
    if (this.evidence?.readHandoff === undefined) throw new DomainError("work_evidence_unavailable", "Semantic result handoff is unavailable.");
    return this.evidence.readHandoff(input);
  }

  async readState(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }) {
    if (this.evidence?.readState === undefined) throw new DomainError("work_evidence_unavailable", "Private synthesis state is unavailable.");
    return this.evidence.readState(input);
  }

  async read(input: { goalInputId?: string; workbenchId: string; cursor?: string; resultId: string }): Promise<{
    content: string;
    identity?: { status: string; isLate: boolean; isAuthoritative: boolean };
    nextCursor?: string;
    resultId: string;
    verification?: WorkVerificationProjection;
  }> {
    if (input.cursor !== undefined && !/^(?:0|[1-9]\d*)$/u.test(input.cursor)) {
      throw new DomainError("work_result_cursor_invalid", "Work result cursor is invalid.");
    }
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DomainError("work_result_cursor_invalid", "Work result cursor is invalid.");
    if (input.goalInputId !== undefined && this.evidence !== undefined) await this.evidence.assertReferences({ goalInputId: input.goalInputId, workbenchId: input.workbenchId, resultIds: [input.resultId] });
    const row = await this.repository.readBody({ workbenchId: input.workbenchId, limit: CHUNK_SIZE, offset, resultId: input.resultId });
    if (row === null) throw new DomainError("work_result_not_found", "Work result was not found in this Workbench.");
    // The first chunk carries the acceptance verdict so readers can weigh the body; later
    // chunks stay pure content.
    const verification = offset === 0 ? await this.repository.readVerification(input.resultId) : null;
    const identity = offset !== 0 || input.goalInputId === undefined ? null : await this.evidence?.readIdentity?.({ goalInputId: input.goalInputId,workbenchId: input.workbenchId,resultId: input.resultId });
    // SQLite cursors and totals count codepoints, including supplementary characters once.
    const next = offset + Array.from(row.body).length;
    return {
      content: row.body,
      ...(identity == null ? {} : { identity }),
      ...(next < row.total ? { nextCursor: String(next) } : {}),
      resultId: input.resultId,
      ...(verification === null ? {} : { verification }),
    };
  }
}
