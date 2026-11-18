# KnowNex rc.11 — verified recap

This release integrates existing features without a new memory model,
MCP or runtime dependencies. The matrix refers to the shipped code; tests use
synthetic content and do not prove the semantic fidelity of a model.

| Component            | Actual implementation                                                                                                                                                     | Deterministic check                                                                                 | Real limit                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Capture              | UserPromptSubmit/Stop hooks: prompt, verifiable commentary and finals into the project feed via `hooks/feed-hook.ts`/`feed/feed.ts`                                       | Unicode bytes, order, replay, incomplete tail, checksum and lock                                    | Execution and approval of the hooks depend on the provider                                                                       |
| Curation             | `curation/curator.ts`, `checkpoint/checkpoint-launcher.ts` and the curator skill: frozen batch, ephemeral provider session, draft, `curate write` and complete            | Explicit preparation, staging, linkage, provenance, at most one re-proposal                         | Choice of milestones, selection and semantic completeness require real sessions                                                  |
| Authorization        | Only the user-started `knownex checkpoint` command starts an ordinary batch; an old handoff does not authorize new operations                                             | Textual/IDE/native invocations, consumption, failures, withdrawal and resume                        | Structural validation does not prove semantic completeness                                                                       |
| Cold start           | `memory/runtime.ts`/`hooks/session-hook.ts` emit the whole confirmed STATE; bootstrap configures SessionStart with `additionalContextLimit: 0`; no emission after compact | Seed, STATE of any size, pending between sessions, compact                                          | Wrapper without size cap; validation before emission, O(payload) memory, child timeout 7.5 s. Delivery to the model not verified |
| Memory               | Operational, linked STATE, detailed Knowledge, HISTORY as an index with `history/H…md` windows                                                                            | Links/anchors, identity, provenance and structural continuity                                       | No lexical check proves completeness of the knowledge                                                                            |
| Revisions            | `curation/knowledge-revisions.ts`: immutable full snapshots, receipts and predecessors; HEAD per note, no flat copy                                                       | Noop, chains, hashes, corrections, collisions and historical references                             | Protocol immutability, not an ACL against external writers                                                                       |
| Physical archive     | `memory/knowledge/H000NNN/[category]/<name>--kn-ID--REV.md` (id of the HISTORY entry of the checkpoint that wrote the note)                                               | Nested paths, rebased links, journal and symlink/junction                                           | Confirmed archives are never moved                                                                                               |
| Navigation           | `memory/navigator.ts` and CLI: state/find/read/history, sections, precise revisions and checkpoints; current find is lexical AND                                          | Reproducible ranking, limited output, multiple notes/checkpoints, no implicit traversal             | Full read can be extended; search does not evaluate semantic validity or synonyms                                                |
| Taxonomy             | `curation/taxonomy.ts`, `cli/taxonomy-cli.ts`, explicit skill: minimal registry and associations to exact revisions                                                       | Proposal/noop, user change, seal, session, stale, replay and recovery                               | The main session interprets free consent; CLI verifies events and association, not meaning                                       |
| Thematic exploration | `memory category`, chronological pagination and rebuildable `topics/*.md`                                                                                                 | Revisions across several checkpoints, relative links, rebuild without rewriting historical Markdown | Only already versioned revisions; views to be rebuilt after ordinary checkpoints when needed                                     |
| Integrity            | Lock and `apply.json`: v2 revisions, v3 organization; recovery without a new session                                                                                      | Crash/EIO and declared persistence model, idempotent replay, block on corruption                    | Physical durability not proven; NTFS/flush assumptions in the storage contract                                                   |
| Installation         | `cli/bootstrap.ts`, npm tgz and three skills; local hooks, hash manifest                                                                                                  | Isolated installation, conflicts, idempotence and data preservation                                 | Conflicting custom configs require explicit comparison; no global update                                                         |

## Contracts and compatibility

- [Memory](MEMORY-CONTRACT.md), [Curator](CURATOR.md), [revisions](KNOWLEDGE-REVISIONS.md).
- [Navigator](NAVIGATOR.md), [taxonomy](TAXONOMY.md), [runtime](RUNTIME.md).
- [Checkpoint and authorization](CURATION-WORKFLOW.md), [durability](STORAGE-DURABILITY.md).

Update the package and rerun init; open a new chat to load the current
instructions. Data is not migrated/moved. Only the current layout is
supported; standalone copies of the memory alone
do not include the versioned history. A moved workspace may keep absolute paths
in its checkpoints: the package does not depend on the original repository,
but does not offer a general migration of data between directories.

Taxonomy keys stay stable: explicit additions/reassignments replace
automatic renames or merges. The taxonomy does not alter historical facts and does not advance
the conversational cutoff.

## Checking the current version

`npm run check` runs the native suite, typecheck, formatting and build.
Installation and reinstallation from the tgz are verified with the procedure in
[INSTALL](INSTALL.md#checks-and-limits), which also lists the open limits. Historical
evidence and evaluation harnesses stay outside the package. Offline tests
do not prove semantic completeness, economic benefits or physical durability.
