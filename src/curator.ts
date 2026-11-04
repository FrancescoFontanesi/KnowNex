import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { acquireJournalLock } from './journal-lock.ts';
import type { FeedEvent } from './feed.ts';
import { isFeedInput, feedIdentity } from './feed.ts';
import { projectFeedEvents } from './commentary.ts';
import {
  validateKnowledge,
  validateKnowledgeEvolution,
} from './memory-contract.ts';
import {
  historySegments,
  historyAppendix,
  type Transition,
} from './history.ts';
type Tree = Record<string, string>;
export const emptyMemory: Tree = {
  'STATE.md':
    '# Stato iniziale\n\nNessuna informazione materializzata. Gli eventi originali restano nel feed.\n',
  'HISTORY.md': '# History\n',
};
interface Row {
  event: FeedEvent;
  checksum: string;
  from: number;
  end: number;
}
interface Checkpoint {
  version: 2;
  feed: string;
  sessionId: string;
  sequence: number;
  checksum: string;
  memoryHash: string;
}
interface Run {
  consent?: { request: string; sequence: number; checksum: string };
  id: string;
  base: Checkpoint;
  last: Row;
  context: string[];
  external: string[];
  directive: string;
}
interface Consent {
  version: 1;
  id: string;
  milestone: string;
  base: Checkpoint;
  through: number;
  anchor: number;
  anchorChecksum: string;
  session: string;
  turn: string;
  consumedBy?: string;
  response?: { sequence: number; checksum: string };
}
export const checkpointQuestion =
  'Vuoi consolidare la memoria del progetto adesso? (Sì/No)';
type Proposal =
  | { action: 'noop' }
  | { action: 'update'; state: string; history: Transition; knowledge: Tree };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const allowed = (name: string) =>
  /^(?:(?:STATE|HISTORY)\.md|knowledge\/[a-z0-9-]+\.md)$/.test(name);
const inside = (root: string, target: string) => {
  const r = relative(root, target);
  return (
    r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep))
  );
};
const json = async <T>(p: string): Promise<T> =>
  JSON.parse(await readFile(p, 'utf8')) as T;
const digest = (tree: Tree) =>
  sha(
    JSON.stringify(
      Object.entries(tree).sort(([a], [b]) => a.localeCompare(b, 'en')),
    ),
  );
const links = (text: string) => {
  // Keep the accepted Markdown link subset explicit instead of silently missing
  // reference links, images or destinations containing unescaped whitespace.
  if (/!\[|\[[^\]]*\]\[|^\s*\[[^\]]+\]:/m.test(text))
    fail('CURATOR_LINK_INVALID');
  return [...text.matchAll(/\[[^\]]*\]\(([^)\n]*)\)/g)].map((m) => {
    const href = m[1]!;
    if (!href || /[\s<>]/.test(href)) fail('CURATOR_LINK_INVALID');
    return href;
  });
};
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');

async function treeAt(root: string, complete = true): Promise<Tree> {
  const tree: Tree = {};
  async function walk(folder: string) {
    if ((await lstat(folder)).isSymbolicLink()) fail('CURATOR_UNSAFE_PATH');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const p = join(folder, entry.name),
        name = relative(root, p).split(sep).join('/');
      if (entry.isSymbolicLink()) fail('CURATOR_UNSAFE_PATH');
      if (entry.isDirectory()) {
        if (name !== 'knowledge') fail('CURATOR_UNSAFE_PATH');
        await walk(p);
      } else {
        if (!entry.isFile() || !allowed(name)) fail('CURATOR_UNSAFE_PATH');
        tree[name] = await readFile(p, 'utf8');
      }
    }
  }
  await walk(root);
  if (complete)
    for (const n of ['STATE.md', 'HISTORY.md'])
      if (!tree[n]) fail('CURATOR_MISSING_FILE');
  return tree;
}

async function putTree(root: string, tree: Tree) {
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(tree)) {
    if (!allowed(name)) fail('CURATOR_UNSAFE_PATH');
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text, { mode: 0o600 });
  }
}

function rebase(tree: Tree, from: string, to: string): Tree {
  return Object.fromEntries(
    Object.entries(tree).map(([name, text]) => [
      name,
      text.replace(
        /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g,
        (whole, label: string, href: string) => {
          const [url, fragment] = href.split('#');
          if (!url || /^[a-z]+:/i.test(url)) return whole;
          const target = resolve(
            dirname(join(from, name)),
            decodeURIComponent(url),
          );
          if (inside(from, target)) return whole;
          return `[${label}](${relative(dirname(join(to, name)), target)
            .split(sep)
            .map(encodeURIComponent)
            .join('/')}${fragment ? '#' + fragment : ''})`;
        },
      ),
    ]),
  );
}

function externalLinks(tree: Tree, root: string) {
  const result = new Set<string>();
  for (const [name, text] of Object.entries(tree))
    for (const href of links(text)) {
      const url = href.split('#')[0]!;
      if (!url || /^[a-z]+:/i.test(url)) continue;
      const target = resolve(
        dirname(join(root, name)),
        decodeURIComponent(url),
      );
      if (!inside(root, target)) result.add(target);
    }
  return [...result];
}

async function feedRows(file: string): Promise<Row[]> {
  const bytes = await readFile(file),
    result: Row[] = [];
  let from = 0,
    previous: string | null = null,
    session: string | undefined;
  const identities = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end; (end = bytes.indexOf(10, from)) !== -1; from = end + 1) {
    try {
      const f = JSON.parse(decoder.decode(bytes.subarray(from, end)));
      const e: FeedEvent = f.block.event;
      if (
        f.block.version !== 1 ||
        f.block.previous !== previous ||
        f.checksum !== sha(JSON.stringify(f.block)) ||
        !isFeedInput(e) ||
        typeof e.capturedAt !== 'string' ||
        new Date(e.capturedAt).toISOString() !== e.capturedAt ||
        e.sequence !== result.length + 1 ||
        (basename(file) !== 'project.jsonl' &&
          session !== undefined &&
          session !== e.sessionId)
      )
        throw new Error();
      const id = feedIdentity(e);
      if (identities.has(id)) throw new Error();
      identities.add(id);
      session = e.sessionId;
      previous = f.checksum;
      result.push({ event: e, checksum: f.checksum, from, end: end + 1 });
    } catch {
      fail('CURATOR_FEED_CORRUPT');
    }
  }
  return result;
}

