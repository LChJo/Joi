# ADR 0017: Goal Result Continuation

Status: accepted

A result synthesis that lacks enough evidence is not always blocked. Joi records `RESULT_CONTINUE`/`CONTINUE` only when the missing evidence has a concrete, safe next layer that needs no user judgment, credential, or broader permission. Authentication, authorization, safety, scope, and subjective-choice gaps remain `RESULT_BLOCKED`/`BLOCKED`.

Each active Wayfinder map persists a continuation allowance, defaulting to two reviews. A current `CONTINUE` outcome below that allowance is reviewed automatically and can create the next bounded Work layer. Creating that review input consumes one unit in the same transaction. Recovery can retry the review's existing identity. Migration 113 initializes usage from the prior layer-based calculation so existing goals retain their balance. Explicit follow-up planning uses the existing execution gate and leaves the allowance available for automatic reviews.

When a scheduled occurrence reopens a settled map, it tops up the remaining allowance to two reviews in the claim transaction. A goal admits at most 24 scheduled top-up credits per 24-hour window. Explicit user grants have their own two-review limit. Migration 119 preserves prior usage, allowance and results.

Joi requests one revision-bound `GOAL_CONTINUATION` action when the allowance is exhausted or a completed supplement repeats the same structured gaps without newly verified evidence in their scope. The comparison stays within the current execution and requirement version. The goal waits in `NEEDS_ATTENTION` with the reason and saved result. Synthesis evaluates recurring checks against the scope of the current execution and carries older gaps as context unless they block a current requirement.

“继续完善” consumes the action, grants up to two reviews and resumes normal review traversal. “补充要求并继续” also persists the instructions as a user requirement source and queues a versioned planning turn through the existing execution gate. Both preserve prior evidence. “保留当前结果” changes the outcome to `ACCEPTED_WITH_GAPS`, clears the map and journals `COMPLETED_WITH_GAPS`.

Intermediate `CONTINUE` outcomes do not enter Workbench recent outcomes. Goal-level actions contain no Work or run reference, while partner questions and recovery decisions retain both references. Migration 051 rebuilds the constrained tables to enforce this distinction and preserves all earlier rows.
