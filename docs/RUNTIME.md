# KnowNex runtime

## Ordinary command and inputs

The checkpoint is the `knownex checkpoint` command ([details](CURATION-WORKFLOW.md#knownex-checkpoint-command)). `prepare --work .knownex/internal/curator` receives STATE
and events without requiring a directive or creating `.knownex/directive.md`.
Additional guidance is optional and does not replace the sources.

## Integrity of captured events

The JSONL feed of the hooks is the authoritative source. Runtime, pending and
checkpoint use only the recorded events and the local memory, without querying the
provider history.

Prepare freezes the batch after the confirmed cutoff. Complete verifies the feed,
the cutoff checksums, frozen inputs, receipts, proposal and
review before the apply under the existing lock. An append after the cutoff
stays for the next batch; corruption, truncation or modification of the necessary
prefix do not authorize a publication. The trigger is the explicit prepare command, not a permission in the feed.

The exclusions already recorded in the checkpoints/runs stay frozen decisions:
they are not removed, rebuilt or widened by consulting Codex. The pending cursors
keep verifying feed, cutoff, selection and pagination.

Retroactive edits or deletions of the conversation not captured by the
hooks are not detected automatically. The memory keeps the recorded events,
not a certified replica of the Codex history. The SHA-256 chain verifies
internal consistency, not completeness, independent authenticity or resistance to
whoever controls both feed and workspace metadata. No retroactive reconstruction.

Recovery completes only already authorized applies. The hooks keep capturing
deterministically with no LLM; only explicit invocation authorizes
materialization. The checkpoint does not require a Codex executable in the PATH.

## Lifecycle

| Event                               | Deterministic effect                                                    | LLM  |
| ----------------------------------- | ----------------------------------------------------------------------- | ---- |
| SessionStart, except source=compact | Verifies memory, authorized recovery, pending count and selective STATE | None |
| UserPromptSubmit                    | Captures the prompt in the project feed; no STATE re-injection          | None |
| Stop                                | Verifiable commentary and deduplicated final; returns `{}` on success   | None |

SessionStart emits the confirmed STATE in full in additionalContext,
at startup, resume and clear, with no omissions or size truncations by KnowNex;
with source=compact it emits nothing (the summary already contains the context). The prefix declares the UTF-8 bytes emitted and distinguishes emission from
delivery to the model. It does not load HISTORY or Knowledge; the pending stays selective.
Size does not constrain prepare, validate, apply, noop or reads.
Integrity errors produce an explicit warning, never a mixed confirmed state.

### Harness boundary

The [official hooks documentation](https://learn.chatgpt.com/docs/hooks#large-hook-output),
consulted on 2026-11-06, describes an approximate default threshold of 2500
tokens for each output message visible to the model. Beyond the threshold Codex can
save the full text in a temporary file and show a preview with the
path; if the write fails only the truncated preview may remain.
This handling, called spilling, is not the previous KnowNex limit of 6144 bytes.

For compatible versions, additionalContextLimit on the command handler configures
the behavior: 0 requests the complete context directly, without size spilling
of the additionalContext. Knownex init sets this value only
on its own SessionStart, in the project's local configuration. It does not change
global configurations or the limit of other hooks. An update managed through
init preserves user changes according to the existing conflict checks;
workspaces not updated may keep the Codex default.

There is no proof of delivery to the model here: timeout, hook approval,
version support and the model's actual window remain external limits.
A very large context occupies the available window; setting 0 does not make it
unlimited. The documentation advises caution for this reason. If Codex
reports spilling, an error or incomplete context, do not claim full continuity.

The distributed wrapper `.codex/hooks/session.cjs` uses asynchronous spawn and
consumes stdout incrementally in bytes, with no maxBuffer or other size threshold.
It keeps the payload until close with exit 0, validates UTF-8, JSON and SessionStart shape,
then emits the same bytes. It forwards neither stderr nor prefixes from failed processes.
Child timeout: 7.5 seconds, followed by termination and the SESSION_TIMEOUT diagnosis;
process/stream errors or invalid payloads produce distinct diagnoses.
An early close of the child's stdout is not enough: a successful exit and a
complete valid payload are required. If the channel to Codex is interrupted, the wrapper terminates
with an error without appending a diagnosis to a payload already started.
Collection and validation require memory proportional to the output; Node
Buffer/string/heap limits, OS memory, timeouts and channel problems remain
technical constraints, not STATE thresholds. An OOM stop is not always catchable.
The wrapper imposes no internal limit of 64 KiB.
The fixtures verify intact JSON stdout, bytes and configuration, with no LLM.

The [official hooks documentation](https://learn.chatgpt.com/docs/hooks),
consulted on 2026-11-04, supports PreCompact and PostCompact; their outputs
do not provide the context injection of SessionStart. SessionStart with
`source=compact` runs before the model continues, also
after automatic compaction. This event is reused: no additional hook,
no blocking of the compaction, no guarantee of LLM delegation at PreCompact.

## Pending without checkpoint

The packet makes readable only a window already prepared. `knownex pending` instead
reads the events after the cutoff without creating a batch: it reuses the same feed, lock,
frame validation and checkpoint, with no staging or second copy of the feed.

STATE is authoritative up to the last confirmed checkpoint; later events can
change decisions, results, blockers and activities. SessionStart declares this and
does not load the pending automatically. When the task requires continuity:

```powershell
npm exec --offline -- knownex pending --limit 5
npm exec --offline -- knownex pending --from 12 --through 18
npm exec --offline -- knownex pending --cursor TOKEN
# For a local copy: add --workspace PATH.
```

The default starts after the cutoff, freezing the end of the current window.
The cursors bind feed, checkpoint, end and prefix checksum: new appends
do not shift the pages; a changed checkpoint or a different prefix makes the
cursor stale. Ranges and limits are validated; limit default 5, maximum 20.
Every JSON response, newline included, stays within 16384 UTF-8 bytes. Long events
are fragmented: textOffset uses declared UTF-16 units and does not split surrogate
pairs; recompose text in the same order of sequence/textOffset. No
normalization. complete indicates the end of the window, textComplete the end of the event;
pendingComplete requires coverage up to the current feed with no incomplete tail.
These flags do not prove that the agent read or understood the previous pages.
newerEvents and incompleteTailBytes signal other context not covered.

The order returned is that of the physical sequence of the feed; session, turn,
timestamp, message identity and source metadata stay available. Each fragment
carries the checksum and byte range of the original frame in the file indicated, resolvable
in .knownex/internal/feed/. The long transcript path is not duplicated in the output:
sourcePathOmitted declares it; the full provenance stays in the original frame.
The backend scans the relevant Markdown/feed with the existing helpers; it does not
introduce an index and does not promise I/O proportional to the page alone.

The read does not initialize the curator, does not consume a grant and does not change feed, memory,
checkpoint, authorization or batch; it uses only transient locks. If it finds an apply to
recover, it returns CURATOR_RECOVERY_REQUIRED without running recovery. Corrupt
journals block the read. The existing runtime/navigator can complete an
already authorized apply: that is a separate storage phase, not reconciliation.
The read resumes only with a consistent memory.

The main session uses STATE and the relevant pages to update only its own temporary
context. It distinguishes authoritative directives, statements, hypotheses and
verifications; it keeps critical items until relevant justifications exist.
With STATE not delivered in full or the pending examined only in part, it declares the limit.
It does not create WORKING.md and does not require Yes/No to read. A future
permanent materialization requires the user to start `knownex checkpoint`.

The synthetic fixtures verify availability of completion/supersession from A
in B, recovery after No, STATE limits and Unicode pages, appends during reading,
stale cursor and reads with no changes to the confirmed files or to the authorization.
The checks verify bytes, provenance, order and lifecycle, not the model's semantic
understanding; that remains to be validated in the real simulation.

## Milestones and safeguards

The main session semantically recognizes decisions/supersessions, verified
progress, change of focus, handoff and significant imminent compaction.
It follows the `knownex checkpoint` command: suggestion, user start,
prepare, ephemeral provider session, the Curator's `curate write` and complete;
validate and apply with the seal remain the manual path. The editorial workflow and the
checks remain unchanged. No checkpoint per turn or per elapsed time.

The deterministic safeguards are feed/checksum and session/turn identity,
checkpoint, frozen cutoff, single pending and the curator lock. An empty seed
is initialized at sequence zero without inventing events. The messages of the current turn not yet captured
stay for a future batch. A session abandoned with no final keeps the
prompts: the next batch can include them without treating them as verified results.

If the curator is missing or the proposal fails, the batch and the events remain.
An already active batch triggers no further automatic delegations. The command
re-proposes the task to the provider at most once in the same run
([details](CURATION-WORKFLOW.md#knownex-checkpoint-command)); no other LLM retry.
The recovery of an already authorized apply remains deterministic and idempotent.
A failure before authorization requires an explicit resolution of the
batch; it is not deleted or replaced automatically to force progress.
Stop requires no continuations, creates no checkpoint and generates no recursion.

## Continuity and compatibility

Workspaces use only `.knownex/internal/feed/project.jsonl`: one frame
format, one global sequence and native identities per session. Per-session feed
files are not supported.

AGENTS.md keeps text outside `knownex:start/end` and updates only that
block; ambiguous markers are rejected. Other conflicts stay explicit.

## Offline evidence

`tests/bootstrap.test.ts` copies the compiled payload into an external temporary
workspace, or installs the npm archive with `KNOWNEX_INSTALL_ARCHIVE`, and denies the
runtime processes access to the sources. It verifies hook, skill, policy, pending
across sessions, repeated Stop, invalid proposal, apply and recovery, replay with no
duplicate HISTORY, idempotent bootstrap and rejection of altered memory, with synthetic payloads and
no LLM. Hook approval, delivery of STATE to the model, recognition
of milestones and the semantic behavior of the agent require a real
session. Physical durability remains subject to the limits in
[Storage](STORAGE-DURABILITY.md).

## Coordination without re-reading STATE

`knownex runtime --summary` runs the same runtime checks and returns
metadata, pending and authorization without the state field. The ordinary path
and SessionStart remain unchanged: this option serves the coordination of the
[autonomous curation](CURATION-WORKFLOW.md), it does not change the cold start.
