# ADR 0027: Persist effective goal requirements independently of conversational history

Status: Accepted

User requirements can fall outside a bounded request excerpt, a recent decision list or a conversational summary. Independent Work instructions therefore need a separate durable source of current requirements.

Keep a private per-goal trusted input journal and immutable versioned effective requirements. Merge updates incrementally; untouched requirements remain active and replacement requires a new user source. Joi processes new sources in its existing reasoning turn, with sequential paginated reads. All orchestration phases read the same transient protected context. Work briefs pin the contract revision; global mandatory requirements are injected automatically. Both plan commit and run start check freshness, and result synthesis and completion check result and requirements revisions together.

The 24K soft background target and optional 40K/60K expansion include protected requirements. Evidence is reduced first; required content that cannot fit causes an explicit capacity failure. Contract update receipts contain versions, counts and read progress; full contract and background copies are never appended to the transcript. Routine sources freeze the actual prompt per execution key. Old goals initialize at their next natural orchestration turn. A queued latest attempt may refresh its brief while all existing run snapshots remain immutable. Execution-tool-specific semantic constraint checks remain a later extension. Source validation proves provenance and freshness, not perfect model extraction.
