# ADR 0001: Runtime boundaries and toolchain

- Status: Accepted
- Date: 2026-07-15

## Context

joi needs one desktop runtime, one shared web interface, recoverable local state, and replaceable A2A Agents. The renderer must not gain Node, database, credential, or A2A privileges.

## Decision

Use one npm package with Electron, React, TypeScript and Vite. Production code is classified into domain, application, infrastructure, interface, preload, renderer, shared, and the Electron composition root. A script parses TypeScript imports in CI and rejects unclassified paths or disallowed dependencies.

Use Vitest for unit, integration, contract and renderer tests. Use Playwright Electron for desktop flows. Every test uses disposable paths below the operating system temp directory and an in-memory credential fake.

The product UI uses Radix Themes as its accessible component foundation, Phosphor as the only icon family, custom semantic CSS tokens, system UI fonts, and restrained state-transition motion.

## Consequences

- Domain and application code remain testable without Electron or SQLite.
- Renderer DTOs cannot accidentally serialize SDK or database objects.
- New production directories fail CI until their ownership and dependency rules are explicit.
- TypeScript stays on 6.0.x until the lint toolchain supports TypeScript 7.
- macOS packaging and lifecycle behavior still require a real macOS runner or device.
