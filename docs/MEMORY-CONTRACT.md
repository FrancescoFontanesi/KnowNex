# KnowNex — Procedural memory contract

The JSONL feed captured by the hooks is the authoritative source of
materialization: recorded texts, order, sequences, available identities and
provenance. Prepare freezes the events after the confirmed cutoff; complete
verifies the SHA-256 chain, the batch binding and the authorization without
querying the Codex history.
Retroactive edits or deletions not captured by the hooks are not detected
automatically: the memory keeps the history as actually recorded.
Hashes verify internal integrity. They do not verify the authenticity or
completeness of the original conversation, and they do not protect independently
against a process that can rewrite the feed and the metadata in the workspace.
Confirmed exclusions and revisions stay preserved, with
no retroactive reconstruction.

## Confirmed memory

The [optional thematic maintenance](TAXONOMY.md) keeps associations to exact
revisions in separate metadata. It does not change the content, paths or
provenance of the confirmed memory; the derived Markdown indexes are not a second
memory.

```text
memory/
├── STATE.md
├── HISTORY.md
├── history/H000001.md
└── knowledge/H000NNN/[category/]<name>--kn-UUID--REV.md
```

`STATE.md` is the navigable operational root, authoritative up to the confirmed
checkpoint: goal, current situation, active decisions, constraints, prerequisites,
open activities, blockers and next actions sufficient for an ordinary cold start.
It links the detailed Knowledge notes with descriptive Markdown links, directly or
through other notes. It is neither a narrative summary nor a structured transcript.
Detail that is not immediate stays reachable without duplicating all of it in STATE.
Completeness concerns the materialized, navigable set, not STATE alone;
the original feed does not replace preservation in the Knowledge notes.
A non-empty Markdown title is mandatory;
completeness and correctness of the statements require review by the main session.

STATE has no size limit imposed by KnowNex: its length depends on the operational
context needed. The decomposition into Knowledge notes follows semantic cohesion
and navigability, not a byte or token threshold. Do not delete essential items to
make STATE smaller.

Validate exposes stateBytes of the final text as a non-blocking UTF-8 diagnostic,
after rebasing and link fixing. Prepare does not impose a budget and apply does not
reject a proposal for size alone. Noop, recovery and replay fully preserve the authorized generation.

SessionStart tries to emit the complete STATE in additionalContext
at startup (not after compact, where the summary already contains the context),
without truncation or alternative representations.
KnowNex verifies the payload it produces, not the actual delivery to the model:
execution, output handling and context window depend on the harness.
The [runtime contract](RUNTIME.md) distinguishes these boundaries and the
documented limits.

`HISTORY.md` is the chronological index of the checkpoints: one line per confirmed
update, so opening it costs little even after hundreds of checkpoints. The detail
of each checkpoint is an immutable window `history/H000001.md`, which opens on its
own: metadata, revisions written by that checkpoint and the STATE produced, with
links moved up one level (`../`). The already confirmed text of HISTORY stays an
identical byte-for-byte prefix and a window never changes again; an index and its
windows match one to one, with no orphans and none missing.

```markdown
- [H000003](history/H000003.md) · `2026-11-03T12:00:00.000Z` · `E015..E016` · contract; curation — adopting the contract
```

```markdown
# H000003 — contract; curation

- Date: `2026-11-03T12:00:00.000Z`
- Events: `E015..E016`
- Topics: contract; curation
- Description: adopting the contract
- Transition: state updated; reasons in the [note](../knowledge/H000003/contract--kn-UUID--REV.md).

## Notes written

- [knowledge/contract.md](../knowledge/H000003/contract--kn-UUID--REV.md)

## Resulting STATE

# Project

…
```

HISTORY.md holds only the index lines.
The windows are not Curator input and are not copied into the runs.

The IDs `H000001`, `H000002`, … are progressive.
The date derives from the capture of the last included event; it does not claim to
date the decision more precisely. The range indicates the materialized batch.
An explicit `noop` confirmation can advance the checkpoint without replacing STATE
and without adding history. Without new events, prepare does not change the memory.

