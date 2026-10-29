/** Review identity includes the explicit review recovery epoch, independently of the evidence revision. */
export function harnessReviewInputId(goalInputId: string, resultRevision: number, requirementsRevision?: number, recoveryEpoch?: string): string {
  return `joi_harness_review:goal:${goalInputId}:r${String(resultRevision)}${requirementsRevision === undefined ? "" : `:q${String(requirementsRevision)}`}${recoveryEpoch === undefined ? "" : `:resume:${recoveryEpoch}`}`;
}

/** Expressions are repository-owned SQL identifiers, never request parameters. */
export function harnessReviewInputIdSql(goalExpression: string, resultRevisionExpression: string): string {
  return `'joi_harness_review:goal:' || ${goalExpression} || ':r' || ${resultRevisionExpression}
    || COALESCE((SELECT ':q' || revision FROM joi_goal_requirements WHERE goal_input_id = ${goalExpression}), '')
    || COALESCE((SELECT ':resume:' || review_recovery_epoch FROM joi_harness_maps WHERE goal_input_id = ${goalExpression}), '')`;
}
