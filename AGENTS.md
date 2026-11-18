# KnowNex development

This repository develops KnowNex. KnowNex is not installed here: do not run
`knownex checkpoint` or recall in this folder and do not suggest it. The usage
instructions that `knownex init` writes into a user's workspace live in
`policy` in `src/cli/bootstrap.ts`, not in this file.

## Commands

- `npm run check`: typecheck, all tests, prettier check and build. Run it
  before handing work back.
- `npm test`, `npm run typecheck`, `npm run format`.
- Installer: `npm pack` builds the `.tgz` (`prepack` runs the build).

## Layout

- `src/index.ts`: the `knownex` binary; it routes to the commands in `src/`:
  - `cli/`: commands (`cli/cli.ts`, `curate` in `cli/curator-cli.ts`,
    `taxonomy` in `cli/taxonomy-cli.ts`) and `init` (`cli/bootstrap.ts`, which
    also holds the workspace `policy`).
  - `hooks/`: what the installed hook scripts run (feed capture, SessionStart).
  - `feed/`: the append-only event feed, its reader and intermediate messages.
  - `checkpoint/`: `knownex checkpoint`: prepare, the one-call provider
    session (`checkpoint/checkpoint-launcher.ts`), draft delivery, complete.
  - `curation/`: memory writes: prepare, validate, apply and recovery
    (`curation/curator.ts`), HISTORY, Knowledge revisions, taxonomy.
  - `memory/`: memory reads (`memory/navigator.ts`) and session status.
  - `shared/`: UTF-8 file I/O, locks, workspace paths.
- `tests/`: one `*.test.ts` per area, `tests/helpers/` for shared builders.
  Fixtures build memory through real checkpoints, not hand-written files.
- `skills/`: the curator, recall and taxonomy skills shipped to users; `init`
  installs them into the workspace's `.agents/skills/` (kept out of
  `.agents/` here so no agent loads them while developing). The curator skill
  is also the curation prompt (sections 1 and 6 are dropped for the one-call
  flow).
- `.codex/hooks/`: the hook scripts installed workspaces call through
  wrappers, by this path in the package: do not move them. There is no
  `.codex/hooks.json` here on purpose.
- `docs/`: user and design documentation; `tests/docs-links.test.ts` checks
  its links and the source paths it names.

## Conventions

- Code, comments, docs, skills and runtime messages are in English. Memory
  content follows the user's language; runtime labels stay fixed.
- Only the current memory format is supported: no compatibility code for
  formats or installs of earlier releases. A format change needs a new
  memory, not a reader for the old one.
- Prettier formats everything; keep tests next to the behavior they prove.
