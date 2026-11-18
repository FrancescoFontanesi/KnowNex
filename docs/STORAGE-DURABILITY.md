# Promotion durability

The [Knowledge versioning](KNOWLEDGE-REVISIONS.md) extends the journal to the new
archives/receipts only. Their files and the `revisions/` namespace are synchronized
before the v3 checkpoint. This extension is
verified with simulated crash/EIO and adds no evidence of physical durability.

**Protocol implemented and verified under conditional model B.**
Physical durability C remains unproven. Qualification is not started.

## Environment and actual primitives

Local verification of 4 November 2026: Windows 11 Pro, build 26200
(`10.0.26200`), Node.js `v24.11.1`, libuv `1.51.0`, fixed NTFS volume `F:`.
The test creates only temporary files on the same volume as the workspace:

| Real operation                                                      | Outcome                   |
| ------------------------------------------------------------------- | ------------------------- |
| Write to a file opened `wx`, `FileHandle.sync()`, close and re-read | OK                        |
| Directory opened `r`, `FileHandle.sync()`                           | `EPERM` in the sync phase |
| Directory opened `r+`, `FileHandle.sync()`                          | OK                        |

Success means the call completed in the observed environment. It is not
a verification of data that survived a blackout. It is not correct to claim that
directory sync is always unavailable on Windows.

Primary sources consulted:

