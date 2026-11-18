# R2 — Codex intermediates

The `src/feed/commentary.ts` adapter reads a verified snapshot through the S1 reader
during Stop, without modifying the source or keeping another cursor.
It selects only `response_item` with `payload.type = message`, role
`assistant`, phase `commentary` and textual `output_text` parts. The text joins
the parts in their original order with no added separators. It does not interpret reasoning,
tools, `event_msg/agent_message`, `item_completed` or final replies of the transcript.
The selection is limited to the turn declared by the Stop payload.

## Identity and provenance

The session must match `session_meta.payload.session_id`/`id`.
With retained metadata, `complete: true`, role assistant and `turn_id` are required;
`message_id` and `payload.id`, when both are present, must match.
Without retained metadata, only files explicitly marked
`history_mode: legacy`, a preceding `turn_context.turn_id` and messages with ID
and `completed` status are accepted. Compaction, end of turn and a new session_meta reset
the contextual association, even at the start of a new turn. Other cases stay excluded with a diagnostic;
IDs or turn membership are not invented. A file without session identity
or with a different session is rejected.

The feed adds `assistant_commentary`, `messageId` and `source`: transcript
path, filesystem identity, hash of the complete snapshot, byte offset/length
and SHA-256 of the original line without LF, type of turn association,
ordinal and retained revision when available. The original text stays in the
feed; these references allow comparison with the source or the raw records of the
S1 backup. They do not promise that the source path will keep the same
representation forever after a rewrite.

The writer and the lock remain those of the S2.1 feed. The identity of intermediates
is type/session/turn/messageId. An identical replay does not write; diverging text
for that identity causes FEED_CONFLICT without replacing the message. Different
identities stay distinct even with equal text. A legacy/paginated rewrite
is not deduplicated by text, timestamp or position. If the IDs change, the
messages stay distinct: no semantic correspondence is proven.

## Pending window

The physical sequence is always the order of capture. `prepare` keeps the physical cutoff
and R1 checkpoint, but presents each contiguous group of the same turn
as user, intermediates, final. Intermediates from the same snapshot follow the original
offsets. Between different snapshots it keeps the capture order and
reports COMMENTARY_ORDER_AMBIGUOUS; it does not compare ordinals of different
representations. Interleaved turns produce TURN_ORDER_AMBIGUOUS without moving whole
turns. Events arriving after the partial materialization of the turn produce
TURN_PARTIALLY_MATERIALIZED: confirmed events are not presented again and
past memory is not rewritten.

`packet.json` and `WINDOW.md` are regenerable projections of the feed. The E
labels stay the physical sequences, even when the presentation reorders them.
STATE, HISTORY and the R1 Memory Contract stay unchanged. The invocation of the Curator
stays under the control of the main session.

## Limits and checks

One selective scan per Stop; the full read is O(transcript size),
the existing writer verifies the feed at every append. No watcher or polling.
Timeout and concurrency stay those of the hook: errors are observable and
require a replay, with no promise of automatic eventual recovery.
Capture of the final stays independent of errors in the intermediates. An incomplete JSONL tail produces no events; replaying the same
Stop after completion allows recovering it, without inventing text.

The fixtures cover two intermediates with equal text and distinct IDs, exact Unicode text,
byte-level provenance, exclusion of technical records, replay, conflicts,
missing identities, legacy/paginated replacement, pending order and R1 checkpoint.
Presence in the JSONL alone does not prove visibility in the VS Code interface.

## Observed behavior

In real sessions the Stop replay adds no events and leaves the feed
byte-for-byte identical; reasoning and tool calls stay out of the feed. A
replacement of the transcript from legacy to paginated keeps message IDs and turns:
the replay on the new representation adds no events. A UserPromptSubmit
re-emitted with the same turn and different content produces FEED_CONFLICT and preserves
the previous message: further inputs with the same identity are not captured.