The Knowledge notes are a logbook: each checkpoint adds new notes with what it
introduces and never rewrites the existing ones (a note with the identity of an
existing one is rejected with CURATOR_NOTE_ID_DUPLICATE, also with manual
`validate`/`apply`).
Each new note lives in the folder of its checkpoint, so the name can repeat across
checkpoints. If a decision changes, the new note states the new truth and links the
one it supersedes, copying the link from STATE; the old note stays unchanged and
shows the evolution. STATE is the only cumulative document and links the notes that
contain the current truth. Notes are created only for topics that justify
independent consultation; not per turn or milestone.
They are self-contained, detailed and linked topical documents:
they keep facts, results, technical details, decisions and reasons, alternatives,
conditions, exceptions, uncertainties, relations and open questions, even minor ones.
Attribution, provenance, circumscribed negations and degree of certainty must keep
their meaning. Do not infer unsupported identities, completions or guarantees.
Explain supported corrections and supersessions, avoiding duplication and artificial
fragmentation.
Each note uses this restricted frontmatter, not general YAML:

```markdown
---
id: kn-00000000-0000-4000-8000-000000000001
type: knowledge
---
```

Real IDs are lowercase UUID v4 with the `kn-` prefix, unique and immutable.
Confirmed paths are kept: this cycle exposes no deletion, renaming or alias
families.
There are no other mandatory documents and no separate provenance index.

The [revisions contract](KNOWLEDGE-REVISIONS.md) adds an immutable archive outside
the active tree. Current notes stay complete; the v3 checkpoint keeps the current
references.

## Pending window and provenance

The S2.1 feed is the only authoritative source of messages. The window contains the
sequences after the checkpoint. `prepare` reads the verified feed and freezes its
upper bound, an explicit `--through` or the last complete event present.
Later new events stay pending. `WINDOW.md` and `packet.json` in staging
are regenerable derived copies, not alternative archives; they are not edited to
correct the feed. The packet includes session, turns, sequences, checksums and
source bytes. It does not contain the body of the old HISTORY. `WINDOW.md`, verified
by the manifest, is the Curator's reading copy: events with sequence, type and full
text, session and turn when they change, and a header with citable
artifacts, approved categories, directive and ordering warnings.

Explicit provenance is a label in square brackets without a link, for example
`[E017]` or `[E015–E016]`, or the `- Events` field in
the HISTORY windows.
The feed lives outside the memory folder: a link to it would be broken in Obsidian
and would open a whole JSONL for an agent, while the label is enough to read the
event by sequence. A link to the feed is not accepted in memory and the feed is not an authorized
link target. When a Curator draft still writes a linked label, `curate write`
reduces it to the bare label.
Titles, topics and ordinary prose not in square brackets (even `Catalogo E1` or
`E999`) do not declare provenance.

Every reference uses `E` followed by the number with at least three digits, with no
extra zeros: `E001`, `E017`, `E1000`. Text in square brackets that starts like a
label (`[E1]`, `[E002–E001]`) is treated as a label and therefore rejected if
malformed; all IDs present must be valid. Ranges use `E015–E016`, `E015..E016` or `E015-E016`,
with ordered, inclusive endpoints; incomplete or chained ones are rejected. The
HISTORY field keeps the syntax `E015..E016`. A linked label (`[E017](...)`) is
rejected: provenance is only the bare label.
Code and artifacts are cited as paths from the workspace root in backticks;
any links to external files stay limited to authorized artifacts.

For recognized references, the sequence is
scoped to the project feed. They are not JSONL
anchors. Cited sequences must exist and be within the frozen cutoff. STATE and every
Knowledge note must have at least one reference to the feed. The only exception is
the canonical empty seed of the bootstrap, with no materialized facts; init at
sequence zero confirms no events. The feed does not contain tool output: STATE and
every note state once that the results are those reported in the conversation and
mark only the exceptions (verified in person by the user, disproved or corrected
later). Distinguish proposal, approved decision and disproved item; an assistant
report alone does not prove the execution of an experiment. Attachments not present
in the feed cannot be reconstructed. No semantic inference of identity.

Relative inline Markdown links, with no images or reference links; encode spaces as
`%20`. Internal links and anchors must exist. Original artifacts, including CSVs,
logs and reports, must exist and be already referenced by the memory or explicitly
authorized by the main session with `--artifacts`. The code rebases external links
between staging and the confirmed memory. Do not copy conversations into logs.

## Materialization

