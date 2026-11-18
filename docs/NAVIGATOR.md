# Deterministic navigator

## Recall through a generic subagent

The main session reuses STATE and the current conversation. A reference it already
knows (a note or window linked from STATE, an `H…` ID) it reads directly with
`memory read`: one read costs less than a delegation. History (HISTORY, windows,
revisions, events), taxonomy and searches it delegates to a generic subagent of the
harness that follows the `knownex-recall` skill and the commands below; the subagent
returns relevant facts, references, provenance and limits, not the documents or the
log of the reads. There is no dedicated Recaller role. The main session waits with
no duplicate navigation.

The consultation-only constraints are behavioral, not separate read-only
permissions: the subagent inherits the main session's sandbox. The current
primitives can acquire internal locks and complete already authorized recoveries
during a read; there is no technical guarantee of no writes. If the Curator lock is
busy (another read or a short apply), the reads wait for it
for about 5 s before failing with `DESTINATION_BUSY`.

STATE remains the automatic handoff between new sessions, not a per-turn refresh.
After a compact (`source=compact`) the hook does not re-emit STATE: the summary
already contains it. Actual delivery remains harness-dependent.

## Consultation commands

```powershell
npm run build
npm start -- memory state --memory .knownex/memory
npm start -- memory find "identity ordering" --type knowledge --memory .knownex/memory
npm start -- memory history --last 10 --memory .knownex/memory
npm start -- memory read H000003 --memory .knownex/memory
npm start -- memory event E017 --memory .knownex/memory
npm start -- memory event E015..E016 --memory .knownex/memory
npm start -- memory read kn-NOTE-ID --memory .knownex/memory
npm start -- memory read "knowledge/storage.md#flush-locale" --memory .knownex/memory
# Copy an actual immutable reference from STATE or from read/find:
npm start -- memory read "knowledge/H000004/name--kn-UUID--REV.md#policy" --memory .knownex/memory
```

The `knownex` binary exposes the same arguments. `--memory` indicates the directory
of the project checkpoint; replace the IDs in the examples with those found
through `find`. Before the first checkpoint the available directory is the initial STATE in the same memory/.
Without the option, new installations always use .knownex/memory, also for the
initial STATE. In legacy workspaces the previous paths and the seed remain.
Outside a KnowNex workspace the standalone default `memory/` remains.
Standalone copies are read-only; in workspaces the gate can complete an already
authorized recovery. `memory --help` shows the syntax. The sync command remains
available with the previous contract.

- `state`: JSON `{status, content}` with the original STATE only. A standalone copy
  reads only STATE; in the workspace the gate also verifies the confirmed memory.
- `find "query"`: at most five results, with no automatic follow-up reads.
  Each result contains ID, type, title, excerpt, path and a reference
  relative to the memory. For HISTORY it adds the date and the event range;
  the title uses the topics of the segment. `--type history|knowledge` also
  restricts the files scanned. A query with no results returns
  `{"status":"not_found","results":[]}` with exit 0.
- `history [--last N] [--before H-ID]`: checkpoint chronology from the most recent (default 10,
  maximum 50), with ID, date, events, topics, description and reference, without the body
  of the windows. It serves to choose which windows to open without reading the whole HISTORY.
- `read <id|reference>`: full content of the window or history segment alone, or of the note alone,
  with resolvable references. It does not follow links. Unknown ID: error
  MEMORY_NOT_FOUND, exit 1. Malformed IDs and invalid arguments: exit 2.
  For notes, if current notes in strictly later checkpoint folders link them,
  it adds `linkedByNewer` (sorted list of `{id, title, reference, history|checkpoint}`);
  absent if there are none. The logbook does not rewrite old notes, so this is the only way
  to know that a note read may have been superseded: it says only "linked by a
  later one", it does not decide semantic validity; read the notes indicated. It applies to ID,
  logical alias and immutable reference (also `@REV`/`--at`). Order: legacy `checkpoint-NNNN`
  before every `H00000N`, then by number; same folder, STATE, HISTORY, self-links and
  legacy flat notes do not count. Read-only computation (no file, `memoryHash`
  unchanged), deterministic; cost: one verified read per current note in newer
  folders (zero for the last folder), with no index; it does not scan non-current revisions.

