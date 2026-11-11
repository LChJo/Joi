# Conversation workspace dependencies

The desktop Git adapter uses **simple-git 4.0.2** (MIT) with a callable, installed Git binary. The renderer uses **diff2html 3.4.56** (MIT) to parse diffs and renders the parsed structure as React text. No raw diff HTML is injected. Git commands are constructed in infrastructure from an allowlist; user input never supplies a cwd, executable, command, remote URL or force flag.

Sources: [simple-git](https://github.com/steveukx/git-js), [diff2html](https://github.com/rtfpessoa/diff2html). Dugite was also considered; simple-git keeps the existing installed-Git workflow without adding a bundled Git distribution to the desktop package.

The packaged `resources/licenses` directory contains the complete simple-git and diff2html MIT licenses, the bundled `diff` BSD-3-Clause license and `@profoundlogic/hogan` Apache-2.0 license. npm retains the dependencies' own license files as well.

Remote Git operations use the user's existing Git configuration and credential helpers. The application neither reads nor returns credentials. Missing Git, missing upstream configuration and unsuccessful authentication are reported as unavailable/failed operations. A pull uses fast-forward only; the UI does not expose force push, reset-hard, clean or credential entry.

Conversation sessions pin `@earendil-works/pi-agent-core`, `pi-ai` and `pi-coding-agent` to **1.5.2**, `typebox` to **1.3.27**, and **pi-subagents 0.88.0**. Sources: [Pi SDK](https://github.com/earendil-works/pi/tree/v1.5.2/packages/coding-agent), [pi-subagents](https://github.com/nicobailon/pi-subagents). Packages ship in production dependencies for offline module loading. Joi uses the package's external-job provider and capability-ceiling APIs with its own persistent, permission-bound executor. It does not discover or run unreviewed external agent definitions. The complete pi-subagents MIT notice is included in `resources/licenses/pi-subagents-MIT.txt`; npm also retains package notices. See ADR 0033 for session/compaction ownership.
