# joi repository guide

Agent-facing run, validation, clean and package commands are documented in `.agent/commands.md`.

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
2. Add and run a failing test before implementation.
3. Keep external side effects behind an outbox and stable idempotency identifiers.
4. Use disposable SQLite, userData and credential fakes in tests. Never read real Electron userData.
5. Never log or return tokens, cookies, CSRF values, message bodies, persona, memory text, A2A payloads or absolute paths.
6. Run the fixed validation commands before handing off a milestone.

## Fixed validation commands

```text
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run test:e2e
npm run build:prod
npm run package:verify
```
