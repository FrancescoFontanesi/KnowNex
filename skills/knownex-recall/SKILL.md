---
name: knownex-recall
description: Retrieves from KnowNex memory (Knowledge, HISTORY, revisions, pending events) the minimum missing context needed to answer, with provenance. Use it when STATE and the context already available are not enough and a search is needed. A read-only subagent runs it, to which the main session delegates history, taxonomy and searches; the main session reads STATE and the linked notes itself. Do not use it for checkpoints, curation or memory changes.
---

# KnowNex Recall

Goal: retrieve the minimum context enough to answer correctly, with provenance, keeping the present apart from the past and without inventing.

## Who does what

- **Main session.** If STATE and the context are enough, answer without Recall. Read a note linked from STATE yourself with `memory read`: one read costs less than a delegation. Delegate history (HISTORY, windows, revisions, events), taxonomy and searches for unknown references to a subagent with its own context and this skill. Pass a precise question, the workspace, the references or cutoffs already known, not documents or the whole conversation. If the harness has no subagents, say so. No automatic fallback to direct searches or other roles.
- **Subagent.** The main session's delegation instructions do not apply to you: do the navigation described below, without delegating. Return the relevant information, the references, the provenance and the limits of the search, not whole documents or a log of the reads. Answer in the language of the request: memory may be written in another language. Do not change memory, feed or configuration and do not run checkpoints, curation or repairs. The read-only constraint is behavioral: the actual permissions are the harness's.

## Where to look

STATE is authoritative up to the last confirmed checkpoint, not necessarily up to now. Go step by step and stop as soon as you have the answer, its qualifications and its provenance:

1. STATE already in context: use it. If it is missing or truncated, retrieve it once.
2. Details: follow STATE's links to Knowledge. Notes are logbook entries never rewritten: the current truth is in the notes STATE links; a note that supersedes another links it, and the earlier ones show the evolution.
3. History: `memory history` for the timeline, then the specific window or revision.
4. Events after the cutoff: `pending`, only if relevant.

## Commands

From the workspace root, with `K` = `npm exec --offline -- knownex`:

| Need                                              | Command                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| STATE                                             | `K memory state`                                                                                 |
| Known reference (`kn-…`, path, revision)          | `K memory read "REF"` or `"REF#anchor"` for a section                                            |
| Unknown reference                                 | `K memory find "distinctive terms"` (all terms required; `--type knowledge` or `--type history`) |
| Checkpoint timeline, newest first                 | `K memory history` (`--last N`, `--before H000012`), without the window bodies                   |
| History window of a checkpoint                    | `K memory read "H000003"` (also `history/H000003.md`)                                            |
| Exact revision                                    | `K memory read "kn-…@REV"`                                                                       |
| Note at checkpoint N or at an archived STATE      | `K memory read "kn-…" --at N` or `--at H000003`                                                  |
| Revisions of a category                           | `K memory category KEY` (`--limit`, `--cursor`)                                                  |
| Event cited as `[E017]` (even if already curated) | `K memory event E017` or `E015..E016` (max 20 events; only in a workspace with a feed)           |
| Pending events                                    | `K pending`                                                                                      |

Memory is in `.knownex/memory`. For an external copy use `--memory PATH`. Relative links resolve from the source document; `memory read` does not open external artifacts.

- `find` returns up to five candidates: if an excerpt already holds the answer and the provenance, stop; otherwise open only the relevant reference. Do not use `find` if you already have the reference. Search terms work best in the language the memory is written in.
- Prefer `#anchor` when a section is enough. Do not re-read documents already retrieved in the turn.
- Category cursors expire after changes. `thematicCategories` is the current organization, `category` the original placement.
- For partial pending and paging see [RUNTIME.md](../../docs/RUNTIME.md), section "Pending without checkpoint".

For audits or explicitly exhaustive requests widen coverage in a verifiable way and state the limits.

## History and provenance

- Do not replace a historical revision with the current one. A `history/H…md` window holds the STATE produced by its checkpoint and the notes written. Checkpoints, revisions and HISTORY ids are separate numberings.
- Keep confirmed facts, experimental results, superseded decisions and uncertainties apart. A note not linked from STATE may be superseded by a newer one: do not present it as current without checking. Report references and events when relevant, without extra reads for decorative citations.
- If you do not find something, state the scope you searched: `not_found` does not prove absence. Do not infer events or provenance that do not appear in the results. If the history predates the baseline, say so.

## Integrity

- Read only through the CLI, without `Get-Content` or intermediate conversions. The output is ASCII-safe JSON: Unicode escapes are correct values after parsing.
- Do not repeat a truncated output identically: read a section or state that coverage is incomplete.
- A read can complete an apply already authorized and left pending; when you need a read-only guarantee use a standalone copy.
- On `CURATOR_RECOVERY_REQUIRED` or integrity errors stop, without repairs and without invoking the Curator.