/** Event syntax is interpreted only inside an explicit provenance declaration. */
function validateEventLabel(label: string, rows: Row[], cutoff: number) {
  const refs = [...label.matchAll(/\bE(\d+)\b/g)];
  if (!refs.length) fail('CURATOR_PROVENANCE_INVALID');
  for (const ref of refs) {
    const n = Number(ref[1]);
    if (!rows[n - 1] || n > cutoff || ref[1] !== String(n).padStart(3, '0'))
      fail('CURATOR_PROVENANCE_INVALID');
  }
  const ranges = /\bE(\d+)\s*(?:\.\.|[–-])\s*E(\d+)\b/g;
  for (const range of label.matchAll(ranges))
    if (Number(range[1]) > Number(range[2])) fail('CURATOR_PROVENANCE_INVALID');
  // Reject incomplete/chained ranges, rather than treating their valid endpoint as a list.
  if (
    /\bE\d+\s*(?:\.\.|[–-])|(?:\.\.|[–-])\s*E\d+\b/.test(
      label.replace(ranges, ''),
    )
  )
    fail('CURATOR_PROVENANCE_INVALID');
}

async function validateTree(
  tree: Tree,
  root: string,
  external: string[],
  rows: Row[],
  cutoff: number,
  feed: string,
) {
  validateKnowledge(tree);
  if (
    !/^#\s+\S/m.test(tree['STATE.md']!) ||
    /knownex-history:/.test(tree['STATE.md']!)
  )
    fail('CURATOR_STATE_INVALID');
  historySegments(tree['HISTORY.md']!, cutoff);
  for (const field of tree['HISTORY.md']!.matchAll(/^- Eventi: `([^`]+)`$/gm))
    validateEventLabel(field[1]!, rows, cutoff);
  for (const [name, text] of Object.entries(tree)) {
    let provenance = false;
    const hrefs = links(text);
    const labels = [...text.matchAll(/\[([^\]]*)\]\(([^)\n]*)\)/g)];
    for (const [i, href] of hrefs.entries()) {
      const label = labels[i]![1]!.trim();
      const [url, anchor] = href.split('#');
      if (/^[a-z]+:/i.test(url ?? '')) fail('CURATOR_LINK_INVALID');
      const target = resolve(
        dirname(join(root, name)),
        decodeURIComponent(url || name.split('/').at(-1)!),
      );
      const internal = inside(root, target),
        key = relative(root, target).split(sep).join('/');
      if (internal ? !Object.hasOwn(tree, key) : !external.includes(target))
        fail('CURATOR_LINK_INVALID');
      if (!internal && !(await stat(target)).isFile())
        fail('CURATOR_LINK_INVALID');
      if (
        /^E\d{3,}(?:\s*(?:\.\.|[–-])\s*E\d{3,})?$/.test(label) &&
        target !== feed
      )
        fail('CURATOR_PROVENANCE_INVALID');
      if (target === feed) {
        validateEventLabel(label, rows, cutoff);
        if (anchor) fail('CURATOR_PROVENANCE_INVALID');
        provenance = true;
      }
      if (anchor) {
        const body = internal ? tree[key]! : await readFile(target, 'utf8');
        const anchors = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
          slug(m[1]!),
        );
        if (!anchors.includes(decodeURIComponent(anchor)))
          fail('CURATOR_LINK_INVALID');
      }
    }
    if (name !== 'HISTORY.md' && !provenance && text !== emptyMemory[name])
      fail('CURATOR_PROVENANCE_INVALID');
  }
}

async function atomicJson(file: string, value: unknown) {
  await atomicText(file, JSON.stringify(value, null, 2) + '\n');
}

async function atomicText(
  file: string,
  text: string,
  temporary = dirname(file),
) {
  const temp = join(temporary, randomUUID() + '.tmp');
  const fileHandle = await open(temp, 'wx', 0o600);
  try {
    await fileHandle.writeFile(text);
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
  await rename(temp, file);
  // Contents precede publication; namespace barriers precede the caller's next write.
  await syncPath(file);
  await syncDirectory(dirname(file));
  if (temporary !== dirname(file)) await syncDirectory(temporary);
}

async function syncPath(path: string) {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string) {
  const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flush child entries before their parent and before publishing a checkpoint. */
async function syncTree(root: string, tree: Tree) {
  for (const name of Object.keys(tree)) await syncPath(join(root, name));
  if (Object.keys(tree).some((name) => name.startsWith('knowledge/')))
    await syncDirectory(join(root, 'knowledge'));
  await syncDirectory(root);
  await syncDirectory(dirname(root));
}

interface ApplyRecord {
  version: 1;
  runId: string;
  seal: string;
  action: string;
  before: Checkpoint;
  after: Checkpoint;
  previous: Tree;
  next: Tree;
}

async function applyRecord(work: string): Promise<ApplyRecord | undefined> {
  let raw: unknown;
  try {
    raw = await json(join(work, 'apply.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail('CURATOR_RECOVERY_INVALID');
  }
  const tree = (x: unknown): x is Tree =>
    object(x) &&
    typeof x['STATE.md'] === 'string' &&
    typeof x['HISTORY.md'] === 'string' &&
    Object.entries(x).every(
      ([name, text]) => allowed(name) && typeof text === 'string',
    );
  if (
    !object(raw) ||
    !object(raw.record) ||
    sha(JSON.stringify(raw.record)) !== raw.checksum
  )
    fail('CURATOR_RECOVERY_INVALID');
  const r = raw.record as unknown as ApplyRecord;
  if (
    r.version !== 1 ||
    typeof r.runId !== 'string' ||
    !/^[a-z0-9-]+$/.test(r.runId) ||
    typeof r.seal !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.seal) ||
    !['noop', 'update'].includes(r.action) ||
    !object(r.before) ||
    !object(r.after) ||
    r.before.version !== 2 ||
    !Number.isSafeInteger(r.before.sequence) ||
    r.before.sequence < 0 ||
    !Number.isSafeInteger(r.after.sequence) ||
    r.after.sequence <= r.before.sequence ||
    typeof r.before.feed !== 'string' ||
    typeof r.before.sessionId !== 'string' ||
    typeof r.after.sessionId !== 'string' ||
    typeof r.before.checksum !== 'string' ||
    typeof r.after.checksum !== 'string' ||
    !tree(r.previous) ||
    !tree(r.next) ||
    (r.before.sequence === 0 &&
      (r.before.sessionId !== '' ||
        r.before.checksum !== '' ||
        digest(r.previous) !== digest(emptyMemory))) ||
    digest(r.previous) !== r.before.memoryHash ||
    digest(r.next) !== r.after.memoryHash ||
    JSON.stringify(r.after) !==
      JSON.stringify({
        ...r.before,
        sessionId: r.after.sessionId,
        sequence: r.after.sequence,
        checksum: r.after.checksum,
        memoryHash: digest(r.next),
      }) ||
    Object.keys(r.previous).some((name) => !Object.hasOwn(r.next, name)) ||
    !r.next['HISTORY.md']!.startsWith(r.previous['HISTORY.md']!)
  )
    fail('CURATOR_RECOVERY_INVALID');
  return r;
}

/** The checkpoint commits the generation. Keep the last intent as a replay receipt. */
async function recoverApply(work: string) {
  const r = await applyRecord(work);
  if (!r) return;
  // A visible intent may have survived before its publication barrier completed.
  await syncPath(join(work, 'apply.json'));
  await syncDirectory(work);
  let cp: Checkpoint | undefined;
  try {
    cp = await json<Checkpoint>(join(work, 'checkpoint.json'));
  } catch (error) {
    // An interrupted, not-yet-flushed rename may lose the checkpoint name.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const committed = JSON.stringify(cp) === JSON.stringify(r.after);
  if (
    cp !== undefined &&
    !committed &&
    JSON.stringify(cp) !== JSON.stringify(r.before)
  )
    fail('CURATOR_RECOVERY_INVALID');
  const target = join(work, 'memory'),
    current = await treeAt(target, false);
  if (committed) {
    if (digest(current) !== r.after.memoryHash) fail('CURATOR_MEMORY_CHANGED');
    await syncTree(target, r.next);
  } else {
    // Every visible file is a complete old or new version: promotion uses rename.
    if (
      Object.entries(current).some(
        ([name, text]) => text !== r.previous[name] && text !== r.next[name],
      )
    )
      fail('CURATOR_RECOVERY_INVALID');
    // run.json/pending.json are durably established before the authorization record.
    const run = await json<Run>(join(work, 'runs', r.runId, 'run.json'));
    if (run.id !== r.runId) fail('CURATOR_RECOVERY_INVALID');
    const rows = await feedRows(r.before.feed);
    checkRun(r.before, rows, run);
    if (
      JSON.stringify(run.base) !== JSON.stringify(r.before) ||
      (r.before.sequence > 0 &&
        rows[r.before.sequence - 1]?.checksum !== r.before.checksum) ||
      run.last.event.sequence !== r.after.sequence ||
      run.last.event.sessionId !== r.after.sessionId ||
      run.last.checksum !== r.after.checksum
    )
      fail('CURATOR_RECOVERY_INVALID');
    await validateTree(
      r.next,
      target,
      run.external,
      rows,
      r.after.sequence,
      r.after.feed,
    );
    for (const [name, text] of Object.entries(r.next)) {
      if (current[name] === text) continue;
      await mkdir(dirname(join(target, name)), { recursive: true });
      await atomicText(join(target, name), text, work);
    }
    if (digest(await treeAt(target)) !== r.after.memoryHash)
      fail('CURATOR_RECOVERY_INVALID');
    // Files already equal to `next` may have survived an unflushed rename.
    // Re-flush every entry, including the knowledge directory's own name.
    await syncTree(target, r.next);
    await atomicJson(join(work, 'checkpoint.json'), r.after);
  }
  // Even a visible `after` checkpoint may precede its interrupted namespace flush.
  await syncPath(join(work, 'checkpoint.json'));
  await syncDirectory(work);
  const pending = await pendingRun(work);
  if (pending?.id === r.runId) {
    await unlink(join(work, 'pending.json'));
    await syncDirectory(work);
  }
  return r;
}

/** Serialize workspace reads with apply; standalone memory directories stay read-only. */
export async function withConfirmedMemory<T>(
  root: string,
  read: () => Promise<T>,
): Promise<T> {
  if (basename(root) !== 'memory') return read();
  const work = dirname(root);
  try {
    await lstat(join(work, 'checkpoint.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // An intent without its checkpoint must never become a standalone memory.
      if (!(await applyRecord(work))) return read();
    } else throw error;
  }
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    await stateAt(work);
    return await read();
  } finally {
    await release();
  }
}

async function stateAt(work: string, recover = true) {
  if (recover) await recoverApply(work);
  const cp = await json<Checkpoint>(join(work, 'checkpoint.json'));
  if (!recover) {
    const receipt = await applyRecord(work);
    if (
      receipt &&
      (JSON.stringify(cp) !== JSON.stringify(receipt.after) ||
        (await pendingRun(work))?.id === receipt.runId)
    )
      fail('CURATOR_RECOVERY_REQUIRED');
  }
  if (cp.version !== 2 || !Number.isSafeInteger(cp.sequence) || cp.sequence < 0)
    fail('CURATOR_CHECKPOINT_INVALID');
  const rows = await feedRows(cp.feed),
    last = rows[cp.sequence - 1];
  if (
    cp.sequence === 0
      ? cp.checksum !== '' || cp.sessionId !== ''
      : !last ||
        last.checksum !== cp.checksum ||
        last.event.sessionId !== cp.sessionId
  )
    fail('CURATOR_FEED_CHANGED');
  const memory = await treeAt(join(work, 'memory'));
  if (cp.sequence === 0 && digest(memory) !== digest(emptyMemory))
    fail('CURATOR_CHECKPOINT_INVALID');
  if (digest(memory) !== cp.memoryHash) fail('CURATOR_MEMORY_CHANGED');
  return { cp, rows, memory };
}

async function pendingRun(work: string): Promise<Run | undefined> {
  let pointer: { id: string };
  try {
    pointer = await json(join(work, 'pending.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (typeof pointer.id !== 'string' || !/^[a-z0-9-]+$/.test(pointer.id))
    fail('CURATOR_STAGE_CHANGED');
  return json<Run>(join(work, 'runs', pointer.id, 'run.json'));
}

/** Project pending is derived from the same feed/checkpoint used by prepare. */
export async function curatorStatus(work: string, feed: string) {
  work = resolve(work);
  feed = resolve(feed);
  let initialized = true;
  try {
    await lstat(join(work, 'checkpoint.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // An incomplete bootstrap is not a confirmed empty checkpoint.
    try {
      await lstat(work);
      fail('CURATOR_CHECKPOINT_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    initialized = false;
  }
  const release = initialized
    ? await acquireJournalLock(join(work, 'curator.lock'))
    : undefined;
  try {
    const state = initialized ? await stateAt(work) : undefined;
    if (state && state.cp.feed !== (await realpath(feed)))
      fail('CURATOR_FEED_CHANGED');
    const rows = state?.rows ?? (await feedRows(feed));
    const through = state?.cp.sequence ?? 0;
    const run = initialized ? await pendingRun(work) : undefined;
    const consent = initialized ? await consentAt(work) : undefined;
    if (run && state) checkRun(state.cp, rows, run);
    return {
      initialized,
      through,
      pending: rows.length - through,
      latest: rows.length,
      readyThrough:
        [...rows].reverse().find((r) => r.event.type === 'assistant_final')
          ?.event.sequence ?? through,
      activeRun: run ? join(work, 'runs', run.id) : null,
      unconfirmedRun:
        consent?.consumedBy &&
        state &&
        state.cp.sequence === consent.base.sequence
          ? join(work, 'runs', consent.consumedBy)
          : null,
      consent:
        consent && state
          ? {
              request: consent.id,
              milestone: consent.milestone,
              through: consent.through,
              status: consentReply(consent, state.cp, rows).status,
            }
          : null,
      memory: initialized ? join(work, 'memory') : null,
      state: state?.memory['STATE.md'] ?? emptyMemory['STATE.md']!,
    };
  } finally {
    await release?.();
  }
}

function checkRun(cp: Checkpoint, rows: Row[], run: Run) {
  if (
    JSON.stringify(cp) !== JSON.stringify(run.base) ||
    run.last.event.sequence <= cp.sequence ||
    rows[run.last.event.sequence - 1]?.checksum !== run.last.checksum
  )
    fail('CURATOR_STALE_BATCH');
}

interface PendingCursor {
  version: 1;
  feed: string;
  checkpoint: string;
  from: number;
  through: number;
  checksum: string;
  next: number;
  offset: number;
}
export interface PendingOptions {
  from?: number;
  through?: number;
  limit?: number;
  cursor?: string;
}

/** Read a bounded, stable feed window without staging, consuming consent or recovery writes. */
export async function readPendingEvents(
  work: string,
  feed: string,
  options: PendingOptions = {},
) {
  work = resolve(work);
  feed = await realpath(feed);
  let initialized = true;
  try {
    await lstat(work);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    initialized = false;
  }
  const release = initialized
    ? await acquireJournalLock(join(work, 'curator.lock'))
    : undefined;
  try {
    const releaseFeed = await acquireJournalLock(feed + '.lock');
    try {
      const state = initialized ? await stateAt(work, false) : undefined;
      if (state && state.cp.feed !== feed) fail('CURATOR_FEED_CHANGED');
      const rows = state?.rows ?? (await feedRows(feed));
      const cutoff = state?.cp.sequence ?? 0;
      const checkpoint = sha(JSON.stringify(state?.cp ?? null));
      const feedId = sha(feed);
      const incompleteTailBytes =
        (await stat(feed)).size - (rows.at(-1)?.end ?? 0);
      let cursor: PendingCursor;
      if (options.cursor !== undefined) {
        if (
          options.from !== undefined ||
          options.through !== undefined ||
          options.cursor.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(options.cursor)
        )
          fail('CURATOR_ARGUMENT_INVALID');
        try {
          cursor = JSON.parse(
            Buffer.from(options.cursor, 'base64url').toString('utf8'),
          );
        } catch {
          fail('CURATOR_PENDING_CURSOR_INVALID');
        }
        if (
          !cursor ||
          cursor.version !== 1 ||
          cursor.feed !== feedId ||
          cursor.checkpoint !== checkpoint ||
          ![cursor.from, cursor.through, cursor.next, cursor.offset].every(
            Number.isSafeInteger,
          ) ||
          cursor.from < cutoff + 1 ||
          cursor.through < cutoff ||
          cursor.through > rows.length ||
          cursor.from > cursor.through + 1 ||
          cursor.next < cursor.from ||
          cursor.next > cursor.through + 1 ||
          cursor.offset < 0 ||
          cursor.checksum !== (rows[cursor.through - 1]?.checksum ?? '')
        )
          fail('CURATOR_PENDING_CURSOR_STALE');
      } else {
        const from = options.from ?? cutoff + 1;
        const through = options.through ?? rows.length;
        if (
          ![from, through].every(Number.isSafeInteger) ||
          from < cutoff + 1 ||
          through < cutoff ||
          through > rows.length ||
          from > through + 1
        )
          fail('CURATOR_ARGUMENT_INVALID');
        cursor = {
          version: 1,
          feed: feedId,
          checkpoint,
          from,
          through,
          checksum: rows[through - 1]?.checksum ?? '',
          next: from,
          offset: 0,
        };
      }
      const limit = options.limit ?? 5;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
        fail('CURATOR_ARGUMENT_INVALID');
      const items: Array<Record<string, unknown>> = [];
      let next = cursor.next,
        offset = cursor.offset;
      const output = (
        sequence = next,
        textOffset = offset,
        events = items,
      ) => ({
        status: 'ok',
        readOnly: true,
        feed: basename(feed),
        feedId,
        checkpoint,
        cutoff,
        from: cursor.from,
        through: cursor.through,
        latest: rows.length,
        ordering: 'feed-sequence',
        offsetUnit: 'utf16-code-units',
        incompleteTailBytes,
        newerEvents: rows.length - cursor.through,
        complete: sequence > cursor.through,
        pendingComplete:
          sequence > cursor.through &&
          cursor.from === cutoff + 1 &&
          cursor.through === rows.length &&
          incompleteTailBytes === 0,
        events,
        nextCursor:
          sequence <= cursor.through
            ? Buffer.from(
                JSON.stringify({
                  ...cursor,
                  next: sequence,
                  offset: textOffset,
                }),
              ).toString('base64url')
            : null,
      });
      while (next <= cursor.through && items.length < limit) {
        const row = rows[next - 1]!;
        const event = row.event;
        const text = event.text;
        const splitsPair = (at: number) =>
          at > 0 &&
          at < text.length &&
          /[\uD800-\uDBFF]/.test(text[at - 1]!) &&
          /[\uDC00-\uDFFF]/.test(text[at]!);
        if (offset > text.length || splitsPair(offset))
          fail('CURATOR_PENDING_CURSOR_INVALID');
        const fragment = (end: number) => {
          // Feed byte range/checksum retains the full original provenance, including the omitted path.
          const { transcriptPath: _path, ...source } = event.source ?? {};
          return {
            sequence: event.sequence,
            sessionId: event.sessionId,
            turnId: event.turnId,
            type: event.type,
            hook: event.hook,
            capturedAt: event.capturedAt,
            messageId: event.messageId,
            source: event.source ? source : undefined,
            sourcePathOmitted: event.source ? true : undefined,
            checksum: row.checksum,
            sourceBytes: [row.from, row.end],
            textOffset: offset,
            textComplete: end === text.length,
            text: text.slice(offset, end),
          };
        };
        let low = 0,
          high = Math.min(text.length - offset, 16384);
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          let end = offset + middle;
          if (splitsPair(end)) end--;
          const full = end === text.length;
          const candidate = output(full ? next + 1 : next, full ? 0 : end, [
            ...items,
            fragment(end),
          ]);
          if (Buffer.byteLength(JSON.stringify(candidate)) + 1 <= 16384)
            low = middle;
          else high = middle - 1;
        }
        let end = offset + low;
        if (splitsPair(end)) end--;
        if (
          (end === offset && offset < text.length) ||
          Buffer.byteLength(
            JSON.stringify(
              output(
                end === text.length ? next + 1 : next,
                end === text.length ? 0 : end,
                [...items, fragment(end)],
              ),
            ),
          ) +
            1 >
            16384
        ) {
          if (!items.length) fail('CURATOR_PENDING_EVENT_TOO_LARGE');
          break;
        }
        items.push(fragment(end));
        if (end < text.length) {
          offset = end;
          break;
        }
        next++;
        offset = 0;
      }
      if (next > cursor.through && offset !== 0)
        fail('CURATOR_PENDING_CURSOR_INVALID');
      return output();
    } finally {
      await releaseFeed();
    }
  } finally {
    await release?.();
  }
}

/** Withdraw only an uncommitted batch; mandatory apply recovery always runs first. */
export async function abandonCurator(work: string, runId: string) {
  work = await realpath(work);
  if (!/^[a-z0-9-]+$/.test(runId)) fail('CURATOR_ARGUMENT_INVALID');
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { cp, rows } = await stateAt(work);
    const run = await pendingRun(work);
    const receipt = await applyRecord(work);
    if (!run)
      return {
        status: receipt?.runId === runId ? 'already_applied' : 'not_pending',
        through: cp.sequence,
        pending: rows.length - cp.sequence,
      };
    if (run.id !== runId) fail('CURATOR_STALE_BATCH');
    checkRun(cp, rows, run);
    if (run.consent || basename(cp.feed) === 'project.jsonl')
      await checkConsent(work, rows, run);
    // Keep run files and the consumed consent. Flush withdrawal before a new request.
    await unlink(join(work, 'pending.json'));
    await syncDirectory(work);
    return {
      status: 'abandoned',
      run: run.id,
      confirmed: false,
      eventsPreserved: true,
      workMayContinue: true,
      through: cp.sequence,
      pending: rows.length - cp.sequence,
    };
  } finally {
    await release();
  }
}

async function consentAt(work: string): Promise<Consent | undefined> {
  try {
    const c = await json<Consent>(join(work, 'consent.json'));
    if (
      c.version !== 1 ||
      !/^[a-f0-9-]{36}$/.test(c.id) ||
      typeof c.milestone !== 'string' ||
      !c.milestone.trim() ||
      !Number.isSafeInteger(c.anchor) ||
      !Number.isSafeInteger(c.through) ||
      !object(c.base) ||
      typeof c.session !== 'string' ||
      typeof c.turn !== 'string'
    )
      fail('CURATOR_CONSENT_INVALID');
    return c;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail('CURATOR_CONSENT_INVALID');
  }
}

function consentReply(c: Consent, cp: Checkpoint, rows: Row[]) {
  if (
    JSON.stringify(c.base) !== JSON.stringify(cp) ||
    rows[c.anchor - 1]?.checksum !== c.anchorChecksum
  )
    return { status: 'obsolete' as const };
  if (c.consumedBy) return { status: 'consumed' as const };
  const after = rows.slice(c.anchor);
  const question = after.find((r) =>
    ['assistant_final', 'user_message'].includes(r.event.type),
  );
  if (!question) return { status: 'waiting' as const };
  if (
    question.event.type !== 'assistant_final' ||
    question.event.hook !== 'Stop' ||
    question.event.sessionId !== c.session ||
    question.event.turnId !== c.turn ||
    ![checkpointQuestion, '[AXIOM] ' + checkpointQuestion].includes(
      question.event.text.trim(),
    )
  )
    return { status: 'obsolete' as const };
  const reply = rows
    .slice(question.event.sequence)
    .find((r) => r.event.type === 'user_message');
  if (!reply) return { status: 'waiting' as const };
  if (
    reply.event.sessionId !== c.session ||
    reply.event.turnId === c.turn ||
    reply.event.hook !== 'UserPromptSubmit'
  )
    return { status: 'obsolete' as const };
  if (/^no$/iu.test(reply.event.text.trim()))
    return { status: 'declined' as const };
  if (!/^(sì|si)$/iu.test(reply.event.text.trim()))
    return { status: 'ambiguous' as const };
  if (
    rows
      .slice(reply.event.sequence)
      .some((r) => r.event.type === 'user_message')
  )
    return { status: 'obsolete' as const };
  return { status: 'approved' as const, reply };
}

/** Create one identifiable question in the current open user turn. No LLM or feed fabrication. */
export async function requestCurator(work: string, milestone: string) {
  work = await realpath(work);
  if (!milestone.trim() || milestone.length > 256)
    fail('CURATOR_ARGUMENT_INVALID');
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { cp, rows } = await stateAt(work);
    if (await pendingRun(work)) fail('CURATOR_PENDING_EXISTS');
    const current = await consentAt(work);
    if (current && current.milestone === milestone) {
      const { status } = consentReply(current, cp, rows);
      return { status, request: current.id, through: current.through };
    }
    const anchor = rows.at(-1);
    // A consumed approval alone is not a new project milestone, even with a new key.
    // Keep the event pending; require new conversational input before another request.
    if (
      current?.consumedBy &&
      anchor &&
      current.response?.sequence === anchor.event.sequence &&
      current.response.checksum === anchor.checksum
    )
      return { status: 'noop', through: cp.sequence };
    if (
      !anchor ||
      anchor.event.type !== 'user_message' ||
      anchor.event.hook !== 'UserPromptSubmit'
    )
      fail('CURATOR_CONSENT_OPEN_TURN_REQUIRED');
    const through =
      [...rows].reverse().find((r) => r.event.type === 'assistant_final')?.event
        .sequence ?? cp.sequence;
    if (through <= cp.sequence) return { status: 'noop', through: cp.sequence };
    // One consent authority per source feed: another --work cannot reuse its reply.
    const releaseFeed = await acquireJournalLock(cp.feed + '.lock');
    try {
      let owner: { work: string };
      try {
        owner = await json(cp.feed + '.curator.json');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        owner = { work };
        await atomicJson(cp.feed + '.curator.json', owner);
      }
      if (owner.work !== work) fail('CURATOR_WORKSPACE_CONFLICT');
    } finally {
      await releaseFeed();
    }
    const c: Consent = {
      version: 1,
      id: randomUUID(),
      milestone,
      base: cp,
      through,
      anchor: anchor.event.sequence,
      anchorChecksum: anchor.checksum,
      session: anchor.event.sessionId,
      turn: anchor.event.turnId,
    };
    await atomicJson(join(work, 'consent.json'), c);
    return {
      status: 'requested',
      request: c.id,
      through,
      question: checkpointQuestion,
    };
  } finally {
    await release();
  }
}

async function checkConsent(work: string, rows: Row[], run: Run) {
  const c = await consentAt(work);
  const approval = run.consent;
  if (!c || !approval) fail('CURATOR_CONSENT_REQUIRED');
  const owner = await json<{ work: string }>(run.base.feed + '.curator.json');
  if (owner.work !== work) fail('CURATOR_WORKSPACE_CONFLICT');
  if (
    !c ||
    !approval ||
    c.id !== approval.request ||
    c.consumedBy !== run.id ||
    JSON.stringify(c.base) !== JSON.stringify(run.base) ||
    c.through !== run.last.event.sequence ||
    c.response?.sequence !== approval.sequence ||
    c.response?.checksum !== approval.checksum ||
    rows[approval.sequence - 1]?.checksum !== approval.checksum ||
    consentReply(
      { ...c, consumedBy: undefined },
      run.base,
      rows.slice(0, approval.sequence),
    ).status !== 'approved'
  )
    fail('CURATOR_CONSENT_REQUIRED');
}

/** Start a new workspace from an explicitly reviewed canonical memory and cutoff. */
export async function initCurator(
  work: string,
  memory: string,
  feed: string,
  through: number,
) {
  work = resolve(work);
  memory = await realpath(memory);
  feed = await realpath(feed);
  if (inside(memory, work) || inside(work, memory)) fail('CURATOR_UNSAFE_PATH');
  const rows = await feedRows(feed),
    row = rows[through - 1];
  if (!Number.isSafeInteger(through) || through < 0 || (through > 0 && !row))
    fail('CURATOR_CHECKPOINT_INVALID');
  const original = await withConfirmedMemory(memory, () => treeAt(memory));
  // S3's untouched empty seed carries the same zero-event meaning. Preserve the
  // seed on disk; only the new curator workspace receives the current empty form.
  const baseline =
    through === 0 &&
    Object.keys(original).length === 2 &&
    original['HISTORY.md'] === emptyMemory['HISTORY.md'] &&
    original['STATE.md'] ===
      '# Stato iniziale\n\nNessun evento e ancora rappresentato da un checkpoint curator.\n'
      ? emptyMemory
      : original;
  if (through === 0 && digest(baseline) !== digest(emptyMemory))
    fail('CURATOR_CHECKPOINT_INVALID');
  await validateTree(
    baseline,
    memory,
    externalLinks(original, memory),
    rows,
    through,
    feed,
  );
  await mkdir(work);
  work = await realpath(work);
  const target = join(work, 'memory'),
    rebased = rebase(baseline, memory, target);
  await putTree(target, rebased);
  await syncTree(target, rebased);
  await syncPath(feed);
  await syncDirectory(dirname(feed));
  await syncDirectory(dirname(work));
  await atomicJson(join(work, 'checkpoint.json'), {
    version: 2,
    feed,
    sessionId: row?.event.sessionId ?? '',
    sequence: through,
    checksum: row?.checksum ?? '',
    memoryHash: digest(rebased),
  } satisfies Checkpoint);
  return { status: 'initialized', through, memory: target };
}

/** Freeze the pending feed window; later arrivals belong to the next materialization. */
export async function prepareCurator(
  work: string,
  directiveFile: string,
  options: {
    through?: number;
    context?: string[];
    artifacts?: string[];
    request?: string;
    requireConsent?: boolean;
  } = {},
) {
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { cp, rows, memory } = await stateAt(work);
    const pending = await pendingRun(work);
    const required =
      options.requireConsent || basename(cp.feed) === 'project.jsonl';
    const consent = required ? await consentAt(work) : undefined;
    if (required && (!consent || consent.id !== options.request))
      fail('CURATOR_CONSENT_REQUIRED');
    if (required && !pending && consent?.consumedBy)
      fail('CURATOR_CONSENT_REQUIRED');
    const through = options.through ?? consent?.through ?? rows.length;
    if (
      !Number.isSafeInteger(through) ||
      through < cp.sequence ||
      through > rows.length
    )
      fail('CURATOR_ARGUMENT_INVALID');
    const selected = rows.slice(cp.sequence, through);
    if (!pending && !selected.length)
      return { status: 'noop', through: cp.sequence };
    const directive = await readFile(directiveFile, 'utf8');
    if (!directive.trim()) fail('CURATOR_DIRECTIVE_REQUIRED');
    const context = [...new Set(options.context ?? [])];
    if (
      context.some(
        (n) => !n.startsWith('knowledge/') || !allowed(n) || !memory[n],
      )
    )
      fail('CURATOR_CONTEXT_INVALID');
    const external = [
      ...new Set([
        cp.feed,
        ...externalLinks(memory, join(work, 'memory')),
        ...(await Promise.all(
          (options.artifacts ?? []).map((p) => realpath(p)),
        )),
      ]),
    ];
    for (const p of external)
      if (!(await stat(p)).isFile()) fail('CURATOR_LINK_INVALID');
    if (pending) {
      if (required) await checkConsent(work, rows, pending);
      checkRun(cp, rows, pending);
      if (
        directive !== pending.directive ||
        JSON.stringify(context) !== JSON.stringify(pending.context) ||
        JSON.stringify(external) !== JSON.stringify(pending.external) ||
        (options.through !== undefined &&
          through !== pending.last.event.sequence)
      )
        fail('CURATOR_PENDING_EXISTS');
      const run = join(work, 'runs', pending.id);
      return { status: 'prepared', run, proposal: join(run, 'proposal.json') };
    }
    const last = selected.at(-1)!;
    const id = `${cp.sequence + 1}-${last.event.sequence}-${randomUUID()}`;
    const dir = join(work, 'runs', id),
      base = join(dir, 'base');
    const run: Run = { id, base: cp, last, context, external, directive };
    if (required) {
      const decision = consentReply(consent!, cp, rows);
      if (decision.status !== 'approved' || consent!.through !== through)
        fail('CURATOR_CONSENT_REQUIRED');
      run.consent = {
        request: consent!.id,
        sequence: decision.reply.event.sequence,
        checksum: decision.reply.checksum,
      };
      // Burn the grant before staging/delegation. Failure never re-enables it.
      await atomicJson(join(work, 'consent.json'), {
        ...consent!,
        consumedBy: id,
        response: {
          sequence: decision.reply.event.sequence,
          checksum: decision.reply.checksum,
        },
      });
    }
    await putTree(base, rebase(memory, join(work, 'memory'), base));
    const baseTree = await treeAt(base);
    const projected = projectFeedEvents(selected.map((r) => r.event));
    const rowBySequence = new Map(selected.map((r) => [r.event.sequence, r]));
    const ordered = projected.events.map((e) => rowBySequence.get(e.sequence)!);
    const priorTurns = new Set(
      rows
        .slice(0, cp.sequence)
        .map((r) => JSON.stringify([r.event.sessionId, r.event.turnId])),
    );
    const orderingIssues = [
      ...projected.issues,
      ...(selected.some((r) =>
        priorTurns.has(JSON.stringify([r.event.sessionId, r.event.turnId])),
      )
        ? ['TURN_PARTIALLY_MATERIALIZED']
        : []),
    ];
    const packet = {
      sessionId: cp.sessionId,
      from: cp.sequence + 1,
      through: last.event.sequence,
      directive,
      context: Object.fromEntries(
        ['STATE.md', ...context].map((n) => [n, baseTree[n]!]),
      ),
      orderingIssues,
      events: ordered.map((r) => ({
        ...r.event,
        checksum: r.checksum,
        sourceBytes: [r.from, r.end],
      })),
      nextHistoryId:
        'H' +
        String(
          historySegments(memory['HISTORY.md']!, cp.sequence).length + 1,
        ).padStart(6, '0'),
      feed: relative(base, cp.feed)
        .split(sep)
        .map(encodeURIComponent)
        .join('/'),
      artifacts: external.map((p) =>
        relative(base, p).split(sep).map(encodeURIComponent).join('/'),
      ),
    };
    await writeFile(
      join(dir, 'packet.json'),
      JSON.stringify(packet, null, 2) + '\n',
      { mode: 0o600 },
    );
    const window =
      (orderingIssues.length
        ? `Avvisi ordine: ${orderingIssues.join(', ')}\n\n`
        : '') +
      ordered
        .map(
          (r) =>
            `## E${String(r.event.sequence).padStart(3, '0')} — ${r.event.type}\n\n` +
            `Sessione: ${r.event.sessionId}; turno: ${r.event.turnId}.\n\n${r.event.text}\n`,
        )
        .join('\n');
    await writeFile(join(dir, 'WINDOW.md'), window, { mode: 0o600 });
    await writeFile(
      join(dir, 'SKILL.md'),
      (
        await readFile(
          new URL(
            '../.agents/skills/knownex-curator/SKILL.md',
            import.meta.url,
          ),
          'utf8',
        )
      ).replaceAll('../../../docs/MEMORY-CONTRACT.md', 'MEMORY-CONTRACT.md'),
    );
    await writeFile(
      join(dir, 'MEMORY-CONTRACT.md'),
      await readFile(new URL('../docs/MEMORY-CONTRACT.md', import.meta.url)),
    );
    await atomicJson(join(dir, 'run.json'), run);
    await syncDirectory(join(work, 'runs'));
    await syncDirectory(work);
    await atomicJson(join(work, 'pending.json'), { id });
    return {
      status: 'prepared',
      run: dir,
      proposal: join(dir, 'proposal.json'),
    };
  } finally {
    await release();
  }
}