Selection concerns informational content, not message type.
Generic explanations, summary requests, administration and transient troubleshooting
with no consequences may leave no knowledge. Reusable explanations, changes,
diagnostic causes, constraints or lasting decisions must instead be kept, also in
mixed messages. No keyword filter.
Context savings come from selective consultation, not from losing substantial
information or from systematically deferring to the feed.

The main session suggests when to materialize (the user starts the command):
significant progress, change of focus, handoff, compaction if the trigger is
available, or explicit invocation.
The `knownex checkpoint` command starts a single provider session without analyzing
or synthesizing the sources. Short priorities can be added.

In the --autonomous flow, prepare freezes the batch and the current base; inputs.json
provides paths, hashes, identities, titles and headings of the Knowledge notes. The
packet contains STATE and the authorized events, not the note bodies. The Curator
reads the whole batch on its own and chooses the historical and thematic context
needed; it reads an existing note only to cite or supersede it, without rewriting it.
It does not preload all the Knowledge notes. Missing essential sources require a
stop, not duplication or implicit widening of the batch. No second session.

The packet, WINDOW.md, the skill and the frozen base are the authorized inputs;
this contract is not frozen into the runs. The published proposal
is a UTF-8 JSON with no Markdown fences; `curate write` assembles it from the draft,
in which the Curator writes STATE and notes as separate files:

```json
{
  "action": "update",
  "state": "# State\n\nUpdated context and sources...\n",
  "history": {
    "summary": "Short searchable description",
    "topics": ["topic"],
    "transition": "What changes and why; any Knowledge links."
  },
  "knowledge": {}
}
```

`knowledge` contains only complete texts of new notes, with keys
`knowledge/<lowercase-name>.md` (lowercase letters, digits and single hyphens); the
runtime publishes them as `knowledge/H000NNN/<name>.md`, so a name from the frozen
base can be reused; no deletion. `state` is complete. Links
resolve relative to `runs/<id>/base/`; a new note is written as if it were in
`base/knowledge/`, and the runtime moves its links into its own folder. No field to
rewrite HISTORY.
Description, topics and transition are non-empty single-line strings.
The optional categories field of update associates only new notes
with keys of the taxonomy registry frozen in the packet. Omission means no
category. The knowledge/topic.md paths are logical keys of the packet/proposal. New
or modified confirmed revisions use memory/knowledge/H000NNN/[category]/ (the id of
the HISTORY entry), with no second flat current copy. Details
and registry format are in the [revisions contract](KNOWLEDGE-REVISIONS.md).
A proposal with no effective change is rejected: use `{"action":"noop"}`.

`validate` generates the candidate and the history segment, verifies Knowledge
identity, provenance, links, write boundaries and the frozen source, without
changing the confirmed memory. In the ordinary path `knownex checkpoint` runs
prepare, starts the session that curates the frozen batch and, after delivery with
`curate write`, runs complete (`curate complete --run RUN`). The primitive reads
proposal and review from the run, validates and invokes apply with the seal of the
frozen batch. The trigger is the explicit prepare command, not a message or a
permission derived from the feed.
Any entry in uncertainties or anomalies blocks the automatic apply. The checkpoint
advances only after the writes. The historical comparison, critical continuity and
the preliminary coverage check belong to the Curator; there is no independent
semantic review in the controller. This trade-off remains: validation does not
prove semantic completeness or relevance. The targeted review and apply --confirm
remain an explicit manual path for exceptions, not an ordinary step.
The command passes to the session only the run's task. Feed sequence/checksum
are frozen in the run and in the controller receipt.
Complete requires only the same run, with no new authorizations. Before the
delivery of proposal and review it returns CURATOR_WORKER_OUTPUT_INCOMPLETE and
leaves the run prepared; with a write in progress it returns DESTINATION_BUSY,
also repeatable.
After complete has taken over the delivery, every error is final for the run.
The final result is a SUCCESS/BLOCKED/ERROR projection without documents.

### Supported I/O boundary

The Curator uses curate read and write through the CLI. These commands call
readCurationInput and writeCurationDraft, also available
as an optional programmatic API. Reads verify UTF-8 and the manifest;
the writer serializes JSON with 2-space indentation and a final LF, inserts/verifies
proposalSha256 and returns the actual hash and bytes. Unicode, BOM and value
terminators stay intact. The model does not implement persistence or hashing.

