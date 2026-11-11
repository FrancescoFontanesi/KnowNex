import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { parseNoteIdentity } from './memory-contract.ts';
import { basename, dirname, join, resolve } from 'node:path';
import {
  jsonText,
  readArtifact,
  sha256,
  utf8Bytes,
  writeExclusiveFiles,
} from './artifact-io.ts';
import { checkCurationDraft } from './curator.ts';
import { acquireJournalLock } from './journal-lock.ts';
export { transportJson } from './artifact-io.ts';

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
export async function readCurationRun(run: string) {
  if (
    (await realpath(run)) !== resolve(run) ||
    (await lstat(run)).isSymbolicLink()
  )
    fail('CURATOR_IO_UNSAFE_RUN');
  const record = JSON.parse((await readArtifact(join(run, 'run.json'))).text);
  if (
    record.id !== basename(run) ||
    !object(record.base) ||
    typeof record.base.feed !== 'string'
  )
    fail('CURATOR_IO_UNSAFE_RUN');
  return record;
}
/** Official Curator reader. Only the input names frozen for this run are readable. */
export async function readCurationInput(run: string, name: string) {
  const record = await readCurationRun(run);
  if (
    !/^(inputs\.json|packet\.json|WINDOW\.md|SKILL\.md|MEMORY-CONTRACT\.md|base\/(STATE\.md|HISTORY\.md|knowledge\/[a-z0-9-]+\.md))$/.test(
      name,
    )
  ) {
    const target = resolve(run, 'base', decodeURIComponent(name));
    // The live feed is provenance, not a frozen input: later events are in the next batch.
    if (target === resolve(record.base.feed))
      fail('CURATOR_IO_INPUT_NOT_AUTHORIZED');
    if (!Array.isArray(record.external) || !record.external.includes(target))
      fail('CURATOR_IO_INPUT_NOT_AUTHORIZED');
    return readArtifact(target);
  }
  const manifest = await readArtifact(join(run, 'inputs.json'));
  if (manifest.sha256 !== record.inputManifestSha256)
    fail('CURATOR_INPUTS_CHANGED');
  const inputs = JSON.parse(manifest.text);
  if (
    inputs.version !== 1 ||
    inputs.from !== record.base.sequence + 1 ||
    inputs.through !== record.last.event.sequence
  )
    fail('CURATOR_INPUTS_CHANGED');
  if (name === 'inputs.json') return manifest;
  const expected = inputs.files[name]?.sha256;
  if (!expected) fail('CURATOR_IO_INPUT_NOT_AUTHORIZED');
  if (
    !record.autonomous &&
    name.startsWith('base/knowledge/') &&
    !record.context?.includes(name.slice(5))
  )
    fail('CURATOR_IO_INPUT_NOT_AUTHORIZED');
  const artifact = await readArtifact(join(run, name));
  if (artifact.sha256 !== expected) fail('CURATOR_INPUTS_CHANGED');
  return artifact;
}
/**
 * Provenance is the bare label ([E017], [E015–E016]): the feed lives outside memory, so a link
 * to it is broken in Obsidian and opens a whole JSONL for an agent. Links copied from older
 * notes are reduced to their label.
 */
function uncite(text: string) {
  return text.replace(
    /\[(E\d{3,}(?:\s*(?:\.\.|[–-])\s*E\d{3,})?)\]\([^)\n]*\)/g,
    '[$1]',
  );
}
/**
 * New notes get identity frontmatter here, so the Curator never mints UUIDs: an existing note
 * keeps the id frozen in base, a new one gets a v4. Frontmatter already written is left as is.
 */
async function withIdentity(run: string, key: string, text: string) {
  if (text.startsWith('---')) return text;
  let id: string;
  try {
    id = parseNoteIdentity(
      (await readArtifact(join(run, 'base', key))).text,
    ).id;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    id = 'kn-' + randomUUID();
  }
  return `---\nid: ${id}\ntype: knowledge\n---\n\n` + text;
}
/**
 * Assembles proposal and review from plain files the Curator wrote in run/draft with its
 * file tool: Markdown never has to be serialized into JSON or piped through a shell.
 */
