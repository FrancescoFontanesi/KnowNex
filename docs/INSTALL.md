# Installing KnowNex 0.1.0-rc.11

Requires Node.js 24.11+ or 26, npm and a Codex or Claude Code workspace. The package is local and
private: it does not require providers, runtime dependencies or global configuration.

## Installing in your project

Open PowerShell in the project root and point to the archive you received:

```powershell
npm install --offline --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "C:\percorso\knownex-0.1.0-rc.11.tgz"
npm exec --offline -- knownex init
```

The CLI stays local: `npm install` generates the shims in `node_modules/.bin`,
including `knownex.cmd` on Windows. From the project root use
`npm exec --offline -- knownex ...`, also for `memory state` and `memory read`.
No global installation is needed. Copying only `node_modules/knownex`
is not the same as installing the package and does not generate the npm shims.

Init also returns `nextSteps`: open the exact project root in
Codex, explicitly authorize it if asked, and approve the hooks with
`/hooks` or **Review hooks**, then start a new session. Authorizing a
container folder does not prove trust of the individual child workspaces. Init
does not write to the global `config.toml` and does not approve the hooks.

### Claude Code

```powershell
npm exec --offline -- knownex init --provider codex,claude
```

`--provider` chooses which harnesses to register (`codex`, `claude` or both);
without the option init keeps the providers already installed, Codex for a new
project. For Claude Code init creates `.claude/hooks/knownex-*.cjs`, adds its own
SessionStart, UserPromptSubmit and Stop hooks to `.claude/settings.json`
while preserving existing settings and hooks, and inserts the same block of
instructions in `CLAUDE.md`. Events enter the same project feed with
`provider: "claude"`; the turn is Claude's `prompt_id`, and subagent turns
are not recorded. A `.claude/settings.json` that cannot be read as JSON produces
`BOOTSTRAP_CLAUDE_SETTINGS_INVALID`. Open the project in Claude Code, accept
the workspace trust and check the hooks with `/hooks`. Claude Code injects at
most 10,000 characters of context: a longer STATE arrives as a file with
a preview.

Global hooks of other tools, such as Graft, stay separate and are not
modified. A pre-existing, unmanaged local `.codex/hooks.json` produces
`BOOTSTRAP_CONFLICT`: compare and merge the files explicitly, without
deleting personal hooks to force the installation.

Open that folder as a Codex workspace and start a new chat from its
root. If Codex asks for **Review hooks** or `/hooks`, approve the project hooks.
This approval belongs to the runtime and is not simulated by init.
There is no need to configure AGENTS.md, skills, memory or checkpoints.
The initial STATE and the confirmed one have the same path .knownex/memory/STATE.md.
HISTORY and the per-checkpoint Knowledge are in the same memory; the feed and the
Curator live in .knownex/internal/. No seed/ or memory/ in the root.
rc.11 ships this layout in new installations. [Canonical layout and legacy compatibility](MEMORY-LAYOUT.md).