Alternative writers to the canonical artifacts and transcriptions by the main
session are not supported. Draft files and stdin are CLI inputs, not distinct
writers. Files are first written to exclusive temporaries, synchronized and re-read
to compare the bytes; an atomic link publishes without overwrite on filesystems that
support it. The review precedes the proposal: a crash before the proposal commit
does not make an incomplete pair validatable. Write errors abort the
operation; orphan temporaries are not valid artifacts. The writer publishes only
artifacts exclusive to the pending run; validate/apply keep the existing lock.
This operation consumes no authorizations
and does not change the confirmed memory. If the CLI, the JavaScript build or the
required filesystem primitives are unavailable, stop with no fallback.

The core uses the same Node artifact-io kernel for UTF-8 reads and memory writes;
JSONL reads and incremental hashes preserve the original bytes.
The CLI carries values as ASCII-safe JSON, separately from the serialization
of the artifacts: escapes do not change values after parsing, hashes or files.
No Unicode normalization, newline conversion or retroactive rewriting.
Operational instructions are in the Curator skill, without changing its
semantic task or that of the main session.

### Autonomous Curator report

review.json is a run artifact, not a second memory or a task registry:

```json
{
  "version": 4,
  "proposalSha256": "SHA-256 of the bytes of proposal.json",
  "summary": "Changes and reason, or reason for the noop",
  "sources": [25, 27],
  "ignored": [26],
  "changes": [
    {
      "path": "STATE.md",
      "summary": "Operational change, closed or removed items",
      "sources": [25, 27]
    }
  ],
  "uncertainties": [],
  "anomalies": []
}
```

changes contains exactly STATE and the proposed notes; noop requires an empty changes.
The STATE entry also declares closed or removed decisions, blockers or prerequisites.
sources (events used) and ignored (events deliberately discarded) are disjoint and
together cover exactly the sequences of the batch in packet.json: a forgotten event is rejected with
CURATOR_REVIEW_INVALID. On noop sources can be empty and everything is in ignored.
The sequences in changes can also cite earlier relevant sources, not future events.

Only version 4 (with `ignored`) is accepted; earlier versions and the `critical`
list are not supported. There is no line-by-line critical map: the model chose it
itself, so an omission stayed invisible, and a lost entry remains recoverable from
HISTORY and the immutable revisions.
The canonical writer produces only version 4.

Validate verifies shape, document correspondence, citations and input hashes.
The seal also binds the report hash; apply rechecks the inputs and rejects
alterations. An already authorized recovery requires no new report, review or
session. These checks do not prove actual reading, semantic completeness or
truthfulness of the report.

## Integrity and recovery

A cross-process lock serializes every operation. The v3 checkpoint, tree hash,
feed chain, frozen run and seal prevent the application of stale or altered
proposals in the supported cases. Workspaces in any other format are rejected.

Before touching the confirmed files, `apply` atomically publishes `apply.json`, with
the authorized seal, previous and next trees, checkpoint and record checksum.
Each changed file is replaced with an atomic rename from a temporary
outside `memory/`; HISTORY keeps the exact prefix. The checkpoint advances
only after the verification of the whole tree, then the pending is removed.

The curator operations and the navigator reads on `work/memory/` share
the lock and recover the promotion before using the memory. With the previous
checkpoint, each file must match the previous or next version;
only the missing replacements are completed. With the next checkpoint,
the tree must already match entirely. Cleanup is repeatable; the record
stays as a receipt for replay until the next apply. No new
proposal or LLM invocations are needed. A HISTORY suffix is never re-added during
recovery. An interruption before publication leaves the previous state.

An incomplete/corrupt record, unexpected files or an incompatible checkpoint stop
the operation with no arbitrary repairs.
V2.3b synchronizes journal contents and namespace before the Markdown files, then
the whole tree before the checkpoint; it keeps the journal after the pending cleanup.
Recovery can rebuild missing Markdown names and checkpoint from the intact record.
The guarantees include process crashes and the conditional NTFS model described
in [Storage Durability](STORAGE-DURABILITY.md); physical durability after power loss
remains unproven. External writers and readers that ignore the lock are excluded.
The conservative lock policy remains:
a reused PID or an abandoned recovery gate may require inspection.
The verification reads the feed and memory in full; HISTORY is not sent to the model.

