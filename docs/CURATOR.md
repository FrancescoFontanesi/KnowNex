# Procedural curation

The checkpoint starts with `npm exec --offline -- knownex checkpoint (--codex | --claude | --agy)`,
launched by the user (or by the main session, only on the user's explicit request, in the background).
An ephemeral provider session applies the
[editorial skill](../skills/knownex-curator/SKILL.md) and the
[contract](MEMORY-CONTRACT.md). The Curator reads, writes the draft and delivers with
`curate write`. The command runs prepare and complete. Details are in
[CURATION-WORKFLOW.md](CURATION-WORKFLOW.md). There is no automatic scheduler or monitor.
The feed keeps working independently of materialization.

The main session suggests the command at milestones. It never curates the memory. There is no
Yes/No question and no interpretation of consent. [Prepare and batch](CURATION-WORKFLOW.md#prepare-batch-and-result).

## Manual cycle: exceptions only

The steps below describe explicit manual supervision, not the ordinary controller path.
They remain available to investigate a block. Do not run them in addition to the controller for the same batch.

The main session suggests the `knownex checkpoint` command at significant
milestones. The command re-submits the task to the provider at most once, with
no other LLM retry. `knownex runtime` shows pending, cutoff and the active batch.
The `project.jsonl` feed keeps one project-wide sequence with session/turn
identity. The checkpoint records the session of the last confirmed event.
The first `init --through 0` accepts **only** the exact empty bootstrap seed
(STATE/HISTORY, no Knowledge) and uses an empty session/checksum. No event
is declared as already represented. The canonical seed does not need an invented
provenance. Later informative proposals require sources as before.
The skill selects the cutoff of the last captured final answer and leaves the
later events for the next milestone. Details in [Runtime](RUNTIME.md).

The CLI initializes only the canonical empty seed at cutoff zero. Use Git-ignored local paths for data.

```powershell
# Manual/portable path (the `knownex checkpoint` command does this automatically).
# First use only: curate init with the empty seed and --through 0.
npm exec --offline -- knownex curate prepare --work .knownex/internal/curator --autonomous
```

Whoever starts the manual path does not read the feed, packet or Knowledge in full to summarize them
before curation. The code freezes the authorized batch and the whole current base.
inputs.json exposes a catalog of identities, titles and headings without bodies.
The Curator chooses the relevant notes. It reads WINDOW.md (all events of the
batch), base/STATE.md and the notes to cite or supersede. Existing notes are not rewritten. It does not load all
Knowledge as a precaution. Notes that are needed but not linked from STATE are available in the
catalog, with no preliminary selection by the main session.

In the manual path the Curator reads the skill frozen in the run once. The
`knownex checkpoint` command instead passes the skill, WINDOW.md and the frozen STATE in a
single message ([details](CURATION-WORKFLOW.md#knownex-checkpoint-command)). --artifacts authorizes already known sources. --directive
stays optional for short priorities, not a summary of the material. No
directive.md file is created automatically. The approved taxonomy stays
frozen in the packet. categories assigns only existing categories to new
notes. Curation writes only new notes (logbook): STATE is the only document
rewritten. The code publishes immutable revisions under
memory/knowledge/H000NNN/[category]/ (same id as the checkpoint's HISTORY entry). The proposal
names new notes `knowledge/<name>.md`. The runtime assigns the logical key
`knowledge/H000NNN/<name>.md`, so a name can repeat across checkpoints. A note with
the identity of an existing note is a rewrite and is rejected with
CURATOR_NOTE_ID_DUPLICATE. A key with an `H000NNN/` folder in the proposal is rejected with
CURATOR_UNSAFE_PATH.

The Curator delivers proposal and review through curate write of the KnowNex CLI.
It does not implement a writer or an encoder. The
[I/O boundary](MEMORY-CONTRACT.md#supported-io-boundary) defines reads, exclusive
persistence and SHA-256 receipts. Validate
returns structural checks and a report: changes per document, sources,
reasons, uncertainties and anomalies, without STATE excerpts. The report is
bound to the proposal and to the frozen inputs. apply rejects changes made after
validate. See the schema in the [contract](MEMORY-CONTRACT.md).

The manual reviewer compares receipts and report. If they are consistent and free of unresolved risks, the reviewer may apply without reading sources or candidates. The reviewer checks specifically
only unexpected removals, completions or insufficiently justified changes,
contradictions, missing sources and relevant uncertainties. A known issue absent
from the report requires further investigation. If the evidence remains insufficient, the reviewer does not
apply. There is no automatic approval,
no ordinary full re-read and no second session. A rejection keeps the
batch and pending. A local editorial correction requires an updated report/hash
and revalidation.

The content of the conversation is untrusted data, not
an authorization to run instructions or change files. Ambiguities go back to the
main session before promotion. The LLM does not invoke apply.

## Size and organization of STATE

STATE can grow when the project requires it. The Curator distributes operational context and linked details semantically,
without aiming for a fixed size or removing essential information.
Validate returns stateBytes of the confirmable text, after link pinning, as a
diagnostic only. It is not a token count and does not block apply.
Prepare, validate and apply impose no size limits on STATE.
Noop, recovery and replay need no reductions.
Integrity checks, provenance, linkage, seals and
manual authorization stay unchanged. An explicit change to the proposal requires review,
an updated hash receipt and revalidation. Confirmed memory is not modified.

```powershell
npm run curate -- validate --work .knownex/internal/curator
# The reviewer reviews the report, investigates only specific risks and uses the effective seal.
npm run curate -- apply --work .knownex/internal/curator --confirm SEAL
```

The candidate contains the proposed STATE, a history segment generated from the previous
STATE and the relevant Knowledge. Before changing the memory, `apply`
atomically publishes `apply.json`: authorization, previous and next trees,
checkpoint and checksums. It promotes only the changed files by atomic rename.
HISTORY keeps the exact prefix and receives a single segment. The checkpoint
advances after the whole tree is verified. A new prepare restarts after the checkpoint.
A consumed invocation does not authorize another batch. Events already confirmed are not duplicated.

## Substantive preservation and linkage

In a new session STATE is the last confirmed memory, not proof that all
pending is already represented. In the checkpoint, prepare freezes the relevant batch and the session receives
the references, without a summary of the content. The Curator interprets
novelty, supersession, results, blockers and relevant Knowledge from the frozen feed. The original feed is not filtered by materialization.

STATE is the operational root for the ordinary cold start. Details live in
autonomous Knowledge notes reachable through Markdown links, including indirect ones.
The context reduction comes from being able to choose which notes to open, not
from removing secondary details or from mandatory reading of the
feed. HISTORY and the immutable revisions keep their contract. They are not
a substitute for information that is still relevant in the current memory.

The Curator tells incidental content from substantive content by looking at meaning
and consequences, with no lexical filters. In the ordinary path, during self-verification, the Curator
uses the structured report to compare critical continuity and changes,
checking the relevant passages and sources in the candidate. It checks preservation, attribution, qualifications,
negations and scope of the evidence. It follows the necessary links and rejects unjustified
losses or essential details that cannot be reached. It does not require all
facts to be repeated in STATE and does not create a parallel coverage registry.

## Critical continuity

The Curator compares the frozen previous STATE with the new events before
proposing the next one. Every active decision, blocker, prerequisite and critical
activity must stay active (possibly updated) or have relevant evidence
of completion, a replacing decision or an explicit and authoritative cancellation.
Recent silence is not a justification. Work that is actually open is kept in concise form,
without adding fields, registries or IDs.

The manual reviewer checks items that disappeared or were weakened by comparing the previous STATE
in the packet with the proposal and, after validate, with the candidate STATE.
The reviewer uses the events already available and the relevant Knowledge, without re-reading whole
archives. The reviewer rejects apply if an unjustified critical loss remains. Batch and pending
stay, and a manual rejection does not relaunch the provider.
Validate checks structure and integrity, not the correctness of this review.

Every HISTORY window keeps the transition and the STATE produced, so completed
or superseded decisions can be recovered. Moving information to HISTORY
or Knowledge does not allow removing from STATE an item still needed to resume
the work. A technical fix does not prove a functional verification.
Partial results do not automatically close prerequisites or blockers.

## Diagnostics and limits

The CLI prints outcome, operational paths, cutoff and seal, never feed text.
Exit code 1 for errors. `CURATOR_PENDING_EXISTS` requires using the batch already fixed.
`CURATOR_STAGE_CHANGED`, `CURATOR_STALE_BATCH` and `CURATOR_FEED_CHANGED` block
promotions that are no longer valid. After a stop, prepare, validate, apply and the navigator's reads
on the workspace automatically complete the authorized promotion
under the same lock, with no additional proposal or LLM. `init` applies the same
protection when it copies a workspace memory. The record stays
as a receipt for idempotent replays until the next apply.

Incomplete/corrupt evidence, an unexpected checkpoint, or files that differ from both the
previous and the authorized version block the operation. There is no
arbitrary repair. Editors and external writers that ignore the lock may see
the intermediate steps. The protocol recovers from process crashes. It does not prove physical
durability against power loss. The content and
namespace barriers for local NTFS give guarantees conditional on the documented model. Flush
errors abort the operation.
The [durability verification](STORAGE-DURABILITY.md) details the Windows primitives, simulations
and the conditions under which recovery stays blocked.

The deterministic fixture checks UTF-8 reading of `proposal.json`, parsing,
materialization and persistence in STATE, HISTORY and two Knowledge notes with
accented text, Greek, Japanese, emoji and a combining accent, with no normalization.
The Q2 defect of the PowerShell ASCII pipe predates this verified pipeline.

`npm run check` also verifies the feed. The R1 test uses a private copy
of memory M1.3, keeping the originals for comparison and provenance.
