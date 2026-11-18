# Conversation feed

The feed is the authoritative source for materialization: only recorded events
are processed. The checkpoint does not query the provider history;
retroactive changes not captured by the hooks stay undetected. The hashes
ensure internal consistency, not completeness or independent authenticity against a
process that controls the workspace. Historical exclusions stay preserved.

## Format

The feed keeps `user_message`, `assistant_commentary` and `assistant_final`.
User and final come from the hook payloads; only the textual intermediates
are selected from the transcript during Stop
([criteria](INTERMEDIATE-MESSAGES.md)). The writer `appendFeedEvent(directory,
input)` in `src/feed/feed.ts` does not import provider formats: it receives `type`,
`sessionId`, `turnId`, `text` and `hook`, and adds `sequence` (from 1) and
`capturedAt` (UTC ISO). `hook` is the provenance supplied by the caller, not an
event identifier.

The writer always writes `project.jsonl` in the feed folder
(`.knownex/internal/feed/`), excluded from Git and
shared between sessions. Per-session feed files are not supported.
Identities always keep the original session.

Every complete LF line is a frame `{ block, checksum }`, with block
`{ version: 1, previous, event }`. `checksum` is the SHA-256 of `JSON.stringify(block)`;
`previous` is the checksum of the previous frame, or `null`. The sequence
represents the observed commit order, not a chronology inferred by the model.
The text stays unchanged, including spaces, lines, Unicode and empty strings.

## Identity and recovery

The identity is the type/session/turn triple; for intermediates `messageId`
is added. Repeating the same identity with identical text is a no-op; different
text causes `FEED_CONFLICT`, without altering the registry. The same text in
different turns stays made of distinct events.

Reopening verifies checksums, chain, sequences and uniqueness of identities.
A corrupt complete frame causes `FEED_CORRUPT` and is preserved. An incomplete
tail is discarded only after validating the confirmed frames and the incoming
event; a replay of an already complete commit does not duplicate it. The writer requests
`FileHandle.sync()`, without proving physical durability against power loss.
The check rereads the registry in memory at every event; there is no
persistent index or separate state file.

## Lock

The writer uses `acquireJournalLock()`, the same lock as the Curator. The owner
(PID, token, diagnostic `acquiredAt`) is written to a private candidate and
published with an atomic hard link. A concurrent live process causes
`DESTINATION_BUSY` after a bounded wait (retry every 25 ms, up to 6 s, within the
hook's 7.5 s budget); the error is observable and the event is not
rebuilt. The lock of a dead PID is recovered with an exclusive gate tied to
its token; a gate left over after a crash during recovery, or a malformed
lock (`LOCK_CORRUPT`), requires manual inspection. Reused PIDs are
treated as busy. The filesystem must support atomic hard links; do not
access the same registry through hard link or symlink aliases.

## Hook adapter

The `feed.cjs` script passes the payload via stdin to `dist/hooks/feed-hook.js` in the
installed package (`src/hooks/feed-hook.ts` in the development fallback). The adapter extracts the
original field (`prompt` or `last_assistant_message`) and calls the writer. During
Stop it first tries to capture the commentary of the same turn: transcript
problems do not prevent keeping the final and are reported as codes in
`commentaryIssues`, with `commentaryMatched` and `commentaryAppended`, without text.
A missing field causes `MISSING_PROMPT` or `MISSING_ASSISTANT_MESSAGE`; missing or
invalid IDs prevent writing. Identifiers, replies or user
messages are not invented. Timeout, diagnostic logs and opt-out are described in
[AUTOMATIC-CAPTURE](AUTOMATIC-CAPTURE.md).

Collection started mid-conversation may lack the user message
matching a reply. Missing events, hooks not emitted, crashes and forced
terminations cannot be recovered from the feed. The `prompt` includes
the whole received field, including any IDE context added by the provider.

## Checks

The fixtures verify exact text, two turns and four events, different sessions
in the same feed, replay, conflicts, busy lock, corruption and simulated cuts
of a final frame, even inside a UTF-8 character. The adapter fixtures
invoke fresh processes and verify that a missing field does not invent content
or block the conversation.
