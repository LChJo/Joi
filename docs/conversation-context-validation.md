# Conversation context validation

The acceptance source is [CHAT-18–26](21-normal-conversations.md); the implementation boundary is [ADR 0033](adr/0033-conversation-context-sessions.md).

## Regression evidence

| Scenario | Failing regression | Implemented result |
| --- | --- | --- |
| Same failed candidate requested three times | Three summary calls | One summary call; 30-second expiry permits another, changed candidate permits immediate evaluation |
| Expanding summary with 55,000-character message budget | Summary adopted despite expansion | Rejected; outgoing JSON including the omission notice fits the budget |
| Expanding update after a valid checkpoint | Replacement could advance coverage | Previous checkpoint and original source remain intact |
| In-place source change | Stale cost cache allowed 70,655 serialized characters | Candidate is re-priced and the outgoing view fits 55,000 characters |
| Restart with SDK system projections inside the covered prefix | Same prefix summarized twice | One summary call across restore |
| Oversized protected Chinese tool result | Fixed SDK projection could trigger an unnecessary summary | No second provider request; explicit capacity failure; complete original result retained |
| Codex/Claude mandatory context | Actual SDK input omitted required context | Full context reaches actual SDK options without string slicing |
| Codex/Claude native wire input | Mandatory context had no CLI-to-provider evidence | Both installed native CLIs deliver the complete long Chinese requirement and attachment marker to a loopback provider in one call, with isolated credential fakes |
| Failure/native identity | UI history alone lacked private tool facts | Native identity and complete available tool facts persist for the next explicit message |
| More than 24 turns with stopped output and attachments | Earlier/unsuccessful turns absent from model input | Full available history imports, with explicit legacy gaps; conversations remain isolated |
| Child cancel/restart | Cancel could settle before engine cleanup | Parent waits for cleanup; interrupted children are not replayed |
| Cancel during turn/child admission | Cancellation could miss a newly claimed execution | Execution is registered before claim and checks cancellation before invoking its engine |
| Stop during final private journal save | Stop could release the turn before cleanup and discard late facts | Stop waits for engine/child settlement; final facts persist before another turn can start |
| History reconnect | No pagination/cursor contract | 50-turn pages and conversation-bound payload-free change cursors |

Focused seams: `native-agent-sdk-contract.test.ts`, `conversation-pi-session.test.ts`, `pi-history-budget.test.ts`, `conversation-session.test.ts`, `normal-conversation-execution.test.ts`, `normal-conversation-store.test.ts`, `conversation-subagents.test.ts`, `conversation-context.test.tsx`, plus conversation HTTP/renderer/Electron suites.

All fixtures are synthetic. Character counts measure serialized UTF-16 JSON length, not tokens, billing or response quality. The earlier in-memory prototype's exact payload sizes are not presented as measurements of these production fixtures.

## Quality gates

Validated on Windows on 2026-11-11 with `CI=1`; the full Vitest commands use four workers.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed, no warnings |
| `npm run test -- --reporter=dot --maxWorkers=4` | 354 files / 2,876 tests passed; one optional native suite / nine tests skipped |
| `npm run test:coverage -- --reporter=dot --maxWorkers=4` | 2,876 passed; statements 93.97%, branches 90.16%, functions 92.56%, lines 96.65%; all 90% thresholds passed |
| `npm run test:e2e` | 21 passed |
| `npm run build:prod` | Passed |
| `npm run package:verify` | Passed; 771 files verified |
| `npm run check:boundaries` | Passed |
| `npm run i18n:check` | Passed |

Separately enabled `JOI_NATIVE_WRITE_TESTS=1` and ran the two original-turn native handoff tests against installed Codex and Claude CLIs. Both passed, including complete mandatory-context delivery at the loopback provider. Seven unrelated native workspace/write smoke tests were not selected. These checks use disposable homes and credential fakes; no real provider or remote Git calls were made.

## 2026-11-12 turn activity and coding guidance

CHAT-27–29 add conversation-only context/thinking entries in the existing `entries_json`. The global Work entry kinds and database enums are unchanged. A turn merges observations with streamed/final output, preserves first-observed order and uses separate READ/WRITE phase identities. Final snapshots retry a failed observational write; execution failure retains interrupted phases. Restart, imported-history filtering, answer copy, archive readback and stable disclosures have synthetic regressions.

Actual Pi SDK requests are checked for ALL, CUSTOM, READ, child execution, restoration and a changed model revision/tool selection. Ephemeral/resident/legacy coding paths share the host-owned guidance. These checks verify request delivery and whitelist preservation, not that every model will obey the guidance.

Real SDK-shaped Pi and Claude thinking events expose only lifecycle facts; their raw reasoning/signatures are absent from the public callback. Codex's explicitly public reasoning-summary item is sanitized and limited to 2,048 UTF-16 code units with an omission flag. Missing start events produce no invented duration; native disconnects retain interruption. No extra model request generates a display summary. Official Pi capability findings and the isolated nested-hook experiment are retained in [the research report](pi-coding-harness-research.md); Codemode/MCP and browser integration remain separate candidates.

### Reproducible local tool benchmark

After an Electron build, run `node scripts/benchmark-pi-exploration.mjs`. It creates and removes an isolated synthetic repository containing 960 TSX files and an ignored fixture. Each case checks equal normalized records for the dedicated tool and an equivalent bash command. Path prefixes and SDK presentation padding are normalized; source values, match lines and requested read ranges must agree. Each pair has one excluded warmup and 11 measured runs with alternating order. No timing threshold is part of CI.

Windows / Node 24.12.0 / Pi 1.5.2, measured before the next coverage run:

| Operation | Equal records | Dedicated median | Bash median |
| --- | ---: | ---: | ---: |
| `grep` vs `bash` + `rg -n` | 32 | 143.34 ms | 231.18 ms |
| `find` vs `bash` + `rg --files` | 960 | 101.09 ms | 133.43 ms |
| `read` range vs `bash` + `sed` range | 20 | 1.61 ms | 125.78 ms |

These are local tool `execute()` wall times with warm caches; the benchmark makes **zero model requests**. It does not measure provider wait, model turns, tokens, whole-task speed or answer quality, and does not establish the cause of the screenshot's 53 bash calls.

### Final gates for CHAT-27–29

Validated on Windows on 2026-11-12 with disposable fixtures:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed, no warnings |
| `npm run test -- --reporter=dot --maxWorkers=4` | 354 files / 2,895 tests passed; nine optional native tests skipped |
| `npm run test:coverage -- --reporter=dot --maxWorkers=4` | 2,895 passed; statements 93.97%, branches 90.18%, functions 92.52%, lines 96.65% |
| `npm run test:e2e` | 21 passed |
| `npm run build:prod` | Passed |
| `npm run package:verify` | Passed; 777 files verified |
| `npm run check:boundaries` | Passed |
| `npm run i18n:check` | Passed |

The conversation renderer and Electron cases check placement, tool/metadata colors, keyboard order, disclosure details, copy isolation and mobile overflow, with light/dark screenshots inspected. A settings-layout assertion initially combined rectangles from separate frames and failed by 0.5 px; it now reads them atomically, retaining the original bounds and tolerance, and passed both its isolated run and the complete E2E suite. No production settings-layout change was made. The optional real native CLI suite was not enabled again in this increment; the native thinking regressions use SDK-shaped fake streams, not provider credentials.
