# joi repository guide

Agent-facing run, validation, clean and package commands are indexed in `.agent/commands/README.md`. `.agent/commands.md` remains a compatibility summary.

## Source of truth

- Product scope: `README.md` and `docs/00-sources-and-glossary.md` through `docs/08-reference-backend-assessment.md`.
- Milestones and completion gates: `docs/07-roadmap-and-acceptance.md`.
- Architecture decisions: `docs/adr/`.

## Required boundaries

- `src/main/domain` is pure TypeScript and imports no Electron, Node runtime APIs, SQLite, HTTP, file system, or A2A SDK.
- `src/main/application` orchestrates ports and domain behavior; it does not implement transport, SQL, Electron lifecycle, or credential storage.
- `src/main/infrastructure` implements ports; it does not redefine event priority, Life state, or action policy.
- `src/main/interfaces` maps HTTP/SSE to application services and shared DTOs.
- `src/renderer` uses only shared DTOs and `/api/v1`; it never imports Electron, Node, SQLite, or A2A SDK.
- `src/preload` exposes only the narrow desktop bridge. Business APIs stay on HTTP.
- Every new production directory must be classified by `scripts/architecture-boundaries.mjs`.

## Development discipline

1. Map every behavior change to a documented acceptance criterion.
2. For behavior changes, add and run a failing test before implementation.
3. Keep external side effects behind an outbox and stable idempotency identifiers.
4. Use disposable SQLite, userData and credential fakes in tests. Never read real Electron userData.
5. Never log or return tokens, cookies, CSRF values, message bodies, persona, memory text or A2A payloads. A local, user-facing projection may print an absolute path abbreviated to its root plus its last three segments (`src/main/domain/text/path-abbreviation.ts`); the diagnostics channel still rejects paths outright, and the private tool-trace store still keeps them in full.
6. Select tests and checks from the actual change scope using `.agent/commands/verify.md`; complete that scope before handing off.
7. Keep code comments clean and clear: a comment states the invariant, constraint, or rationale of the code as it stands now. Never narrate the work history of a change — what used to be broken, how a previous version behaved, before/after comparisons, or references to the fix or session that produced the code. That history belongs in commit messages, not in the source.

## Change-scoped validation

- Before running checks, map the diff and affected callers/contracts to a bounded validation scope. State the selected tests and checks briefly.
- Start with the regression test and directly affected test files. For TypeScript changes, run typecheck and lint the changed code; expand to related integration or contract tests when behavior crosses those boundaries.
- Documentation-only changes need diff, link and command review. Match configuration and script changes to the tools they affect.
- Electron E2E, native/desktop smoke tests, coverage, production builds and package verification require a relevant change or explicit full/release validation request. A routine task handoff or milestone label alone does not trigger them.
- Reuse passing results for the same code state. Once the selected checks pass, stop; expand or repeat only for new changes, failures or a concrete unresolved risk.
- Report what ran, its result, and any relevant checks left unverified. Keep CI and release validation requirements separate from local iteration.