export async function writeCurationDraft(run: string) {
  const draft = join(run, 'draft');
  const text = async (name: string) =>
    (await readArtifact(join(draft, name))).text.replace(/^﻿/, '');
  const parse = async (name: string) => {
    try {
      return JSON.parse(await text(name));
    } catch (e) {
      if (e instanceof SyntaxError) fail('CURATOR_DRAFT_INVALID');
      throw e;
    }
  };
  const meta = await parse('proposal.json'),
    review = await parse('review.json');
  if (!object(meta) || 'state' in meta || 'knowledge' in meta)
    fail('CURATOR_DRAFT_INVALID');
  let proposal = meta;
  if (meta.action === 'update') {
    let names: string[] = [];
    try {
      names = await readdir(join(draft, 'knowledge'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const knowledge: Record<string, string> = {};
    for (const name of names.sort()) {
      const key = 'knowledge/' + name;
      knowledge[key] = uncite(await withIdentity(run, key, await text(key)));
    }
    proposal = {
      ...meta,
      ...(object(meta.history) && typeof meta.history.transition === 'string'
        ? {
            history: {
              ...meta.history,
              transition: uncite(meta.history.transition),
            },
          }
        : {}),
      state: uncite(await text('STATE.md')),
      knowledge,
    };
  }
  const entries = await curationEntries(run, proposal, review);
  // complete may run in parallel: it takes the same lock to check delivery and freeze the run.
  const release = await acquireJournalLock(join(run, 'delivery.lock'));
  try {
    let controller;
    try {
      controller = JSON.parse(
        (await readArtifact(join(run, 'controller.json'))).text,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    // Once complete has frozen the run, its delivery can no longer change.
    if (controller?.status !== undefined && controller.status !== 'prepared')
      fail('CURATOR_CHECKPOINT_RETRY_FORBIDDEN');
    // Same checks as complete, while the Curator is still running and can fix its draft.
    await checkCurationDraft(
      dirname(dirname(run)),
      utf8Bytes(entries.at(-1)!.text),
      entries.length > 1 ? utf8Bytes(entries[0]!.text) : undefined,
    );
    // Replace an earlier attempt. Proposal is the commit point, so it is removed first.
    for (const name of ['proposal.json', 'review.json'])
      await rm(join(run, name), { force: true });
    return receipts(await writeExclusiveFiles(entries), review);
  } finally {
    await release();
  }
}
const receipts = (
  written: Awaited<ReturnType<typeof writeExclusiveFiles>>,
  review: unknown,
) => ({
  proposal: written.at(-1)!,
  ...(review !== undefined ? { review: written[0]! } : {}),
});
/** Canonical writer shared by the CLI and programmatic clients. */
export async function writeCurationArtifacts(
  run: string,
  proposal: unknown,
  review?: unknown,
) {
  const entries = await curationEntries(run, proposal, review);
  return receipts(await writeExclusiveFiles(entries), review);
}
/** Serializes proposal and review exactly as persisted; review is bound to the proposal bytes. */
async function curationEntries(
  run: string,
  proposal: unknown,
  review?: unknown,
) {
  const work = dirname(dirname(run));
  if (basename(dirname(run)) !== 'runs') fail('CURATOR_IO_UNSAFE_RUN');
  const record = await readCurationRun(run),
    pending = JSON.parse((await readArtifact(join(work, 'pending.json'))).text);
  if (pending.id !== record.id) fail('CURATOR_IO_RUN_NOT_PENDING');
  if (!object(proposal)) fail('CURATOR_PROPOSAL_INVALID');
  const text = jsonText(proposal, 2) + '\n',
    proposalSha256 = sha256(text);
  if (record.autonomous && !object(review)) fail('CURATOR_REVIEW_REQUIRED');
  const entries: { path: string; text: string }[] = [];
  if (review !== undefined) {
    if (!object(review) || review.version !== 3) fail('CURATOR_REVIEW_INVALID');
    if (
      review.proposalSha256 !== undefined &&
      review.proposalSha256 !== proposalSha256
    )
      fail('CURATOR_IO_PROPOSAL_HASH_MISMATCH');
    entries.push({
      path: join(run, 'review.json'),
      text: jsonText({ ...review, proposalSha256 }, 2) + '\n',
    });
  }
  // Proposal is the commit point. A killed writer that only published review cannot validate.
  entries.push({ path: join(run, 'proposal.json'), text });
  return entries;
}