function materialize(
  memory: Tree,
  run: Run,
  proposal: Proposal,
  target: string,
  dir: string,
) {
  const cp = run.base;
  const next: Tree = { ...memory };
  if (proposal.action === 'update') {
    next['STATE.md'] = rebase(
      { 'STATE.md': proposal.state },
      join(dir, 'base'),
      target,
    )['STATE.md']!;
    for (const [name, text] of Object.entries(proposal.knowledge)) {
      if (
        !name.startsWith('knowledge/') ||
        !allowed(name) ||
        typeof text !== 'string'
      )
        fail('CURATOR_UNSAFE_PATH');
      if (memory[name] && !run.context.includes(name))
        fail('CURATOR_CONTEXT_INVALID');
      next[name] = rebase({ [name]: text }, join(dir, 'base'), target)[name]!;
    }
    if (digest(next) === digest(memory)) fail('CURATOR_EMPTY_UPDATE');
    const transition = rebase(
      { 'HISTORY.md': proposal.history.transition },
      join(dir, 'base'),
      target,
    )['HISTORY.md']!;
    next['HISTORY.md'] =
      memory['HISTORY.md']! +
      historyAppendix(
        memory['HISTORY.md']!,
        memory['STATE.md']!,
        cp.sequence + 1,
        run.last.event.sequence,
        run.last.event.capturedAt,
        relative(target, cp.feed).split(sep).map(encodeURIComponent).join('/'),
        { ...proposal.history, transition },
      );
  }
  return next;
}