## From context to detail

SessionStart tries to include the complete STATE, cutoff and warnings about the pending,
even with large STATE, but not after compact. It imposes no internal size threshold.
KnowNex emission and actual delivery in the harness are distinct boundaries:
see the limits and configuration in the [runtime](RUNTIME.md).
Reuse
the STATE and recall instructions already present; do not run a cold start at every question.
If STATE is enough no calls are needed. With an identified document, read the
direct reference; use find when the document is missing or another topic is needed.

`read` accepts ID, the logical alias `knowledge/H000NNN/<name>.md` (or `knowledge/<name>.md`
for notes published before the per-checkpoint folders), `HISTORY.md#h000003`,
`history/H000003.md` and the physical path
`knowledge/H000NNN/[category]/name--kn-UUID--REV.md` (or the earlier form `knowledge/checkpoint-NNNN/...`). The `name--` prefix
serves those browsing the vault; earlier revisions without the prefix stay valid. The old
references `../revisions/...` stay supported. These are restricted forms resolved by the navigator,
not access to arbitrary paths. References are relative to the memory root:
a link inside a note must be resolved relative to the `path` of that note. The whole
`[label](destination)` syntax is not passed and feeds or artifacts are not opened with read.
No link is followed automatically; only the one needed is explored further.
For new revisions the canonical reference includes the checkpoint folder and any
category: `knowledge/H000004/experiments/kn-UUID--REV.md`. The earlier flat names
stay valid. A requested path must match the authenticated path of the
revision; another file with the same basename is not resolved.

An ATX `#anchor` fragment on a Knowledge note, even after `kn-ID@REV`, reads that
section and the subsections up to the next heading of equal or higher level.
The content keeps the UTF-8/CRLF bytes with no additional frontmatter;
ID, path and revision stay in the metadata of the original document.
`selection` declares anchor, fromLine, throughLine and totalLines of the document.
The SHA-256 of a revision still refers to the complete immutable file,
not to the excerpt. The text is not silently truncated; a section can still be
long. Global qualifications or those in other sections require other context.
Missing or ambiguous anchor: MEMORY_SECTION_NOT_FOUND or MEMORY_AMBIGUOUS_SECTION,
exit 1; a duplicate heading is not chosen arbitrarily.
Headings inside code fences are not sections. The ATX headings of the contract are
supported, not a general Markdown parser.

## Search and identity

In versioned workspaces, `find` and `read kn-...` stay current and also return
the revision and immutable reference. `read kn-...@REV` reads a precise version;
`read kn-... --at N` resolves a confirmed checkpoint, including noops.
`--at H000002` uses the cutoff preceding the segment (`from - 1`).
No fallback for missing versions or requests earlier than the baseline.
An immutable reference is not replaced with the latest revision. To read
the present use the logical ID or the current path. Checkpoint number, HISTORY
ID, feed E sequence and revision identifier have distinct roles;
`--at N` accepts only a confirmed checkpoint, not any event.
The archive does not take part in find: old revisions do not multiply the candidates.
Find does not classify semantic validity, supersession or independence of the results:
read the scope, qualifications and sources, also in the relevant historical revision.
Details and compatibility: [Versioned Knowledge](KNOWLEDGE-REVISIONS.md).

