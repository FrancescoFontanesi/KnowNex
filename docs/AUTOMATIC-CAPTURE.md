# Capture hooks

KnowNex captures the conversation only in the [project feed](NATIVE-FEED.md).
There is no longer a copy of the provider transcripts: the hooks neither read nor
save the session JSONL, except for the intermediate messages of the turn that
just ended ([criteria](INTERMEDIATE-MESSAGES.md)).

## Installed hooks

For each chosen provider, `knownex init` registers three events with local wrappers in
`.codex/hooks/` or `.claude/hooks/` that call the package scripts:

| Event              | Script        | Effect                                                 |
| ------------------ | ------------- | ------------------------------------------------------ |
| `SessionStart`     | `session.cjs` | emits STATE and pending (not after a compact)          |
| `UserPromptSubmit` | `feed.cjs`    | adds the `user_message`                                |
| `Stop`             | `feed.cjs`    | adds the turn's commentary, then the `assistant_final` |

The wrapper sets `KNOWNEX_WORKSPACE` and `KNOWNEX_PROVIDER` (`codex` or `claude`).
With Claude Code the turn is the `prompt_id`, the commentary comes from the
`assistant` records of the Claude transcript that do not close the turn, and
subagent turns (`agent_id`, `isSidechain`) are ignored. Every event carries
`provider`; events captured before providers existed do not have it.

With `KNOWNEX_CAPTURE=0` in the environment, set for the ephemeral sessions of the
Curator, every hook exits with code 0 without writing feed or log and without emitting STATE.

## Non-blocking errors

The script passes the payload to the child via stdin, never in arguments, and rejects it
above 16 MiB (`HOOK_PAYLOAD_TOO_LARGE`). The child has 7.5 seconds, under the declared
10-second timeout; the writer waits for a busy lock for up to 6 seconds.
The hook always ends with exit code 0: `{}` after success, otherwise
`{ "continue": true, "systemMessage": "...code..." }`. It does not block the conversation
and does not declare a failed capture successful: a lost event is not
rebuilt.

`.codex/hooks/feed-events.jsonl` (or `.claude/hooks/`) records only ID, event,
timestamp, counts, sequence, hash and text length, or the error code,
never the content. Hooks, workspace trust and approval must be authorized
personally in the provider; init does not modify global configuration.

## Previous installations

Earlier versions also registered a `stop.cjs` hook on `Stop` and
`SessionEnd`, which copied the transcript to `.knownex/captures/` or
`.knownex/internal/captures/`. That copy was never a source for the
checkpoint and has been removed:

- the package keeps `stop.cjs` for one release as an inert stub, so a
  `knownex-stop.cjs` wrapper that is still installed answers `{}` without errors;
- `knownex init` removes the wrapper and the `Stop`/`SessionEnd` entries that
  call it, if unmodified (otherwise `BOOTSTRAP_CONFLICT`); the user's other
  entries stay;
- files already present in `captures/` and `.codex/hooks/events.jsonl` are not
  read or deleted: they contain original conversations and can be removed by
  hand.