- [Node 24.11.1: FileHandle.sync](https://nodejs.org/download/release/v24.11.1/docs/api/fs.html#filehandlesync)
  exposes the flush. `writeFile` without `flush: true` does not request it.
- [libuv 1.51.0, Windows implementation](https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c):
  `fs__sync_impl` uses `FlushFileBuffers`. `fs__rename` uses `MoveFileExW` with
  `MOVEFILE_REPLACE_EXISTING`, without `MOVEFILE_WRITE_THROUGH`.
- [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
  requires a handle with write access. Flushing a whole volume is
  different and requires administrative privileges. It is not attempted.
- [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
  describes a separate write-through flag. The durability of the rename
  used by Node cannot be inferred from the success of its Promise alone.

## Contract and assumptions

The additional source is [MS-FSA §2.1.5.7](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/0de7dc40-9627-437e-a4df-c4696cdc3d02):
the flush persists attributes, metadata and directory structure and requires the
flush of the underlying storage. [Product note 80](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63)
specifies that the behavior is implemented by NTFS. Other filesystems may
return success without performing this operation. This source narrows
the earlier block: the probe alone was not a sufficient contract.

Model B explicitly assumes:

- Local NTFS, Node 24.11.1/libuv 1.51.0, directories openable `r+`. The chain
  `FileHandle.sync` → `FlushFileBuffers` satisfies the NTFS contract above
  for open objects, directories included. The volume type is
  verified externally (`Get-Volume`). Node `statfs` returns type 0 here
  and is not a reliable check to enable other filesystems.
- A successful flush makes the content/metadata of the object stable. The flush of a
  directory makes the immediate names stable. Later flushes do not invalidate data
  already stable. Before the flush, writes and names can persist separately,
  lose updates or leave the name involved in a rename absent.
- The namespace of the already existing ancestors of the workspace and of the sources is
  stable. `init` persists the new memory and the workspace name before
  confirming the checkpoint. An old workspace must start from a consistent
  generation. Retroactive recovery of evidence already lost is not promised.
- Append-only feed with a frozen prefix and no concurrent rewrite.
  Original artifacts and source namespace are already stable. File, directory,
  filter, controller and device honor the flushes. No
  collateral corruption of blocks already synchronized. All writers of the memory
  respect the lock. Arbitrary writes that resist crashes atomically are not assumed.
  Incomplete temporaries stay outside the confirmed memory.

These are conditions of the model, not hardware measurements. No B guarantee
is extended to FAT/ReFS, SMB or devices that ignore flushes. A sync
failure propagates. There is no fallback that ignores directory errors. Flushes
require write access even to the sources to synchronize. Insufficient
permissions stop the operation before promotion.

## Persistent order

| Phase                      | Barriers before proceeding                                                                                                                                   | Reason                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baseline and prerequisites | Flush of the previous memory, knowledge, memory and work. Previous checkpoint. run.json, run directory and runs. Feed and its directory. Work and its parent | Make the initial generation and the prerequisites recoverable before the persistent authorization. Prepare also persists run/runs/work before pending. |
| Journal                    | Exclusive write of the temporary, content sync, close, rename to apply.json, sync of the published file and of work                                          | No Markdown changes before data and name of the authorization are stable.                                                                              |
| Markdown                   | Per changed file: temporary in work, sync, rename, sync of the file and of the destination/source directories                                                | Full contents before names. Temporaries that may reappear do not enter the confirmed tree.                                                             |
| Full tree                  | Final hash. New flush of all files, knowledge, memory and work                                                                                               | Also cover names already visible from an interrupted attempt and the creation of knowledge in its parent.                                              |
| Checkpoint                 | Synchronized temporary, rename, sync of the file and of work                                                                                                 | The checkpoint can become stable only after all the data it represents.                                                                                |
| Cleanup                    | Repeat the checkpoint/work barrier before unlinking pending. Then sync work                                                                                  | The outcome of the rename can be visible before its flush returns. The last apply.json always stays as a receipt.                                      |

`atomicText` implements content → publication → metadata/namespace, without
treating the rename alone as a barrier. At recovery the flush of the
journal and of work is repeated immediately. A visible journal could come from a publication
interrupted before its barrier. An interrupted recovery can be repeated.

The record contains the previous and next trees. With a previous checkpoint
or a missing checkpoint name, missing files are rebuilt from the record.
Existing ones must match exactly the previous or the new version.
The run is resolved from the persisted runId, without depending on the survival of the
pending. With a next checkpoint the tree must already match the new one.
A corrupt record, a file with unexpected content or a present but incompatible checkpoint
stop the recovery. The journal keeps the HISTORY prefix and does not re-append segments.

Journal cleanup is not introduced. At the next transaction its
replacement precedes any change to the data of that transaction, while
the previous generation is already stable. Preallocated journals with reused slots
would avoid some renames but would require a persistent bootstrap and a selection
among potentially truncated slots. Moreover, new Knowledge and checkpoint would
still need name barriers. They do not reduce the protocol implemented here.

## Verification A, B, C

- **A — crash consistency:** V2.1 tests at the promotion boundaries, interrupted
  recovery and replay are kept. EIO on renames stays a distinct simulated error.
- **B — persistence model:** a new test traces writes, native flushes,
  renames and unlinks of the real apply on the STATE/HISTORY/two Knowledge fixture.
  An independent model keeps contents only after file-sync and immediate names
  only after directory-sync, also checking the order journal → data → checkpoint
  → cleanup. Nine alternative projections on the real files lose the unsynchronized
  journal write, its rename, the Markdown rename or the checkpoint and the
  cleanup. They include early persistence and loss of the replaced name.
  A recovery is interrupted and its unsynchronized name is lost again.
  A second new test injects EIO in the journal flush: no Markdown is
  promoted. Recovery re-establishes the barrier and replay does not duplicate HISTORY.
  The earlier test of the missing checkpoint now verifies recovery in the model,
  instead of requiring the block. Corruptions that cannot be rebuilt stay rejected.
- **C — physical durability:** not proven. The model does not measure what survives
  on that controller after a blackout. No forced shutdown or change of
  settings is performed.

Residual limits: flush cost of the tree and workspace reads that may
repeat recovery barriers. Space of orphan temporaries. Pre-existing conservative lock.
Availability that depends on intact prerequisites and on permissions.
No additional LLM, agentic benchmark, new dependency or final qualification.

## Canonical memory layout

The revisions are published directly in .knownex/memory/knowledge
and STATE/HISTORY in .knownex/memory. Journal and receipts stay in internal/curator.
The publication and parent barriers follow the effective paths. Before the
checkpoint the current HEADs are also synchronized, with no persistent
flat projections. Recovery rebuilds the same logical generation from the HEADs.
No new guarantee of physical durability.
Details and limits of external Markdown readers: [MEMORY-LAYOUT.md](MEMORY-LAYOUT.md).
