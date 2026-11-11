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
