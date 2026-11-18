# Checkpoint and curation

## `knownex checkpoint` command

```powershell
npm exec --offline -- knownex checkpoint --codex -m gpt-6.1-sol -r medium
npm exec --offline -- knownex checkpoint --claude -m claude-opus-5-5 -r high
npm exec --offline -- knownex checkpoint --agy -m gemini-4-hydrogen-high
```

`--through <n>` sets the batch cutoff instead of the last captured event. If
a batch with a different cutoff is already prepared, the command returns
`CURATOR_PENDING_EXISTS`. Withdraw it first with `curate abandon`.

The command runs prepare and starts a non-interactive, non-persisted provider session
(`codex exec --ephemeral -s read-only` or `claude -p --no-session-persistence`)
with `KNOWNEX_CAPTURE=0`, so the curation does not enter the feed. The session has a
minimal context. The provider's system instructions are replaced by one line. There is no
project AGENTS.md or CLAUDE.md, no skills, plugins or multi-agent, and no tools,
including shell and MCP servers. Codex uses `-c` overrides, and the MCP servers are switched off one by
one after `codex mcp list --json`, because their names depend on the user's config.
Claude uses `--safe-mode`, `--strict-mcp-config`, `--system-prompt` and `--tools ""`.
Without tools the session cannot turn into more model calls. The fixed context drops
from about 22k to 4k tokens with Codex and from 47k to 3k with Claude. Only
the global `~/.codex/AGENTS.md` remains, which Codex loads from its home. Antigravity
(`agy`) has no `--settings` flags or keys for instructions, tools and rules. The command
writes the custom agent `knownex-curator` (`excludeDefaultComponents`, `tools: []`,
`inheritMcp: false`) in `.knownex/internal/agy/.agents/agents/` and starts `agy
--agent=knownex-curator` with that folder as the current directory. The fixed context
drops from about 16k to 0.4k tokens, with no AGENTS.md, skills, plugins or MCP servers. The task
goes as a single `--input-format=stream-json` turn on stdin. `-m` becomes `--model=`
and `-r` becomes `--effort=` (agy rejects an effort that conflicts with an id that already includes it, for
example `gemini-4-hydrogen-high`). Agy has no way to avoid persisting the session. It stays
in its local conversations (`~/.gemini/antigravity-cli/conversations`). On stdin the command passes
the whole task in a single message: skill, WINDOW.md and the frozen STATE, with no
catalog of existing notes. From the skill it removes sections 1 (reading the batch)
and 6 (delivery with tools), which apply only to the manual path with tools. Existing notes are neither rewritten nor read. To
supersede one, the model copies its link from STATE (path from the root of the
memory, valid both in the new STATE and in a new note). New notes are named
`knowledge/<name>.md` and the runtime places them in `knowledge/H000NNN/<name>.md`, with
the checkpoint's HISTORY id. The name can repeat across checkpoints. The model answers with a single
JSON (proposal, STATE, notes, report) in one call, instead of one
call per step with tools. Each call pays for the provider's fixed context again. The command writes the draft and validates it like `curate write`. If it is
rejected, the command re-submits the task once with the error code. The re-submission applies
only to errors in the model's answer. A busy lock (`DESTINATION_BUSY`) or
an I/O error during delivery stops the command without consuming it and leaves the
batch `prepared`, to be relaunched with the same command. If instead the draft
is valid but the report declares uncertainties or anomalies, the second call is targeted.
It passes only the blocking points, the batch events they cite (all of WINDOW.md if none
are cited) and the previous answer, without skill and STATE. The model answers with
only the keys that change (usually `review`) and the command merges them onto the previous
answer. It removes only points resolved by the sources or already recorded in memory as an open
problem. If the revision cannot be interpreted or is rejected, the first
delivery stays, with outcome `BLOCKED`. Calls stay at two at most. The final message and the usage are read from the structured output of the
provider (`codex exec --json`, `claude -p --output-format json`, the last `result` event
of agy, which counts as failed if it does not arrive or is not `SUCCESS`). A missing final
message (`CODEX_MESSAGE_MISSING`, `CLAUDE_RESULT_MISSING`) or a Claude result with
`is_error` counts as a failed session. The raw answer
stays in `session.log` in the run. Then it runs complete and prints only the outcome
(`SUCCESS`, `BLOCKED`, `ERROR` with code) with `tokens`: input (cache included),
cached, output and reasoning of all attempts. With `BLOCKED` the outcome reports the
blocking points (`blocking`), the report to read (`review`) and two ready commands in `next`: `curate apply
--confirm <seal>` to publish the proposal as is, `curate abandon` to
discard it and return the events to pending. Model and reasoning are
passed unchanged to the provider. A second start while one is running returns
`CHECKPOINT_BUSY`. A failed session without delivery returns
`CHECKPOINT_PROVIDER_FAILED` and leaves the batch repeatable.