export async function validateCurator(work: string) {
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { cp, rows, memory } = await stateAt(work),
      run = await pendingRun(work);
    if (!run) fail('CURATOR_NO_PENDING');
    checkRun(cp, rows, run);
    const dir = join(work, 'runs', run.id),
      raw: unknown = await json(join(dir, 'proposal.json'));
    if (!object(raw) || !['update', 'noop'].includes(raw.action as string))
      fail('CURATOR_PROPOSAL_INVALID');
    const keys =
      raw.action === 'noop'
        ? ['action']
        : ['action', 'state', 'history', 'knowledge'];
    if (
      Object.keys(raw).length !== keys.length ||
      Object.keys(raw).some((k) => !keys.includes(k))
    )
      fail('CURATOR_PROPOSAL_INVALID');
    if (
      raw.action === 'update' &&
      (typeof raw.state !== 'string' ||
        !object(raw.knowledge) ||
        !object(raw.history) ||
        typeof raw.history.transition !== 'string')
    )
      fail('CURATOR_PROPOSAL_INVALID');
    const proposal = raw as unknown as Proposal;
    const target = join(work, 'memory'),
      candidate = join(dir, 'candidate-' + randomUUID());
    const next = materialize(memory, run, proposal, target, dir);
    validateKnowledgeEvolution(memory, next);
    await validateTree(
      next,
      target,
      run.external,
      rows,
      run.last.event.sequence,
      cp.feed,
    );
    await putTree(candidate, rebase(next, target, candidate));
    const staged = await treeAt(candidate),
      treeHash = digest(staged);
    const seal = sha(JSON.stringify({ run, proposal, tree: treeHash }));
    await atomicJson(join(dir, 'validated.json'), {
      seal,
      candidate,
      treeHash,
      action: proposal.action,
    });
    return {
      status: 'validated',
      seal,
      candidate,
      through: run.last.event.sequence,
      action: proposal.action,
    };
  } finally {
    await release();
  }
}

