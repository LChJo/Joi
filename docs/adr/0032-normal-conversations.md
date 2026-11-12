# ADR 0032 — Workbench-owned normal conversations

Status: Accepted (approved prototype, 2026-11-11)

## Decision

“对话” is a user-driven execution surface between Joi and Workbenches. It does not ask the autonomous Joi planner to decompose a request. Each submitted message is one durable turn, executed through the existing partner engine, source readiness checks and Skill/tool policy. Joi remains the only autonomous scheduler. Conversation execution is independent of autonomous workbench occupancy; the database permits only one active turn within each conversation.

A conversation acquires its immutable workbench on first submission. An unsubmitted draft may change workbench. Each turn snapshots its partner revision, configured model network and selected Skills; changing a selector affects subsequent turns only. Network models are owned by Settings, with no per-conversation model override. Native partners retain their engine-owned model configuration.

Conversation turns and explicit Git mutations use transactional outbox submission with stable request identities. A delivery that began before process interruption is reported as interrupted/unknown rather than automatically replayed. Conversation tool permissions start READ; a durable engine checkpoint precedes WRITE continuation, without acquiring the autonomous workload's directory lease. This permits simultaneous conversation and Joi access to the bound directory. Explicit Git mutations retain the root-level workspace lease used by autonomous partner writes.

Independent conversation turns are delivered concurrently, including later submissions while earlier deliveries are still running. Outbox claim batches control polling throughput, not the number of active conversations; no workbench, partner or global active-conversation cap is imposed. Each delivery retains its own claim heartbeat and acknowledgement until completion, and close waits for every in-flight batch. Explicit Git operations use a separate serial dispatcher and retain repository leases, so their coordination does not block conversation delivery. Autonomous dispatch limits remain scoped to autonomous work.

Execution context inherits the bound workbench's persona, available memory summaries and applicable validated evolution methods. Raw conversation text is not automatically promoted to memory or learning evidence. Empty workbenches expose empty inheritance rather than fabricated memory.

Conversation output is a local safe projection. Secrets, reasoning and raw tool payloads remain outside it. Conversation-attributed artifacts and repository-wide Git status are separate projections. Files and Git always resolve the server-owned workbench root; the renderer cannot supply a cwd or arbitrary command.

## Consequences

Conversation history is persisted separately from autonomous goals. Internal work identities exist only to reuse workspace safety machinery and are not rendered as task breakdowns. Existing Settings, partner registry, attachment storage and Markdown rendering remain authoritative. Git uses simple-git with the installed Git binary; diff2html supplies structured, escaped diff parsing/rendering. Missing Git or a non-repository workspace is shown as an unavailable state.

## Acceptance

See [normal conversation acceptance](../21-normal-conversations.md). The approved [single-file prototype](../design/joi-chat-prototype.html) is a visual reference, not runtime data.

Durable execution sessions, shared compaction, scoped child delegation and reconnect pagination are specified in [ADR 0033](0033-conversation-context-sessions.md).