## Prepare, batch and result

The prepare command is the operational trigger, independent of the feed. The runtime
freezes the events already captured and the snapshots before curation. A final assistant message or a
Codex format is not needed to prepare the batch. Complete verifies the run, the receipts and the
prefix at the cutoff. Later appends are for the next batch.

Only the user (or the main session on explicit request) starts the checkpoint.
There is no consent token in the feed. Prepare reads the registry under the Curator
lock and fixes the cutoff. By default this is the last captured event. Otherwise it is an explicit cutoff within the captured prefix and not
earlier than the confirmed checkpoint. The run contains `packet.json`, `WINDOW.md`,
`inputs.json`, the `base/` snapshot of the memory and the frozen skill. The manifest
records bytes and SHA-256 of the inputs. A repeated prepare returns the same active
batch. An empty batch needs no curation. A failed preparation does not
consume events. Events captured during curation do not enter the packet:
the feed path stays a provenance reference, not a live document.
The feed binding prevents a second Curator workspace from using it.

Prepare and complete verify the captured feed and the batch binding, without
provider history, bridge or widening of permissions. Original turns
modified retroactively outside the feed are not a source of invalidation.
The explicit trade-off of the MEMORY-CONTRACT applies.

The runtime is invoked with `npm exec --offline -- knownex ...`. A missing runtime
is a blocking error, not a request to search npm/npx.

The conclusive result of complete is a `SUCCESS`, `BLOCKED` or `ERROR` object,
with cutoff, available counts, code/phase, essential diagnostics and
references to internal artifacts. It contains no documents. Any declared
uncertainty/anomaly blocks automatic application. The command and the manual path
(`curate prepare/validate/apply/write/complete --run`) share the
same publication function and transactional guarantees. The review is v4,
with every batch event in `sources` or in `ignored`; no other review version is accepted.
`curate write` accepts only new notes: Knowledge is a logbook, the current
truth is in the notes linked from STATE and the earlier ones show the evolution.

## Curator I/O

In the manual path the Curator uses `curate read` and `curate write` of the
installed CLI (`npm exec --offline -- knownex curate ...`) to read the frozen
inputs and to deliver proposal and review. It returns only the receipts. The
`knownex checkpoint` command uses no tools. It passes the task in one message and
delivers the draft itself with the same validation. The CLI reuses the canonical
primitives, with no alternative writer or transcription by the caller. From a checkout,
run the build first. The frozen skill and the runtime come from the same
distribution. Do not mix an installed package and a working tree.

## Publication policy and semantic limits

The explicit prepare command creates a frozen batch. apply requires its seal.
With a positive validation and the `uncertainties` and `anomalies` arrays both empty,
the controller applies automatically under that authorization. Any entry
blocks publication. There is no permissive classification by severity or keyword.
The block keeps the artifacts for explicit examination.

**There is no independent semantic review in the ordinary path.**
The Curator keeps self-verification of coverage, historical comparison and critical continuity.
Hashes, sources, ranges, links and structural validation remain mandatory,
but they do not prove semantic relevance or the absence of undeclared omissions.
A formally valid report can be incomplete. The result does not flag it
with any warning, because a warning that is always present does not inform.

A batch already claimed does not relaunch the session. Errors return code,
phase, confirmed cutoff or null if not verifiable, action and diagnostic path.
There is no document dump. Recovery of an already authorized apply and replay are idempotent
and need no new sessions. A BLOCKED batch is examined with `curate validate`
and, only after explicit review, `curate apply --confirm`. A new attempt
requires explicit withdrawal of the old batch (`curate abandon`) after the end of the
session. Manual commands remain for exceptions.
Immutable revisions, layout, cutoff and journal do not change.