## Portable Curation CLI interface

The CLI reuses curation-io and the same runtime completion; the module remains
an optional programmatic access. Node is needed for KnowNex, not a Node REPL or Codex.
<CLI> indicates the installed CLI (`npm exec --offline -- knownex`).
For curation with review use curate prepare --autonomous --work DIRECTORY:
preparation runs no inference. RUN below is the path of the directory.

### Verified read

    <CLI> curate read --run RUN --input packet.json
    <CLI> curate read --run RUN --input base/STATE.md
    <CLI> curate read --run RUN --input packet.json --offset BYTE --limit N --sha256 HASH

The JSON contains path, bytes, sha256, text, runId, input, offset, nextOffset and
complete. bytes and sha256 describe the whole UTF-8 document. Without a range
the text is complete, with no hidden limits. Offsets are bytes: start included,
end excluded. nextOffset declares the next byte; complete=true indicates the end.
The limit may be reduced so as not to split a UTF-8 character. Invalid offsets
or limits too small for one character fail, without skipping data.

A non-initial offset requires the sha256 of the whole document already acquired.
Each page rechecks authorization and hash, with no caching. Join the decoded text
fields and verify the final bytes and SHA-256. The ASCII-safe JSON preserves Unicode,
BOM and CRLF in the text. If the tool truncates the JSON, it is not a complete read:
retrieve verifiable ranges. The constraints on the authorized inputs
and on the Knowledge context remain. The live feed is provenance only, not an input.

### Evidence and delivery

    <run>/draft/proposal.json      action, history, categories (no state/knowledge)
    <run>/draft/STATE.md           complete text of the new STATE (update only)
    <run>/draft/knowledge/<n>.md   new notes (update only)
    <run>/draft/review.json        review (version 4)
    <CLI> curate write --run RUN

The Curator writes plain files with its own file-writing tool: no
JSON containing Markdown, no serializer or pipe. write reads the draft as strict
UTF-8 (initial BOM ignored), assembles proposal with state and knowledge from the
Markdown files, adds the identity to notes without frontmatter, reduces feed links
to a label and binds the review to the proposal with proposalSha256. A missing
draft, invalid JSON or invalid UTF-8 give no receipts.

Before persisting, write applies to the canonical bytes the same checks as validate
(schema, review, Knowledge identity, provenance, links), without a candidate
or validated.json. An error persists nothing and returns to the Curator, who fixes
the draft and reruns write. As long as the run controller is prepared (or absent) a
successful write replaces the previous one, removing the proposal first; after
complete starts, write is rejected with CURATOR_CHECKPOINT_RETRY_FORBIDDEN.
The Curator can work in parallel with the main session: write and the transition of
complete to finishing take the same lock `<run>/delivery.lock`, so complete freezes
a whole delivery or stops with DESTINATION_BUSY without consuming the run.

The canonical writer inserts/verifies proposalSha256, synchronizes and publishes
review and proposal, with the proposal as commit point. It returns exactly
{proposal: receipt, review: receipt}; each receipt has path, bytes and sha256 of the
persisted canonical bytes and reports the delivery outcome to the caller. It does
not publish the memory. `curate write` (API `writeCurationDraft`) validates the
draft before delivering it.

### Independent completion

    <CLI> curate complete --run RUN

Complete reads proposal and review from the run and verifies active run, manifest,
review and seal, reusing existing validate/apply and recovery. It does not require a
pre-existing native controller, Curator identity, provider, leader or LLM session.
Appends beyond the cutoff stay excluded. Recovery/replay of the sealed journal does
not relaunch agents.
The compact results are SUCCESS, BLOCKED or ERROR; only SUCCESS confirms.
Publication and link rebasing remain the Core's responsibility.

CLI errors: non-zero exit code and JSON status=error/code on stderr. The negative
outcomes of complete have a non-zero exit code and a compact result on stdout.
Relevant codes: CURATOR_IO_INPUT_NOT_AUTHORIZED, CURATOR_INPUTS_CHANGED,
CURATOR_IO_RANGE_INVALID, CURATOR_IO_PAYLOAD_INVALID, CURATOR_IO_UNSAFE_RUN and
KNOWNEX_UTF8_INVALID. No error triggers fallback or inference.
