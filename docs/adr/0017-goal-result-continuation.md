# ADR 0017: Goal Result Continuation

Status: accepted

A result synthesis that lacks enough evidence is not always blocked. Joi records `RESULT_CONTINUE`/`CONTINUE` only when the missing evidence has a concrete, safe next layer that needs no user judgment, credential, or broader permission. Authentication, authorization, safety, scope, and subjective-choice gaps remain `RESULT_BLOCKED`/`BLOCKED`.

Each active Wayfinder map persists a continuation allowance, defaulting to two layers. A current `CONTINUE` outcome below that allowance is reviewed automatically and can create the next bounded Work layer. The allowance is durable across restarts and is measured from persisted path layers, so actor retries cannot reset or double-spend it.

When the allowance is exhausted, Joi creates one revision-bound `GOAL_CONTINUATION` action and projects the original goal as `NEEDS_ATTENTION`. “继续补齐” atomically consumes the action, grants two more layers, clears the clarification, and leaves the current map active for the normal review traversal. “接受现状” atomically changes the current outcome to `ACCEPTED_WITH_GAPS`, clears the map, consumes the action, and projects `COMPLETED_WITH_GAPS`; it must never be presented or remembered as full attainment.

Intermediate `CONTINUE` outcomes do not enter Workbench recent outcomes. Goal-level actions contain no Work or run reference, while partner questions and recovery decisions retain both references. Migration 051 rebuilds the constrained tables to enforce this distinction and preserves all earlier rows.
