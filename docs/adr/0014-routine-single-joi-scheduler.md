# ADR 0014: Routine Uses the Single Joi Scheduler

Status: accepted

Routine is a global recurring-task entity owned by the existing Joi actor root. A due occurrence is claimed transactionally and represented by one ordinary `PENDING` `joi_inbox_messages` row using `automation:<routineId>:<occurrenceKey>` as its idempotency key. `JoiTaskComponent` remains the only model execution slot; Routine never starts a timer, thread, process, second scheduler, or direct provider call.

The adapter records compact run facts and merges overdue occurrences into an existing pending/running run. Prompt text is resolved only at execution time and is never part of routine list, run, diagnostic, or normal result projections. Legacy Life schedules and alarms remain compatibility APIs.
