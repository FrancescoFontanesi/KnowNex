# Optional thematic maintenance

`$knownex-taxonomy` operates only on explicit invocation. It does not run a
checkpoint of the conversation and does not advance the cutoff. The ordinary curator uses
only approved categories; it does not create categories or reclassify unchanged notes.
There are no predefined categories, semantic thresholds or mandatory classification.

## Proposal and approval

```text
knownex taxonomy prepare --work .knownex/internal/curator
knownex taxonomy validate --work .knownex/internal/curator --run ID
knownex taxonomy apply --work .knownex/internal/curator --run ID --confirm SEAL --approval-event SEQUENCE
knownex taxonomy rebuild --work .knownex/internal/curator
```

Prepare requires a user invocation captured in the feed and creates only staging
in `taxonomy-runs/ID/`: packet, request identity, checkpoint and metadata
fingerprint. The packet contains a chronological catalog of the reachable
revisions, not all their contents. The existing curator selectively reads
the revisions needed and proposes recurring macro-themes, overlaps and candidates.
An analysis with no useful changes is valid; validate returns `noop`.

The UTF-8 `proposal.json` file contains patches, not full replacements:

```json
{
  "categories": { "methods": "Methods, evidence and limits" },
  "assignments": { "kn-UUID@REV": ["methods"] },
  "explanations": "Reasons, representative revisions/checkpoints and overlaps"
}
```

UUID and REV in the example are placeholders: real identities from the catalog are needed.
Absences preserve the previous data; `[]` makes a revision unclassified.
Validate returns the seal, taxonomy and effective associations. The main session
presents a readable proposal with reasons and references, ID and seal.
The user can reject, modify or add categories. After changes the proposal is
revalidated and the new seal is presented; the semantic analysis need not be repeated.

Apply verifies the invocation, the assistant's final with that run/seal and the first
later user response in the same session, actually captured and not
excluded from the active branch. A later response makes that consent stale.
**The main session interprets free-form assent; the CLI does not verify its meaning.**
A marker or a statement by the model does not replace the captured events;
they are not cryptographic proof of human understanding or viewing.
Ambiguous responses, refusal and silence require not calling apply.

A changed checkpoint or metadata invalidates the proposal. A new invocation
allows a new run; the analysis, if still relevant, can be reused.
A pending curator batch prevents a thematic apply. The instructions remain the
semantic boundary of the approval, as in the existing manual workflow.

## Canonical data and identity

`taxonomy.json` remains the minimal key → description map. Existing keys
are not deleted by omission. To rename/merge, a key is added
and explicit associations are approved, preserving the previous keys.
There is no physical deletion of keys, aliases or automatic merges.

`taxonomy-associations.json` keeps only retroactive classifications:

```json
{
  "version": 1,
  "assignments": { "kn-UUID@REV": ["methods"] },
  "receipt": { "id": "t-SHA256", "hash": "SHA256" }
}
```

The key identifies a precise revision, not a current logical ID nor a
feed event. An explicit association replaces the original classification derived
from the path; in its absence the original one applies.
It does not change bytes, hash, path, provenance or meaning of the revision.
The immutable receipts `taxonomy-changes/t-SHA256.json` record proposal,
seal, approval reference, before/after fingerprints and previous receipt.
The authenticated head detects alterations of the canonical data; it is not a signature against external
writers that can rewrite all the files. Workspaces without this metadata
and with only `taxonomy.json` stay valid without migration.

## Navigation and views

`knownex memory category KEY --memory .knownex/memory` returns
exact revisions in chronological order, with provenance, current state and
original/retroactive classification. Pages: default 5, maximum 20 results,
`--limit N --cursor CURSOR`; changes to the checkpoint or metadata invalidate
the cursor. It is not a limit on the number of categories. Legacy notes not yet
versioned stay readable but do not appear in the historical catalog.

Find keeps searching current notes, including effective categories in the metadata;
`category` in the results stays the original placement, `thematicCategories`
the current classification. A word of the old placement may still
match in find; use `memory category` for exact thematic selection.
Read does not alter contents and does not follow links automatically.

`topics/index.md` and `topics/category-KEY.md` are derived views for Markdown/Obsidian
readers: relative links to the original revisions, grouped by checkpoint
cutoff. They are not Knowledge nor a source of truth. Rebuild repairs them from the
already approved metadata with no new classification or delegation. The views can
become stale after ordinary checkpoints: rebuild them when needed.

## Transaction and limits

The maintenance reuses `curator.lock`, `apply.json` and the existing recovery.
The thematic v3 record contains only before/after metadata, with no copies of the memory.
Persistent order: intent → receipt → registry → views → associations/head.
The checkpoint stays identical. The replay verifies old/new canonical contents,
repairs derived views and completes the authorized operation with no new delegation.
A canonical collision blocks; an unauthorized proposal is not promoted.
Prepare/validate do not complete pending recoveries; the normal recovery gates
remain available. External readers that ignore the lock may observe
intermediate files; multi-file transactions are not promised for these readers.

The assumptions of [durability](STORAGE-DURABILITY.md) apply, not a physical
proof against power loss. The tests verify bytes, references, structural
authorizations, collisions and replay; not the semantic quality of the themes, completeness
of the analysis or correct interpretation of the assent by a model.