/** Persist authorization before promoting any confirmed file; recovery needs no proposal. */
export async function applyCurator(
  work: string,
  seal: string,
  requireConsent = false,
) {
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { cp, rows, memory } = await stateAt(work),
      run = await pendingRun(work);
    const receipt = await applyRecord(work);
    if (
      receipt?.seal === seal &&
      cp.memoryHash === receipt.after.memoryHash &&
      cp.sequence === receipt.after.sequence
    )
      return {
        status: 'applied',
        through: cp.sequence,
        action: receipt.action,
      };
    if (!run) fail('CURATOR_NO_PENDING');
    if (requireConsent || basename(cp.feed) === 'project.jsonl')
      await checkConsent(work, rows, run);
    const dir = join(work, 'runs', run.id);
    const approval = await json<{
      seal: string;
      candidate: string;
      treeHash: string;
      action: string;
    }>(join(dir, 'validated.json'));
    if (approval.seal !== seal || !inside(dir, approval.candidate))
      fail('CURATOR_CONFIRMATION_REQUIRED');
    const staged = await treeAt(approval.candidate),
      proposal = await json<Proposal>(join(dir, 'proposal.json'));
    if (
      digest(staged) !== approval.treeHash ||
      sha(JSON.stringify({ run, proposal, tree: digest(staged) })) !== seal
    )
      fail('CURATOR_STAGE_CHANGED');
    checkRun(cp, rows, run);
    const target = join(work, 'memory'),
      next = materialize(memory, run, proposal, target, dir);
    if (digest(rebase(next, target, approval.candidate)) !== approval.treeHash)
      fail('CURATOR_STAGE_CHANGED');
    if (!next['HISTORY.md']!.startsWith(memory['HISTORY.md']!))
      fail('CURATOR_HISTORY_CHANGED');
    await validateTree(
      next,
      target,
      run.external,
      rows,
      run.last.event.sequence,
      cp.feed,
    );
    const checkpoint: Checkpoint = {
      ...cp,
      sessionId: run.last.event.sessionId,
      sequence: run.last.event.sequence,
      checksum: run.last.checksum,
      memoryHash: digest(next),
    };
    // Establish the stable baseline and the inputs that recovery will need.
    // Staging/base trees are not recovery inputs: the record contains both trees.
    await syncTree(target, memory);
    await syncPath(join(work, 'checkpoint.json'));
    await syncPath(join(dir, 'run.json'));
    await syncDirectory(dir);
    await syncDirectory(join(work, 'runs'));
    await syncPath(cp.feed);
    await syncDirectory(dirname(cp.feed));
    await syncDirectory(work);
    await syncDirectory(dirname(work));
    const record: ApplyRecord = {
      version: 1,
      runId: run.id,
      seal,
      action: approval.action,
      before: cp,
      after: checkpoint,
      previous: memory,
      next,
    };
    await atomicJson(join(work, 'apply.json'), {
      record,
      checksum: sha(JSON.stringify(record)),
    });
    await recoverApply(work);
    return {
      status: 'applied',
      through: checkpoint.sequence,
      action: approval.action,
    };
  } finally {
    await release();
  }
}
