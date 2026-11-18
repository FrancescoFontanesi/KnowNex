# KnowNex

Secondary memory for projects run with LLM agents: code, research, notes. The
opposite of compacting: instead of summarizing and losing detail, KnowNex
records the conversation and curates it into an explorable Markdown memory, so a
new session (or another person) restarts from the last operational state
without rereading all the documents or rebuilding the project from the code.

Current version: **0.1.0-rc.11**. Captured providers: Codex and Claude Code (`knownex init --provider codex,claude`).

## How it works

1. **Capture.** Hooks record user messages and final assistant replies in a
   local JSONL feed, without consuming tokens. The feed is the authoritative
   source and keeps everything.
2. **Explicit checkpoint.** Only the user starts it, for example with
   `npm exec --offline -- knownex checkpoint --codex -m gpt-6.1-sol -r medium`
   (or `--claude` or `--agy`). The command freezes the batch of events, starts an
   ephemeral provider session that is not recorded in the feed, and the Curator
   reads the batch and writes a draft (new STATE, Knowledge notes, report).
   `curate write` validates it immediately, so the Curator fixes errors while it
   works; when it finishes, the command publishes the draft transactionally and
   returns only the outcome. Work can continue in parallel: later events go to
   the next checkpoint.
3. **Resume.** When a session starts, STATE enters the context. Everything else
   is opened only when needed: a known reference is read directly, a search is
   delegated to a subagent that follows the `knownex-recall` skill.

## The memory

Everything you explore lives in `.knownex/memory/`, which can also be opened as
an Obsidian vault:

```text
.knownex/memory/
  STATE.md                       root: goal, decisions, blockers, next actions, links
  HISTORY.md                     checkpoint index, one line each
  history/H000012.md             one checkpoint window: transition, notes written, resulting STATE
  knowledge/H000012/             notes written by that checkpoint (same id as in HISTORY), immutable
    storage--kn-UUID--REV.md
```

- **STATE** is the root of the tree: it points to the Knowledge notes instead of
  containing them.
- **Knowledge** notes are thematic notes with text and references to code and
  artifacts (paths from the workspace root), written like a logbook: each
  checkpoint adds new notes in its own folder and does not rewrite existing
  ones, so the same name can come back in different checkpoints. If a decision
  changes, the new note links the one it supersedes; STATE links the notes with
  the current truth, and the earlier ones show the evolution.
- **HISTORY** is read in windows: `memory history` lists the checkpoints without
  opening them, `memory read H000012` opens only what is needed.
- **Provenance.** Every statement cites the events it comes from, such as
  `[E017]`: the event's sequence in the feed. `pending` reads only the events
  not yet curated; `memory event E017` (or `E015..E016`, at most 20 events)
  reads any event in the feed, curated or pending.

Feed, runs, journal and receipts live in `.knownex/internal/`, outside the vault.

```powershell
npm exec --offline -- knownex memory state
npm exec --offline -- knownex memory history --last 10
npm exec --offline -- knownex memory read H000012
npm exec --offline -- knownex memory find "distinctive terms"
npm exec --offline -- knownex pending
```

## Language

KnowNex's instructions (the `AGENTS.md`/`CLAUDE.md` block, the skills and the
curation prompt) are in English, but they do not choose the language you work
in:

- The main session answers in the language you write in; the instructions say
  so explicitly.
- The Curator writes STATE, notes, HISTORY descriptions and the report in the
  language the batch events mostly use. Once STATE has a language, it is kept
  unless the conversation clearly moves to another.
- Recall answers in the language of the request. `memory find` matches words,
  so search terms work best in the memory's language.
- Fixed parts stay in English: file names, note names, JSON keys, error codes,
  the `[E017]` labels and the labels the runtime writes in HISTORY windows
  (`- Date:`, `- Events:`, `## Resulting STATE`).

Only the current memory format is supported: a workspace installed with an
earlier release candidate needs a fresh `knownex init` and a new memory.

## Guarantees and limits

- The runtime checks structure, provenance, links, note identity and input
  integrity; publication is transactional and recoverable after a crash.
- It does not guarantee semantic completeness: the Curator decides what to keep.
  Declared uncertainties or anomalies block automatic publication.
- Retroactive changes not captured by the hooks are not detected.
- Offline tests do not prove the behavior of a real model.

## Documentation

- [Installation, update and removal](docs/INSTALL.md)
- [Memory contract](docs/MEMORY-CONTRACT.md) and
  [Knowledge revisions](docs/KNOWLEDGE-REVISIONS.md)
- [Navigator and recall](docs/NAVIGATOR.md)
- [Layout, compatibility and limits](docs/MEMORY-LAYOUT.md)
- [Full index](docs/README.md) · [Vision](docs/VISION.md)

## Development

Requires Node.js 24.11+ or 26, npm and Git. The installed package does not
require a global TypeScript, providers or additional runtime dependencies.

```powershell
npm ci
npm run check          # typecheck, test, Prettier, build
npm run dev -- --help
```

The code uses ESM and relative `.ts` imports; the build produces JavaScript in `dist/`.

- `src/`: `index.ts` (the `knownex` binary) and one folder per area: `cli/`
  (commands and `init`), `hooks/`, `feed/`, `checkpoint/`, `curation/`
  (memory writes), `memory/` (memory reads), `shared/` (I/O, locks, paths).
- `tests/`: deterministic checks with synthetic data; `helpers/` for shared
  builders.
- `skills/`: curator, recall and taxonomy skills shipped with the package;
  `init` installs them into the workspace's `.agents/skills/`.
- `.codex/hooks/`: hook scripts (the same scripts also serve Claude Code).
  Installed wrappers load them from this path in the package.
- `docs/`: current contracts and procedures.

KnowNex is not installed in this repository: there are no active hooks, skills
or memory here. `node_modules/`, `dist/` and the `graft/` cache are excluded
from Git.
The evaluation harnesses (retrieval and cold restart, with `scripts/measure.ts`)
are archived outside the repository, in `F:\KnowNex-archive\`.