Search is AND over Unicode words, case- and accent-insensitive;
for current notes the new paths also provide category and checkpoint metadata.
Queries such as `experiments` or `H000004` find them without a secondary
index. In the results category and checkpoint describe placement and
provenance, not semantic validity. Historical revisions do not enter the current
search and stay readable with qualified IDs or historical references.
Duplicates in the query do not increase the score. It uses no synonyms or inference.
For each term, presence weighs 8 in the title, 5 in the metadata, 3 in the
headings and 1 in the body. Frequency does not count. Ties: type and ID in
locale-independent lexicographic order. Titles and excerpts are limited to 160 and
240 characters. The excerpt chooses the window with the most distinct query terms
(180 UTF-16 units for the matches, up to 60 characters of preceding context),
with ties going to the first passage. It does not change the ranking of the documents and is not a
semantic evaluation. If the passage belongs to a subsection with a unique anchor
and at most 160 UTF-16 units long, `section` shows its title/anchor
(title limited to 160 characters) and `reference` points directly there.
Distant occurrences can satisfy AND without all entering the excerpt.

HISTORY uses the delimiters, IDs and validation of `src/history.ts`; the reference
is, for example, `HISTORY.md#h000003`. Knowledge IDs come from the frontmatter
of the R1 contract and are resolved through the checkpoint HEADs to the revisions
in `knowledge/H000NNN/` (or legacy `checkpoint-NNNN`); the logical alias
`knowledge/H000NNN/topic.md` and the immutable reference indicate the same
revision. There is no persistent index.
Duplicate identities, invalid segments, invalid metadata and malformed UTF-8
cause explicit errors. Arbitrary paths, URLs, traversal and symlinks/junctions
along the paths read are rejected. References to revisions traverse
the verified checkpoint chain: they do not authorize orphan files in the archive.

## Thematic organization

The explicit maintenance [knownex-taxonomy](TAXONOMY.md) adds associations to
precise revisions without rewriting them. `memory category KEY --memory DIRECTORY`
returns revisions in chronological order, original or retroactive, with flags
`current`, `through` and immutable reference. `--limit` (default 5, maximum 20)
and `--cursor` allow stable pages; changes to metadata/checkpoint invalidate
the cursor. Historical coverage is limited to notes already versioned.
Find stays current: `thematicCategories` indicates effective categories,
`category` the original placement. Read keeps the same bytes and IDs.
The Markdown indexes in `memory/topics/` are rebuildable views, not Knowledge.

Reuse identity and current notes for the same topic. Distinctive titles and headings
help AND and passage selection; explicitly describe scope,
corrections and superseded decisions. Group by cohesion and independent consultation,
without splitting by turn or byte threshold. Topics such as decisions/reasons,
results/limits, specifications and open questions are optional criteria, not
directories, types or mandatory taxonomies. Sections allow targeted reads
in coherent notes; an independent topic may deserve a linked standalone note.

## Selective use and limits

Read STATE once, reuse the answer, search with targeted words and a filter
when available, open only the candidates relevant to the questions still open.
A lexical miss does not prove a universal semantic absence: report
that the datum is not documented in the evidence retrieved, without inventing it.

The backend scans local files in memory: O(size of HISTORY/Knowledge)
with no persistent index. To the model it returns only limited results and
chosen contents. In workspaces every operation shares the curator gate;
sections limit the output, not the verification I/O or the local scan. A direct
reference avoids find but the current resolution still checks
the note identities; it does not promise an O(1) backend. There is no snapshot between
successive calls: navigation is stable only on confirmed memory. The path checks
are not isolation against simultaneous hostile filesystem changes. The gate reads
checkpoint/feed and can complete an already authorized apply; standalone copies
have no such integration.

## Evidence and limits of the evaluation

The fixtures cover multiple similar notes, secondary details, two levels of linkage,
sections, multiple checkpoints, corrections and historical versions; they check bytes,
identity, order, excerpt limits, paths and absence of traversals.
SessionStart makes STATE available; offline tests do not prove that the agent
actually reuses it or correctly interprets all the qualifications.

In the future MCP/CLI comparison use the same navigator and the same versions,
queries, selections, sources and initial context conditions. Measure separately
retrieval correctness, answer quality, calls, bytes/tokens actually
exposed, instructions, cache, transport and time. Less output does not prove lower
overall cost; sections lacking necessary qualifications are not complete retrievals.
No MCP interface is introduced here.
