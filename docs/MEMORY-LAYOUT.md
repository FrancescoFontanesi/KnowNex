# Public memory and internal infrastructure

The layout separates the consultable product from
the mechanisms that generate it. It is the only supported layout: the earlier
`.knownex/seed`, `.knownex/feed` and `.knownex/curator` layouts are not supported.

```text
.knownex/
  README.md
  memory/
    STATE.md
    HISTORY.md
    knowledge/
      H000009/                    # id of the checkpoint's HISTORY entry
        [category/]
          NAME--kn-UUID--REV.md
    taxonomy.json                 # optional
    taxonomy-associations.json    # optional
    topics/                       # rebuildable thematic views
  internal/
    install.json
    docs/
    feed/
    curator/
      checkpoint.json
      apply.json
      revisions/c-N.json          # receipts, not copies of the Knowledge
      runs/
      taxonomy-runs/
      taxonomy-changes/
```

## Exploration

Open `.knownex/README.md`, then `memory/STATE.md`. STATE links the relevant
revisions with descriptive labels. There is no need to know the Curator or use
the CLI. The `memory/` directory can be opened as a Markdown/Obsidian vault:
STATE, HISTORY and Knowledge have real relative links, with no intermediate
flat notes or symlinks. The Obsidian graphical interface is not verified by the tests.
References to feed and artifacts outside the vault require a reader that
allows access outside its root; they are not duplicated inside the memory.

A checkpoint folder contains only the Knowledge published in that
promotion. Notes are diary entries: a checkpoint adds new notes and does not
rewrite existing ones, which stay where they are. STATE links the notes,
even from different checkpoints, that contain the current truth; superseded ones
show the evolution. HISTORY keeps the previous STATE files and their immutable
links. The name of the `H000NNN` folder is the HISTORY ID of the checkpoint. It does not
attest the semantic validity of a decision. A noop advances the receipt without duplicating
notes, STATE or Knowledge folders.

Logical IDs, the revision format and their hashes do not change. The logical
keys are `knowledge/H000NNN/theme.md` (the runtime adds the
checkpoint folder to the proposal's `knowledge/theme.md` name); they act as CLI aliases and
are not a second physical copy. The navigator resolves the HEADs already
registered in the checkpoint and searches only current notes. ID, ID@REV, `--at`,
physical paths, sections and HISTORY lookup stay available. No new index.

## STATE, seed and staging

The bootstrap writes the empty initial STATE (`# Initial state`) directly to `memory/STATE.md`.
Before the first checkpoint, this is a template with no confirmed events:
SessionStart reports it as cutoff E0. No `seed/` is created and there is no
second active STATE. The initialization of the Curator at E0 uses the same file.
Notes only come from checkpoints: a memory that contains notes but no revision
state is rejected.

The STATE files and Knowledge under `internal/curator/runs/*/base` and `candidate-*`
are frozen inputs and unconfirmed candidates. The journal keeps previous and
next for recovery; they are not entry points to the memory and must not be opened to
rebuild the present. They are kept because they belong to the protocol and to the
validation evidence; they are not deleted by this reorganization.

## Storage and recovery

The logical contract of the Curator stays STATE/HISTORY and complete notes with
logical keys. In the new layout this view of the notes is rebuilt from the HEADs and
the contents of the revisions, verifying their hashes and links. It is not an additional
persistent snapshot. The memoryHash keeps the same logical definition.

The authorized journal precedes publications. Revisions and the names of their
directories are synchronized before the promotion of STATE/HISTORY and of the
checkpoint. Receipts stay internal. Flushes include the already existing HEADs;
replay uses previous/next and the journal's publication files, with no new
delegation or authorization. CLI reads of the canonical memory acquire the
lock of the same Curator and cannot bypass recovery or integrity checks.

An external Markdown reader does not acquire that lock: consult the files after
confirmation, not during apply/recovery. This property is not a multi-file
transaction offered by Obsidian. The physical durability limits documented
in [STORAGE-DURABILITY.md](STORAGE-DURABILITY.md) remain; the layout change does not widen them.

Consultable taxonomy and associations live in memory; their journals and
approval receipts stay internal. The topics views are rebuildable and do not
modify facts or revisions. They change neither the consent nor the semantics of curation.

## Checks

`tests/memory-layout.test.ts` verifies new, updated and unchanged notes,
optional classification, logical/physical/historical lookup, search of HEADs only,
noop, HISTORY, replay from a mixed state with a missing publication and blocking on
corruption. The link checks verify filesystem targets, not semantics.
`tests/bootstrap.test.ts` uses a payload compiled in an external temporary
directory, preventing the runtime from accessing the sources: hooks, manual authorization,
feed, SessionStart/compact, checkpoint, recovery and idempotent init.
