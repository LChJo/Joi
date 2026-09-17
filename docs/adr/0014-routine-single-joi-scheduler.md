# ADR 0014: Routine Uses the Single Joi Scheduler

Status: accepted

Routine is a global recurring-task entity owned by the existing Joi actor root. A due occurrence is claimed transactionally and represented by one ordinary `PENDING` `joi_inbox_messages` row using `automation:<routineId>:<occurrenceKey>` as its idempotency key. `JoiTaskComponent` remains the only model execution slot; Routine never starts a timer, thread, process, second scheduler, or direct provider call.

The adapter records compact run facts and merges overdue occurrences into an existing pending/running run. A Routine target is either `NEW_GOAL` or `GOAL_CONTINUATION`. The latter retains a stable goal id, derives its Workbench from that goal, and requeues the same inbox row only after the goal completes or fails. Active occurrences coalesce behind one blocked fact; canceled goals remain stopped. Dismissing the goal soft-deletes linked continuation Routines in the same local transaction. This preserves one card, one goal context, and one execution slot without introducing a conversation-specific scheduler.

Prompt text is resolved only at execution time and is never part of routine list, run, diagnostic, or normal result projections. The continuation prompt is a fixed supplemental instruction for each new round, not an append-only mutation of the original user-visible goal text. Legacy Life schedules and alarms remain compatibility APIs.