Init removes from previous installations, if unmodified, the skill
`knownex-checkpoint`, the custom agents `knownex_curator`/`knownex_recaller`,
`.codex/config.toml`, the `knownex-stop.cjs` wrapper with its `Stop` and
`SessionEnd` entries (the transcript copy no longer exists,
[details](AUTOMATIC-CAPTURE.md#previous-installations)) and the documents in
`.knownex/internal/docs/` that are no longer shipped. No global configuration is modified. KnowNex does not
install, initialize or run Graft.

KnowNex captures the events, provides STATE and reports the pending between sessions.
The main session reuses the available context, directly reads an already known
reference with `memory read` and delegates history, taxonomy and searches to a
generic subagent of the harness that follows the `knownex-recall` skill. Permissions are those
of the harness. If delegation is missing, the main session reports the limit without an
automatic fallback.

The main session suggests the checkpoint command at significant milestones, without
waiting for an answer, and never curates the memory. To save, the user runs
`npm exec --offline -- knownex checkpoint (--codex | --claude | --agy) [-m MODEL] [-r EFFORT]`
(or explicitly asks the main session, which launches it in the background); each run
handles a single batch. Details in [CURATION-WORKFLOW.md](CURATION-WORKFLOW.md#knownex-checkpoint-command).
The installer does not start any model.

The checkpoint uses the captured feed and does not require App Server, provider
history or access to global databases.

## Update and reinstallation

Run the same two commands with the new archive. The same version is
idempotent. Init updates unmodified generated files, preserves personal text
outside the KnowNex block in AGENTS.md and adds the necessary ignores
without deleting existing rules.

Feed, memory, checkpoints, consents, journal and staging stay intact, as do the
old transcript copies in `captures/`, which no command reads any more.
`.knownex/internal/install.json` (legacy: `.knownex/install.json`) contains only the version and hashes of the managed resources;
it is not a memory registry. A difference in managed files is updated
only if it matches the installed hash. For S3, which has no manifest, only the exact
hashes of the resources shipped in the original archive are recognized.

Personal changes to hooks, skills or managed documents produce
`BOOTSTRAP_CONFLICT` with the file involved, before updating the project files.
Do not delete memory or configuration to work around it: keep the changes and
compare them explicitly with the new version. Ambiguous AGENTS markers, symlinks
in managed paths or corrupt manifests are rejected.

Legacy per-session feeds are kept and reported as
`LEGACY_SESSION_FEEDS`: updating the package is not a migration of their
content into the project feed. Moving a curated workspace also requires
review: checkpoints keep the paths of the original workspace.

The question/answer policy has been removed since rc.4. Old consent.json files are
preserved but not read. An unconfirmed batch of the old protocol can be
withdrawn, not applied; already authorized applies recover through the journal.
Starting a new batch requires a new start of `knownex checkpoint`.
The update does not start checkpoints. Open a new chat to load the updated skills
and avoid instructions of the previous workflow left in the context.

Pre-existing `memory/` folders are not deleted or modified: they may
contain personal notes or data from earlier versions. The new workflow does not
use them implicitly; they remain readable with `--memory memory` if needed.

## Uninstallation

```powershell
npm uninstall --no-save --package-lock=false --ignore-scripts --no-audit --no-fund knownex
```

Remove only the KnowNex hooks from `.codex/hooks.json` (and `.claude/settings.json`)
and the wrappers `knownex-feed.cjs`, `knownex-session.cjs`; remove the three skills
`knownex-curator`, `knownex-recall`, `knownex-taxonomy` and the `knownex:start/end` block
from AGENTS.md, preserving personal instructions. No global configuration
is modified. **Keep `.knownex/`, `memory/` and the logs as long as they are needed**:
they contain memory, sources, consents and evidence. Do not delete them automatically.

## Checks and limits

The release is verified from the repository with the suite and an integrated test
of the archive installed and reinstalled offline in an external temporary folder,
with synthetic payloads and source access denied to the runtime processes:

```powershell
npm ci
npm run check
npm pack --pack-destination "C:\pacchetti"
$env:KNOWNEX_INSTALL_ARCHIVE = "C:\pacchetti\knownex-0.1.0-rc.11.tgz"
node --test tests/bootstrap.test.ts
```

The test on the original S3 fixture (`KNOWNEX_PREVIOUS_WORKSPACE`) is optional: a
skipped case does not prove compatibility with that historical installation.

These checks do not prove spontaneous skill selection, milestone recognition,
real skill invocation, hook execution by the provider or delivery of STATE to
the model: they require a real session. Open limits:

- workspace trust and hook approval require explicit intervention;
- Curator review and structural checks do not prove semantic completeness;
- retroactive edits not captured by the feed are not detected; the hashes do not
  certify an external conversation;
- `DESTINATION_BUSY` was observed in a full suite with no established
  cause; conservative locks are not bypassed.

Hook commands are relative to the root: start the provider from that folder.
Physical durability and NTFS limits remain those of [Storage](STORAGE-DURABILITY.md).
Technical details in [Runtime](RUNTIME.md) and [Checkpoint](CURATION-WORKFLOW.md).
