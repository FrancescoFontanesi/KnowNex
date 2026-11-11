import {
  decodeUtf8,
  readUtf8,
  jsonText,
  transportJson,
  sha256,
  writeFile,
  writeAtomicText,
  syncPath,
  syncDirectory,
} from './artifact-io.ts';
import {
  canonicalWork,
  memoryDirectory,
  workFromMemory,
  revisionDirectory,
  organizationFile,
  workspaceFromFeed,
} from './layout.ts';
import { activeKnowledge } from './knowledge-revisions.ts';
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
  checkOrganization,
  organizationText,
  thematicCatalog,
  thematicData,
  thematicHash,
  taxonomyProposal,
  thematicIndexes,
  type OrganizationPlan,
} from './taxonomy.ts';
import {
  archivePath,
  checkPublications,
  checkRevisionPublication,
  checkVersionState,
  finishVersions,
  planVersions,
  revisionLinks,
  revisionFile,
  verifyVersionState,
  resolveVersionLink,
  type KnowledgeVersions,
  type RevisionPublication,
} from './knowledge-revisions.ts';
import {
  parseNoteIdentity,
  validateKnowledge,
  validateKnowledgeEvolution,
} from './memory-contract.ts';
import { historySegments, historyWindow, type Transition } from './history.ts';
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
  version: 2 | 3;
  feed: string;
  sessionId: string;
  sequence: number;
  checksum: string;
  memoryHash: string;
  excluded?: number[];
  nativeHistory?: true;
  knowledgeVersions?: KnowledgeVersions;
}
interface Run {
  autonomous?: true;
  inputManifestSha256?: string;
  revisionLayout?: 1;
  taxonomy?: Record<string, string>;
  id: string;
  base: Checkpoint;
  last: Row;
  context: string[];
  external: string[];
  directive: string;
  excluded?: number[];
  nativeHistory?: true;
}
interface FeedAuthority {
  work: string;
}
type Proposal =
  | { action: 'noop' }
  | {
      action: 'update';
      state: string;
      history: Transition;
      knowledge: Tree;
      categories?: Record<string, string>;
    };
const sha = sha256;
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const allowed = (name: string) =>
  /^(?:(?:STATE|HISTORY)\.md|knowledge\/[a-z0-9-]+\.md|history\/H\d{6,}\.md)$/.test(
    name,
  );
/** Links written for the memory root, moved one level down into history/. */
const intoHistory = (text: string) =>
  text.replace(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, label, href) =>
    /^(?:[a-z]+:|#)/i.test(href) ? whole : `[${label}](../${href})`,
  );
const inside = (root: string, target: string) => {
  const r = relative(root, target);
  return (
    r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep))
  );
};
const json = async <T>(p: string): Promise<T> =>
  JSON.parse(decodeUtf8(await readFile(p))) as T;
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

async function treeAt(
  root: string,
  complete = true,
  versions?: KnowledgeVersions,
): Promise<Tree> {
  const canonical = workFromMemory(root);
  if (canonicalWork(canonical) && memoryDirectory(canonical) === root) {
    if (
      (await lstat(root)).isSymbolicLink() ||
      (await realpath(root)) !== resolve(root)
    )
      fail('CURATOR_UNSAFE_PATH');
    if (versions === undefined) {
      try {
        versions = (await json<Checkpoint>(join(canonical, 'checkpoint.json')))
          .knowledgeVersions;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    const result = await activeKnowledge(canonical, versions);
    for (const name of ['STATE.md', 'HISTORY.md']) {
      try {
        const file = join(root, name);
        if ((await lstat(file)).isSymbolicLink()) fail('CURATOR_UNSAFE_PATH');
        result[name] = await readUtf8(file);
      } catch (e) {
        if (complete || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    let windows: string[] = [];
    try {
      if ((await lstat(join(root, 'history'))).isSymbolicLink())
        fail('CURATOR_UNSAFE_PATH');
      windows = await readdir(join(root, 'history'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const file of windows) {
      const name = 'history/' + file;
      if (!allowed(name) || (await lstat(join(root, name))).isSymbolicLink())
        fail('CURATOR_UNSAFE_PATH');
      result[name] = await readUtf8(join(root, name));
    }
    return result;
  }
  const tree: Tree = {};
  async function walk(folder: string) {
    if ((await lstat(folder)).isSymbolicLink()) fail('CURATOR_UNSAFE_PATH');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const p = join(folder, entry.name),
        name = relative(root, p).split(sep).join('/');
      if (entry.isSymbolicLink()) fail('CURATOR_UNSAFE_PATH');
      if (entry.isDirectory()) {
        if (name !== 'knowledge' && name !== 'history')
          fail('CURATOR_UNSAFE_PATH');
        await walk(p);
      } else {
        if (!entry.isFile() || !allowed(name)) fail('CURATOR_UNSAFE_PATH');
        tree[name] = await readUtf8(p);
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
          if (
            inside(from, target) &&
            allowed(relative(from, target).split(sep).join('/'))
          )
            return whole;
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
  for (let end; (end = bytes.indexOf(10, from)) !== -1; from = end + 1) {
    try {
      const f = JSON.parse(decodeUtf8(bytes.subarray(from, end), true));
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

function validExclusions(value: unknown, through: number) {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (n, i) =>
          Number.isSafeInteger(n) &&
          n > 0 &&
          n <= through &&
          (i === 0 || n > value[i - 1]),
      ))
  );
}

/** Preserve historical decisions without consulting or reconstructing native history. */
function recordedExclusions(cp?: Checkpoint) {
  return new Set(cp?.excluded ?? []);
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
  excluded: number[] = [],
  publications: RevisionPublication[] = [],
  versionState?: KnowledgeVersions,
) {
  const planned = new Map(
    publications
      .filter((p) => p.file.endsWith('.md'))
      .map((p) => [archivePath(workFromMemory(root), p.file), p.content]),
  );
  validateKnowledge(tree);
  if (
    !/^#\s+\S/m.test(tree['STATE.md']!) ||
    /knownex-history:/.test(tree['STATE.md']!)
  )
    fail('CURATOR_STATE_INVALID');
  const windows = historySegments(tree['HISTORY.md']!, cutoff).flatMap((s) =>
    s.window ? [s.window] : [],
  );
  // Index and windows match one to one: no orphan window, no indexed window missing.
  const stored = Object.keys(tree).filter((n) => n.startsWith('history/'));
  if (
    stored.length !== windows.length ||
    windows.some((n) => !Object.hasOwn(tree, n))
  )
    fail('CURATOR_HISTORY_INVALID');
  for (const name of ['HISTORY.md', ...windows])
    for (const field of tree[name]!.matchAll(/^- Eventi: `([^`]+)`$/gm))
      validateEventLabel(field[1]!, rows, cutoff);
  for (const [name, text] of Object.entries(tree)) {
    let provenance = false;
    // Provenance is a bracketed event label: bare [E017] / [E015–E016], or a legacy link to the feed.
    const cite = (label: string) => {
      validateEventLabel(label, rows, cutoff);
      if (name !== 'HISTORY.md') {
        const range = label.match(/^E(\d+)(?:\s*(?:\.\.|[–-])\s*E(\d+))?$/);
        if (
          range &&
          excluded.some(
            (n) => n >= Number(range[1]) && n <= Number(range[2] ?? range[1]),
          )
        )
          fail('CURATOR_PROVENANCE_INVALID');
      }
      provenance = true;
    };
    // Anything bracketed that starts like a label is one, so a malformed [E1] is refused, not ignored.
    for (const m of text.matchAll(/\[(E\d[^\]]*)\](?!\()/g)) cite(m[1]!);
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
      const key = relative(root, target).split(sep).join('/'),
        internal = inside(root, target) && Object.hasOwn(tree, key);
      const versionContent =
        !internal && !external.includes(target) && !planned.has(target)
          ? await resolveVersionLink(
              workFromMemory(root),
              target,
              versionState,
              publications,
            )
          : undefined;
      if (
        internal
          ? !Object.hasOwn(tree, key)
          : !external.includes(target) &&
            !planned.has(target) &&
            versionContent === undefined
      )
        fail('CURATOR_LINK_INVALID');
      if (
        !internal &&
        !planned.has(target) &&
        versionContent === undefined &&
        !(await stat(target)).isFile()
      )
        fail('CURATOR_LINK_INVALID');
      if (
        /^E\d{3,}(?:\s*(?:\.\.|[–-])\s*E\d{3,})?$/.test(label) &&
        target !== feed
      )
        fail('CURATOR_PROVENANCE_INVALID');
      if (target === feed) {
        if (anchor) fail('CURATOR_PROVENANCE_INVALID');
        cite(label);
      }
      if (anchor) {
        const body = internal
          ? tree[key]!
          : (versionContent ?? planned.get(target) ?? (await readUtf8(target)));
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
  await atomicText(file, jsonText(value, 2) + '\n');
}

const atomicText = writeAtomicText;

/** Flush child entries before their parent and before publishing a checkpoint. */
async function syncTree(
  root: string,
  tree: Tree,
  versions?: KnowledgeVersions,
) {
  const work = workFromMemory(root);
  if (canonicalWork(work) && memoryDirectory(work) === root) {
    for (const name of ['STATE.md', 'HISTORY.md'])
      await syncPath(join(root, name));
    const windows = Object.keys(tree).filter((n) => n.startsWith('history/'));
    for (const name of windows) await syncPath(join(root, name));
    if (windows.length) await syncDirectory(join(root, 'history'));
    for (const ref of Object.values(versions?.heads ?? {})) {
      const file = archivePath(work, revisionFile(ref));
      await syncPath(file);
      let directory = dirname(file);
      while (inside(root, directory) && directory !== root) {
        await syncDirectory(directory);
        directory = dirname(directory);
      }
    }
    await syncDirectory(root);
    await syncDirectory(dirname(root));
    return;
  }
  for (const name of Object.keys(tree)) await syncPath(join(root, name));
  for (const folder of ['knowledge', 'history'])
    if (Object.keys(tree).some((name) => name.startsWith(folder + '/')))
      await syncDirectory(join(root, folder));
  await syncDirectory(root);
  await syncDirectory(dirname(root));
}

interface ApplyRecord {
  version: 1 | 2 | 3;
  runId: string;
  seal: string;
  action: string;
  before: Checkpoint;
  after: Checkpoint;
  previous: Tree;
  next: Tree;
  revisionFiles?: RevisionPublication[];
  organization?: OrganizationPlan;
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
  if (r.version === 3) {
    try {
      checkOrganization(r.organization);
      if (
        r.action !== r.organization.mode ||
        !/^t-[a-f0-9]{64}$/.test(r.runId) ||
        !/^[a-f0-9]{64}$/.test(r.seal) ||
        !object(r.before) ||
        ![2, 3].includes(r.before.version) ||
        JSON.stringify(r.before) !== JSON.stringify(r.after) ||
        !object(r.previous) ||
        Object.keys(r.previous).length ||
        !object(r.next) ||
        Object.keys(r.next).length ||
        r.revisionFiles !== undefined
      )
        fail('CURATOR_RECOVERY_INVALID');
      if (r.organization.mode === 'taxonomy') {
        const data = JSON.parse(
          r.organization.next['taxonomy-associations.json']!,
        );
        const receipt = JSON.parse(
          r.organization.next['taxonomy-changes/' + r.runId + '.json']!,
        );
        if (
          data.receipt.id !== r.runId ||
          receipt.id !== r.runId ||
          receipt.seal !== r.seal
        )
          fail('CURATOR_RECOVERY_INVALID');
      }
    } catch {
      fail('CURATOR_RECOVERY_INVALID');
    }
    return r;
  }
  if (
    r.organization !== undefined ||
    ![1, 2].includes(r.version) ||
    typeof r.runId !== 'string' ||
    !/^[a-z0-9-]+$/.test(r.runId) ||
    typeof r.seal !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.seal) ||
    !['noop', 'update'].includes(r.action) ||
    !object(r.before) ||
    !object(r.after) ||
    ![2, 3].includes(r.before.version) ||
    !Number.isSafeInteger(r.before.sequence) ||
    r.before.sequence < 0 ||
    !validExclusions(r.before.excluded, r.before.sequence) ||
    !validExclusions(r.after.excluded, r.after.sequence) ||
    (r.before.excluded ?? []).some((n) => !r.after.excluded?.includes(n)) ||
    (r.before.nativeHistory !== undefined && r.before.nativeHistory !== true) ||
    (r.after.nativeHistory !== undefined && r.after.nativeHistory !== true) ||
    (r.before.nativeHistory === true && r.after.nativeHistory !== true) ||
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
        version: r.after.version,
        sessionId: r.after.sessionId,
        sequence: r.after.sequence,
        checksum: r.after.checksum,
        memoryHash: digest(r.next),
        ...(r.after.knowledgeVersions
          ? { knowledgeVersions: r.after.knowledgeVersions }
          : {}),
        ...(r.after.excluded ? { excluded: r.after.excluded } : {}),
        ...(r.after.nativeHistory ? { nativeHistory: true } : {}),
      }) ||
    Object.keys(r.previous).some((name) => !Object.hasOwn(r.next, name)) ||
    !r.next['HISTORY.md']!.startsWith(r.previous['HISTORY.md']!)
  )
    fail('CURATOR_RECOVERY_INVALID');
  if (r.version === 1) {
    if (
      r.before.version !== 2 ||
      r.after.version !== 2 ||
      r.revisionFiles !== undefined ||
      r.after.knowledgeVersions !== undefined
    )
      fail('CURATOR_RECOVERY_INVALID');
  } else {
    if (r.after.version !== 3) fail('CURATOR_RECOVERY_INVALID');
    checkVersionState(r.after.knowledgeVersions, r.after.sequence);
    checkPublications(r.revisionFiles);
    if (r.before.version === 3)
      checkVersionState(r.before.knowledgeVersions, r.before.sequence);
  }
  return r;
}
async function organizationComplete(work: string, plan: OrganizationPlan) {
  for (const [name, text] of Object.entries(plan.next))
    if ((await organizationText(work, name)) !== text) return false;
  return true;
}

/** The checkpoint commits the generation. Keep the last intent as a replay receipt. */
async function recoverApply(work: string) {
  const r = await applyRecord(work);
  if (!r) return;
  if (r.organization) {
    const cp = await json<Checkpoint>(join(work, 'checkpoint.json'));
    if (
      JSON.stringify(cp) !== JSON.stringify(r.before) ||
      digest(await treeAt(memoryDirectory(work))) !== cp.memoryHash
    )
      fail('CURATOR_RECOVERY_INVALID');
    for (const [name, next] of Object.entries(r.organization.next)) {
      const current = await organizationText(work, name);
      if (
        current !== r.organization.previous[name] &&
        current !== next &&
        !name.startsWith('topics/')
      )
        fail('TAXONOMY_COLLISION');
    }
    await syncPath(join(work, 'apply.json'));
    await syncDirectory(work);
    const names = Object.keys(r.organization.next).sort((a, b) => {
      const priority = (s: string) =>
        s.startsWith('taxonomy-changes/')
          ? 0
          : s === 'taxonomy.json'
            ? 1
            : s === 'taxonomy-associations.json'
              ? 3
              : 2;
      return priority(a) - priority(b) || a.localeCompare(b, 'en');
    });
    for (const name of names) {
      if (name.includes('/')) {
        const folder = dirname(organizationFile(work, name));
        try {
          await mkdir(folder);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        if (
          (await lstat(folder)).isSymbolicLink() ||
          !(await lstat(folder)).isDirectory() ||
          (await realpath(folder)) !== resolve(folder)
        )
          fail('TAXONOMY_PATH_INVALID');
        await syncDirectory(folder);
        await syncDirectory(work);
      }
      const next = r.organization.next[name]!;
      if ((await organizationText(work, name)) !== next)
        await atomicText(organizationFile(work, name), next, work);
      else await syncPath(organizationFile(work, name));
      await syncDirectory(dirname(organizationFile(work, name)));
    }
    await thematicData(work);
    return r;
  }
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
  const target = memoryDirectory(work),
    current = await treeAt(
      target,
      false,
      (committed ? r.after : r.before).knowledgeVersions,
    );
  if (committed) {
    if (digest(current) !== r.after.memoryHash) fail('CURATOR_MEMORY_CHANGED');
    for (const p of r.revisionFiles ?? [])
      await checkRevisionPublication(work, p, true);
    if (r.after.knowledgeVersions)
      await verifyVersionState(
        work,
        current,
        r.after.knowledgeVersions,
        r.after.sequence,
        r.after.memoryHash,
      );
    await syncTree(target, r.next, r.after.knowledgeVersions);
  } else {
    // Every visible file is a complete old or new version: promotion uses rename.
    if (
      Object.entries(current).some(
        ([name, text]) => text !== r.previous[name] && text !== r.next[name],
      )
    )
      fail('CURATOR_RECOVERY_INVALID');
    // run.json/pending.json are durably established before publication.
    const run = await json<Run>(join(work, 'runs', r.runId, 'run.json'));
    if (run.id !== r.runId) fail('CURATOR_RECOVERY_INVALID');
    const rows = await feedRows(r.before.feed);
    checkRun(r.before, rows, run);
    const expectedExcluded = [
      ...new Set([...(r.before.excluded ?? []), ...(run.excluded ?? [])]),
    ].sort((a, b) => a - b);
    if (
      JSON.stringify(r.after.excluded ?? []) !==
      JSON.stringify(expectedExcluded)
    )
      fail('CURATOR_RECOVERY_INVALID');
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
      [...(run.base.excluded ?? []), ...(run.excluded ?? [])],
      r.revisionFiles,
      r.after.knowledgeVersions,
    );
    if (r.revisionFiles?.length) {
      for (const p of r.revisionFiles) {
        const path = archivePath(work, p.file);
        // Persist each new namespace component before the checkpoint can advance.
        const archiveRoot = revisionDirectory(work, p.file);
        let directory = dirname(archiveRoot);
        for (const component of [
          basename(archiveRoot),
          ...p.file.split('/').slice(0, -1),
        ]) {
          directory = join(directory, component);
          try {
            await mkdir(directory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          if (
            (await lstat(directory)).isSymbolicLink() ||
            !(await lstat(directory)).isDirectory() ||
            (await realpath(directory)) !== resolve(directory)
          )
            fail('KNOWLEDGE_ARCHIVE_UNSAFE');
          await syncDirectory(directory);
          await syncDirectory(dirname(directory));
        }
        if (!(await checkRevisionPublication(work, p)))
          await atomicText(path, p.content, work);
        else await syncPath(path);
        await syncDirectory(dirname(path));
      }
      await syncDirectory(join(work, 'revisions'));
      await syncDirectory(work);
    }
    for (const [name, text] of Object.entries(r.next)) {
      if (canonicalWork(work) && name.startsWith('knowledge/')) continue;
      if (current[name] === text) continue;
      await mkdir(dirname(join(target, name)), { recursive: true });
      await atomicText(join(target, name), text, work);
    }
    if (
      digest(await treeAt(target, true, r.after.knowledgeVersions)) !==
      r.after.memoryHash
    )
      fail('CURATOR_RECOVERY_INVALID');
    if (r.after.knowledgeVersions)
      await verifyVersionState(
        work,
        r.next,
        r.after.knowledgeVersions,
        r.after.sequence,
        r.after.memoryHash,
      );
    // Files already equal to `next` may have survived an unflushed rename.
    // Re-flush every entry, including the knowledge directory's own name.
    await syncTree(target, r.next, r.after.knowledgeVersions);
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
  read: (view?: {
    work: string;
    versions?: KnowledgeVersions;
    through: number;
  }) => Promise<T>,
): Promise<T> {
  if (basename(root) !== 'memory') return read();
  const work = workFromMemory(root);
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
    const state = await stateAt(work);
    return await read({
      work,
      versions: state.cp.knowledgeVersions,
      through: state.cp.sequence,
    });
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
        (await pendingRun(work))?.id === receipt.runId ||
        (receipt.organization &&
          !(await organizationComplete(work, receipt.organization))))
    )
      fail('CURATOR_RECOVERY_REQUIRED');
  }
  if (
    ![2, 3].includes(cp.version) ||
    !Number.isSafeInteger(cp.sequence) ||
    cp.sequence < 0
  )
    fail('CURATOR_CHECKPOINT_INVALID');
  if (
    !validExclusions(cp.excluded, cp.sequence) ||
    (cp.nativeHistory !== undefined && cp.nativeHistory !== true)
  )
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
  const memory = await treeAt(memoryDirectory(work));
  if (cp.sequence === 0 && digest(memory) !== digest(emptyMemory))
    fail('CURATOR_CHECKPOINT_INVALID');
  if (digest(memory) !== cp.memoryHash) fail('CURATOR_MEMORY_CHANGED');
  if (cp.version === 3)
    await verifyVersionState(
      work,
      memory,
      cp.knowledgeVersions!,
      cp.sequence,
      cp.memoryHash,
    );
  else if (cp.knowledgeVersions !== undefined)
    fail('CURATOR_CHECKPOINT_INVALID');
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
    const excluded = recordedExclusions(state?.cp);
    const run = initialized ? await pendingRun(work) : undefined;
    if (state) await authorityAt(work, state.cp.feed);
    const administrative = administrativeTurns(rows, feed);
    if (run && state) checkRun(state.cp, rows, run);
    return {
      initialized,
      through,
      ...pendingCounts(rows, through, administrative, excluded),
      latest: rows.length,
      readyThrough:
        rows
          .slice(through)
          .reverse()
          .find(
            (r) =>
              !excluded.has(r.event.sequence) &&
              !inAdministrativeTurn(r, administrative),
          )?.event.sequence ?? through,
      activeRun: run ? join(work, 'runs', run.id) : null,
      staleRun: false,
      memory: initialized ? memoryDirectory(work) : null,
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
  if (
    !validExclusions(run.excluded, run.last.event.sequence) ||
    (run.excluded ?? []).some((n) => n <= cp.sequence)
  )
    fail('CURATOR_STAGE_CHANGED');
}

interface PendingCursor {
  version: 3;
  selection: string;
  includeAdministrative: boolean;
  feed: string;
  checkpoint: string;
  from: number;
  through: number;
  checksum: string;
  next: number;
  offset: number;
}
export interface PendingOptions {
  includeAdministrative?: boolean;
  from?: number;
  through?: number;
  limit?: number;
  cursor?: string;
}

/** Read a bounded, stable feed window without staging, consuming an invocation or recovery writes. */
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
      const excludedRows = recordedExclusions(state?.cp);
      const selection = (through: number) =>
        sha(
          JSON.stringify(
            [...excludedRows].filter((n) => n <= through).sort((a, b) => a - b),
          ),
        );
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
          cursor.version !== 3 ||
          cursor.selection !== selection(cursor.through) ||
          typeof cursor.includeAdministrative !== 'boolean' ||
          (options.includeAdministrative !== undefined &&
            cursor.includeAdministrative !== options.includeAdministrative) ||
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
          version: 3,
          selection: selection(through),
          includeAdministrative: options.includeAdministrative ?? false,
          feed: feedId,
          checkpoint,
          from,
          through,
          checksum: rows[through - 1]?.checksum ?? '',
          next: from,
          offset: 0,
        };
      }
      if (
        options.includeAdministrative !== undefined &&
        typeof options.includeAdministrative !== 'boolean'
      )
        fail('CURATOR_ARGUMENT_INVALID');
      const administrative = administrativeTurns(
        rows.slice(0, cursor.through),
        feed,
      );
      const filtered = (r: Row) =>
        excludedRows.has(r.event.sequence) ||
        (!cursor.includeAdministrative &&
          inAdministrativeTurn(r, administrative));
      const excluded = rows
        .slice(cursor.from - 1, cursor.through)
        .filter(filtered).length;
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
        includeAdministrative: cursor.includeAdministrative,
        administrativeExcluded:
          excluded -
          rows
            .slice(cursor.from - 1, cursor.through)
            .filter((r) => excludedRows.has(r.event.sequence)).length,
        discardedExcluded: rows
          .slice(cursor.from - 1, cursor.through)
          .filter((r) => excludedRows.has(r.event.sequence)).length,
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
      while (next <= cursor.through) {
        const row = rows[next - 1]!;
        if (filtered(row)) {
          next++;
          offset = 0;
          continue;
        }
        if (items.length >= limit) break;
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
          // Budget the ASCII-safe bytes actually emitted by the CLI.
          if (Buffer.byteLength(transportJson(candidate)) + 1 <= 16384)
            low = middle;
          else high = middle - 1;
        }
        let end = offset + low;
        if (splitsPair(end)) end--;
        if (
          (end === offset && offset < text.length) ||
          Buffer.byteLength(
            transportJson(
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
    const counts = pendingCounts(
      rows,
      cp.sequence,
      administrativeTurns(rows, cp.feed),
    );
    const receipt = await applyRecord(work);
    if (!run)
      return {
        status: receipt?.runId === runId ? 'already_applied' : 'not_pending',
        through: cp.sequence,
        ...counts,
      };
    if (run.id !== runId) fail('CURATOR_STALE_BATCH');
    checkRun(cp, rows, run);
    await authorityAt(work, cp.feed);
    // Preserve staging and feed; only a new explicit prepare creates another batch.
    await unlink(join(work, 'pending.json'));
    await syncDirectory(work);
    return {
      status: 'abandoned',
      run: run.id,
      confirmed: false,
      eventsPreserved: true,
      workMayContinue: true,
      through: cp.sequence,
      ...counts,
    };
  } finally {
    await release();
  }
}

/** Recognize only an explicit skill invocation, including the native IDE skill link. */
function isCheckpointInvocation(
  text: string,
  feed: string,
  pure = false,
  historical = false,
  taxonomy = false,
) {
  let body = text.trim();
  if (body.startsWith('# Context from my IDE setup:')) {
    const lines = body.split(/\r?\n/);
    let i = 1;
    while (lines[i] === '') i++;
    if (/^## Active file: \S.*$/.test(lines[i] ?? '')) {
      i++;
      while (lines[i] === '') i++;
    }
    if (lines[i++] !== '## Open tabs:') return false;
    let tabs = 0;
    while (/^- .+: \S.*$/.test(lines[i] ?? '')) {
      tabs++;
      i++;
    }
    if (!tabs) return false;
    while (lines[i] === '') i++;
    if (lines[i++] !== '## My request:') return false;
    body = lines.slice(i).join('\n').trim();
  }
  if (taxonomy) {
    if (/^\$knownex-taxonomy(?:\s|$)/u.test(body))
      return !pure || body === '$knownex-taxonomy';
    const link = /^\[\$knownex-taxonomy\]\(([^)\r\n]+)\)(?:\s|$)/u.exec(body);
    return (
      !!link &&
      (!pure || !body.slice(link[0].length).trim()) &&
      resolve(
        workspaceFromFeed(feed),
        '.agents/skills/knownex-taxonomy/SKILL.md',
      ) === resolve(workspaceFromFeed(feed), link[1]!)
    );
  }
  const command = /^\$(knownex-checkpoint|knownex-handoff)(?:\s|$)/u.exec(body);
  if (command)
    return (
      (historical || command[1] === 'knownex-checkpoint') &&
      (!pure || body === `$${command[1]}`)
    );
  const link =
    /^\[\$(knownex-checkpoint|knownex-handoff)\]\(([^)\r\n]+)\)(?:\s|$)/u.exec(
      body,
    );
  if (!link || (pure && body.slice(link[0].length).trim())) return false;
  if (!historical && link[1] !== 'knownex-checkpoint') return false;
  const root = workspaceFromFeed(feed);
  return (
    resolve(root, link[2]!) ===
    resolve(root, `.agents/skills/${link[1]}/SKILL.md`)
  );
}

/** A bare skill invocation defines one administrative turn; argument-bearing messages stay visible. */
function pendingCounts(
  rows: Row[],
  through: number,
  turns: Set<string>,
  excluded = new Set<number>(),
) {
  const pendingRaw = rows.length - through;
  const administrativePending = rows
    .slice(through)
    .filter(
      (r) => !excluded.has(r.event.sequence) && inAdministrativeTurn(r, turns),
    ).length;
  const discardedPending = rows
    .slice(through)
    .filter((r) => excluded.has(r.event.sequence)).length;
  return {
    pending: pendingRaw - administrativePending - discardedPending,
    pendingRaw,
    administrativePending,
    discardedPending,
  };
}
function administrativeTurns(rows: Row[], feed: string) {
  return new Set(
    rows
      .filter(
        (r) =>
          r.event.type === 'user_message' &&
          isCheckpointInvocation(r.event.text, feed, true, true),
      )
      .map((r) => JSON.stringify([r.event.sessionId, r.event.turnId])),
  );
}
const inAdministrativeTurn = (row: Row, turns: Set<string>) =>
  turns.has(JSON.stringify([row.event.sessionId, row.event.turnId]));

async function authorityAt(
  work: string,
  feed: string,
): Promise<FeedAuthority | undefined> {
  let owner: FeedAuthority;
  try {
    owner = await json(feed + '.curator.json');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!object(owner) || typeof owner.work !== 'string')
    fail('CURATOR_WORKSPACE_CONFLICT');
  if (owner.work !== work) fail('CURATOR_WORKSPACE_CONFLICT');
  return owner;
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
  const original =
    canonicalWork(work) && memory === memoryDirectory(work)
      ? await treeAt(memory)
      : await withConfirmedMemory(memory, () => treeAt(memory));
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
  // Importing a confirmed legacy archive requires relocation of authenticated
  // links. Never reinterpret it as a new canonical generation during init.
  if (canonicalWork(work) && through !== 0)
    fail('CURATOR_CANONICAL_IMPORT_UNSUPPORTED');
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
  const target = memoryDirectory(work),
    rebased = rebase(baseline, memory, target);
  if (target !== memory) await putTree(target, rebased);
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
  directiveFile?: string,
  options: {
    through?: number;
    context?: string[];
    artifacts?: string[];
    autonomous?: boolean;
  } = {},
): Promise<{
  status: string;
  run?: string;
  runId?: string;
  packet?: string;
  snapshot?: string;
  proposal?: string;
  manifest?: string;
  from?: number;
  through?: number;
}> {
  if (options.autonomous && options.context?.length)
    fail('CURATOR_ARGUMENT_INVALID');
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { cp, rows, memory } = await stateAt(work);
    const excluded = recordedExclusions(cp);
    const pending = await pendingRun(work);
    const administrative = administrativeTurns(rows, cp.feed);
    const cutoff =
      pending?.last.event.sequence ??
      rows
        .slice(cp.sequence)
        .reverse()
        .find(
          (r) =>
            !excluded.has(r.event.sequence) &&
            !inAdministrativeTurn(r, administrative),
        )?.event.sequence ??
      cp.sequence;
    const through = options.through ?? cutoff;
    if (
      !Number.isSafeInteger(through) ||
      through < cp.sequence ||
      through > rows.length
    )
      fail('CURATOR_ARGUMENT_INVALID');
    const selected = rows.slice(cp.sequence, through);
    if (!pending && !selected.length)
      return { status: 'noop', through: cp.sequence };
    const last = selected.at(-1) ?? pending?.last;
    if (!last) fail('CURATOR_STALE_BATCH');
    const id = `${cp.sequence + 1}-${last.event.sequence}-${randomUUID()}`;
    const releaseFeed = await acquireJournalLock(cp.feed + '.lock');
    try {
      const owner = await authorityAt(work, cp.feed);
      if (pending && !owner) fail('CURATOR_WORKSPACE_CONFLICT');
      if (!owner) await atomicJson(cp.feed + '.curator.json', { work });
    } finally {
      await releaseFeed();
    }
    const directive =
      directiveFile === undefined
        ? (pending?.directive ?? '')
        : await readUtf8(directiveFile);
    const autonomous = pending?.autonomous ?? options.autonomous ?? false;
    if (
      options.autonomous !== undefined &&
      pending &&
      options.autonomous !== !!pending.autonomous
    )
      fail('CURATOR_PENDING_EXISTS');
    const context = autonomous
      ? Object.keys(memory)
          .filter((n) => n.startsWith('knowledge/'))
          .sort()
      : [...new Set(options.context ?? [])];
    const taxonomy = pending
      ? (pending.taxonomy ?? {})
      : (await thematicData(work)).taxonomy;
    if (
      context.some(
        (n) => !n.startsWith('knowledge/') || !allowed(n) || !memory[n],
      )
    )
      fail('CURATOR_CONTEXT_INVALID');
    const external = [
      ...new Set([
        cp.feed,
        ...externalLinks(memory, memoryDirectory(work)),
        ...(await Promise.all(
          (options.artifacts ?? []).map((p) => realpath(p)),
        )),
      ]),
    ];
    for (const p of external)
      if (!(await stat(p)).isFile()) fail('CURATOR_LINK_INVALID');
    if (pending) {
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
      return {
        status: 'prepared',
        run,
        runId: pending.id,
        proposal: join(run, 'proposal.json'),
        packet: join(run, 'packet.json'),
        manifest: join(run, 'inputs.json'),
        snapshot: join(run, 'base'),
        from: cp.sequence + 1,
        through: pending.last.event.sequence,
      };
    }
    const dir = join(work, 'runs', id),
      base = join(dir, 'base');
    const batchExcluded = new Set([
      ...excluded,
      ...selected
        .filter((r) => inAdministrativeTurn(r, administrative))
        .map((r) => r.event.sequence),
    ]);
    const run: Run = {
      ...(autonomous ? { autonomous: true as const } : {}),
      revisionLayout: 1,
      taxonomy,
      id,
      base: cp,
      last,
      context,
      external,
      directive,
      ...(batchExcluded.size
        ? {
            excluded: [...batchExcluded]
              .filter((n) => n > cp.sequence && n <= last.event.sequence)
              .sort((a, b) => a - b),
          }
        : {}),
    };
    // History windows are not curation input: copying them would grow every run with the whole past.
    const snapshot = Object.fromEntries(
      Object.entries(memory).filter(([n]) => !n.startsWith('history/')),
    );
    await putTree(base, rebase(snapshot, memoryDirectory(work), base));
    const baseTree = await treeAt(base);
    const material = selected.filter(
      (r) =>
        !excluded.has(r.event.sequence) &&
        !inAdministrativeTurn(r, administrative),
    );
    const projected = projectFeedEvents(material.map((r) => r.event));
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
      ...(autonomous ? { autonomous: true } : {}),
      taxonomy,
      sessionId: cp.sessionId,
      from: cp.sequence + 1,
      through: last.event.sequence,
      directive,
      context: Object.fromEntries(
        ['STATE.md', ...(autonomous ? [] : context)].map((n) => [
          n,
          baseTree[n]!,
        ]),
      ),
      orderingIssues,
      administrativeExcluded: selected.filter(
        (r) =>
          !excluded.has(r.event.sequence) &&
          inAdministrativeTurn(r, administrative),
      ).length,
      discardedExcluded: selected.filter((r) => excluded.has(r.event.sequence))
        .length,
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
    // WINDOW.md is the Curator's reading copy of the packet: the fields curation needs,
    // without per-event checksums, byte offsets or a session/turn line repeated per event.
    const label = (n: number) => 'E' + String(n).padStart(3, '0');
    // The feed stays an authorized link target for legacy notes, but is not something to cite.
    const cited = external
      .filter((p) => p !== cp.feed)
      .map((p) => relative(workspaceFromFeed(cp.feed), p).split(sep).join('/'));
    const categories = Object.entries(taxonomy ?? {});
    let turn = '';
    const window =
      `# Batch ${label(packet.from)}..${label(packet.through)}\n\n` +
      (cited.length
        ? `- Artefatti citabili (percorso dalla radice del workspace): ${cited.map((a) => '`' + a + '`').join(', ')}\n`
        : '') +
      (orderingIssues.length
        ? `- Avvisi ordine: ${orderingIssues.join(', ')}\n`
        : '') +
      (categories.length
        ? '\n## Categorie approvate\n\n' +
          categories.map(([k, d]) => `- \`${k}\`: ${d}`).join('\n') +
          '\n'
        : '') +
      (directive?.trim()
        ? `\n## Direttiva del principale\n\n${directive}\n`
        : '') +
      '\n' +
      ordered
        .map((r) => {
          const key = `Sessione: ${r.event.sessionId}; turno: ${r.event.turnId}.\n\n`,
            heading = key === turn ? '' : key;
          turn = key;
          return (
            `## ${label(r.event.sequence)} — ${r.event.type}\n\n` +
            heading +
            `${r.event.text}\n`
          );
        })
        .join('\n');
    await writeFile(join(dir, 'WINDOW.md'), window, { mode: 0o600 });
    await writeFile(
      join(dir, 'SKILL.md'),
      await readFile(
        new URL('../.agents/skills/knownex-curator/SKILL.md', import.meta.url),
      ),
    );
    {
      const names = [
        'packet.json',
        'WINDOW.md',
        'SKILL.md',
        ...Object.keys(baseTree).map((n) => 'base/' + n),
      ];
      const files = Object.fromEntries(
        await Promise.all(
          names.map(async (name) => {
            const bytes = await readFile(join(dir, name));
            return [name, { bytes: bytes.length, sha256: sha(bytes) }];
          }),
        ),
      );
      const catalog = context.map((name) => ({
        name,
        path: 'base/' + name,
        id: parseNoteIdentity(baseTree[name]!).id,
        title: baseTree[name]!.match(/^# +([^\r\n]+)$/m)?.[1] ?? name,
        headings: [...baseTree[name]!.matchAll(/^#{1,6} +([^\r\n]+)$/gm)].map(
          (m) => m[1],
        ),
      }));
      const inputs = {
        version: 1,
        from: packet.from,
        through: packet.through,
        files,
        knowledge: catalog,
        history: 'base/HISTORY.md',
        state: 'base/STATE.md',
      };
      const text = JSON.stringify(inputs, null, 2) + '\n';
      await writeFile(join(dir, 'inputs.json'), text, {
        flag: 'wx',
        mode: 0o600,
      });
      run.inputManifestSha256 = sha(text);
    }
    await atomicJson(join(dir, 'run.json'), run);
    await syncDirectory(join(work, 'runs'));
    await syncDirectory(work);
    await atomicJson(join(work, 'pending.json'), { id });
    return {
      status: 'prepared',
      runId: id,
      packet: join(dir, 'packet.json'),
      snapshot: base,
      run: dir,
      proposal: join(dir, 'proposal.json'),
      manifest: join(dir, 'inputs.json'),
      from: cp.sequence + 1,
      through: last.event.sequence,
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
  }
  const plan = planVersions(
    workFromMemory(target),
    memory,
    next,
    cp.knowledgeVersions,
    cp,
    run.id,
    run.last.event.sequence,
    run.last.checksum,
    proposal.action === 'update' ? (proposal.categories ?? {}) : {},
    run.taxonomy ?? {},
    run.revisionLayout === 1,
  );
  if (proposal.action === 'update') {
    const transition = revisionLinks(
      rebase(
        { 'HISTORY.md': proposal.history.transition },
        join(dir, 'base'),
        target,
      )['HISTORY.md']!,
      join(target, 'HISTORY.md'),
      join(target, 'HISTORY.md'),
      target,
      workFromMemory(target),
      plan.versions.heads,
    );
    const work = workFromMemory(target),
      folder = join(target, 'history');
    const notes = Object.keys(proposal.knowledge)
      .sort()
      .map((key): [string, string] => {
        const ref = plan.versions.heads[key];
        const file = ref
          ? archivePath(work, revisionFile(ref))
          : join(target, key);
        return [
          key,
          relative(folder, file).split(sep).map(encodeURIComponent).join('/'),
        ];
      });
    const entry = historyWindow(
      memory['HISTORY.md']!,
      cp.sequence + 1,
      run.last.event.sequence,
      run.last.event.capturedAt,
      { ...proposal.history, transition: intoHistory(transition) },
      notes,
      intoHistory(plan.tree['STATE.md']!),
    );
    plan.tree['HISTORY.md'] = memory['HISTORY.md']! + entry.index;
    plan.tree[entry.name] = entry.text;
  }
  return finishVersions(
    plan,
    run.last.event.sequence,
    digest(plan.tree),
    run.id,
  );
}

interface CurationReview {
  version: 1 | 2 | 3;
  proposalSha256: string;
  summary: string;
  sources: number[];
  changes: { path: string; summary: string; sources: number[] }[];
  uncertainties: string[];
  anomalies: string[];
}

async function reviewAt(
  dir: string,
  run: Run,
  proposal: Proposal,
  bytes: Buffer,
  draftReview?: Buffer,
) {
  const manifestBytes = await readFile(join(dir, 'inputs.json'));
  if (sha(manifestBytes) !== run.inputManifestSha256)
    fail('CURATOR_INPUTS_CHANGED');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    manifest.version !== 1 ||
    manifest.from !== run.base.sequence + 1 ||
    manifest.through !== run.last.event.sequence ||
    !object(manifest.files)
  )
    fail('CURATOR_INPUTS_CHANGED');
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (
      // MEMORY-CONTRACT.md is only frozen in runs prepared before WINDOW.md replaced it.
      !/^(packet\.json|WINDOW\.md|SKILL\.md|MEMORY-CONTRACT\.md|base\/(STATE\.md|HISTORY\.md|knowledge\/[a-z0-9-]+\.md))$/.test(
        name,
      ) ||
      !object(expected)
    )
      fail('CURATOR_INPUTS_CHANGED');
    const file = join(dir, name);
    if (
      (await realpath(file)) !== resolve(file) ||
      (await lstat(file)).isSymbolicLink() ||
      sha(await readFile(file)) !== expected.sha256
    )
      fail('CURATOR_INPUTS_CHANGED');
  }
  if (!run.autonomous) return;
  let reviewBytes: Buffer;
  if (draftReview) reviewBytes = draftReview;
  else {
    try {
      reviewBytes = await readFile(join(dir, 'review.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        fail('CURATOR_REVIEW_REQUIRED');
      throw e;
    }
    if (
      (await lstat(join(dir, 'review.json'))).isSymbolicLink() ||
      (await realpath(join(dir, 'review.json'))) !== resolve(dir, 'review.json')
    )
      fail('CURATOR_REVIEW_INVALID');
  }
  let r: unknown;
  try {
    r = JSON.parse(decodeUtf8(reviewBytes, true));
  } catch {
    fail('CURATOR_REVIEW_INVALID');
  }
  const nonempty = (v: unknown): v is string =>
    typeof v === 'string' && !!v.trim();
  const sources = (v: unknown) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (n) =>
        Number.isSafeInteger(n) &&
        n > 0 &&
        n <= run.last.event.sequence &&
        !(run.excluded ?? []).includes(n) &&
        !(run.base.excluded ?? []).includes(n),
    );
  // v1/v2 reviews (sealed before v3) still carry a critical list; it is no longer checked.
  const legacy = object(r) && (r.version === 1 || r.version === 2);
  if (
    !object(r) ||
    Object.keys(r).sort().join(',') !==
      `anomalies,changes,${legacy ? 'critical,' : ''}proposalSha256,sources,summary,uncertainties,version` ||
    (!legacy && r.version !== 3) ||
    (legacy && !Array.isArray(r.critical)) ||
    r.proposalSha256 !== sha(bytes) ||
    !nonempty(r.summary) ||
    !sources(r.sources) ||
    !Array.isArray(r.changes) ||
    !Array.isArray(r.uncertainties) ||
    !r.uncertainties.every(nonempty) ||
    !Array.isArray(r.anomalies) ||
    !r.anomalies.every(nonempty)
  )
    fail('CURATOR_REVIEW_INVALID');
  const expected =
    proposal.action === 'noop'
      ? []
      : ['STATE.md', ...Object.keys(proposal.knowledge)];
  const paths: string[] = [];
  for (const c of r.changes) {
    if (
      !object(c) ||
      typeof c.path !== 'string' ||
      !expected.includes(c.path) ||
      !nonempty(c.summary) ||
      !sources(c.sources)
    )
      fail('CURATOR_REVIEW_INVALID');
    paths.push(c.path);
  }
  if (
    paths.length !== new Set(paths).size ||
    paths.slice().sort().join('|') !== expected.sort().join('|')
  )
    fail('CURATOR_REVIEW_INVALID');
  return {
    sha256: sha(reviewBytes),
    report: r as unknown as CurationReview,
    path: join(dir, 'review.json'),
  };
}

function versionSeal(
  run: Run,
  proposal: Proposal,
  tree: string,
  plan: ReturnType<typeof materialize>,
  reviewSha256?: string,
) {
  return sha(
    JSON.stringify({
      run,
      proposal,
      ...(run.autonomous ? { reviewSha256 } : {}),
      tree,
      knowledgeVersions: plan.versions,
      revisionHashes: plan.files.map((p) => [p.file, sha(p.content)]),
    }),
  );
}

/** Every check validate applies to a proposal and its review, without staging anything. */
async function checkProposal(
  work: string,
  draft?: { proposal: Buffer; review?: Buffer },
) {
  const { cp, rows, memory } = await stateAt(work),
    run = await pendingRun(work);
  if (!run) fail('CURATOR_NO_PENDING');
  checkRun(cp, rows, run);
  const dir = join(work, 'runs', run.id);
  const proposalBytes =
    draft?.proposal ?? (await readFile(join(dir, 'proposal.json')));
  const raw: unknown = JSON.parse(decodeUtf8(proposalBytes));
  const proposalSha256 = createHash('sha256')
    .update(proposalBytes)
    .digest('hex');
  if (!object(raw) || !['update', 'noop'].includes(raw.action as string))
    fail('CURATOR_PROPOSAL_INVALID');
  const keys =
    raw.action === 'noop'
      ? ['action']
      : [
          'action',
          'state',
          'history',
          'knowledge',
          ...(Object.hasOwn(raw, 'categories') ? ['categories'] : []),
        ];
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
      (raw.categories !== undefined && !object(raw.categories)) ||
      typeof raw.history.transition !== 'string')
  )
    fail('CURATOR_PROPOSAL_INVALID');
  const proposal = raw as unknown as Proposal;
  const review = await reviewAt(
    dir,
    run,
    proposal,
    proposalBytes,
    draft?.review,
  );
  const target = memoryDirectory(work);
  const plan = materialize(memory, run, proposal, target, dir);
  validateKnowledgeEvolution(memory, plan.tree);
  await validateTree(
    plan.tree,
    target,
    run.external,
    rows,
    run.last.event.sequence,
    cp.feed,
    [...(run.base.excluded ?? []), ...(run.excluded ?? [])],
    plan.files,
    plan.versions,
  );
  for (const p of plan.files) await checkRevisionPublication(work, p);
  return { run, dir, proposal, proposalSha256, review, target, plan };
}

/** Lets `curate write` reject a draft with validate's own checks while the Curator can still fix it. */
export async function checkCurationDraft(
  work: string,
  proposal: Buffer,
  review?: Buffer,
) {
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    await checkProposal(work, { proposal, review });
  } finally {
    await release();
  }
}

export async function validateCurator(work: string) {
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { run, dir, proposal, proposalSha256, review, target, plan } =
      await checkProposal(work);
    const candidate = join(dir, 'candidate-' + randomUUID());
    const next = plan.tree;
    const stateBytes = Buffer.byteLength(next['STATE.md']!, 'utf8');
    await putTree(candidate, rebase(next, target, candidate));
    const staged = await treeAt(candidate),
      treeHash = digest(staged);
    const seal = versionSeal(run, proposal, treeHash, plan, review?.sha256);
    await atomicJson(join(dir, 'validated.json'), {
      seal,
      candidate,
      treeHash,
      action: proposal.action,
      proposalSha256,
      ...(review ? { reviewSha256: review.sha256 } : {}),
      versioning: 1,
    });
    return {
      status: 'validated',
      seal,
      candidate,
      through: run.last.event.sequence,
      action: proposal.action,
      proposalSha256,
      ...(review
        ? {
            checks: {
              frozenInputs: true,
              cutoff: true,
              provenance: true,
              links: true,
              knowledgeEvolution: true,
              candidateIntegrity: true,
            },
            review: {
              ...review,
              semanticVerification:
                'not certified by CLI; principal reviews report and escalates specific unresolved risks',
            },
          }
        : {}),
      stateBytes,
    };
  } finally {
    await release();
  }
}

/** Persist sealed apply intent before promoting any confirmed file; recovery needs no proposal. */
export async function applyCurator(work: string, seal: string) {
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  let releaseFeed: (() => Promise<void>) | undefined;
  try {
    const { cp, memory } = await stateAt(work);
    const run = await pendingRun(work);
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
    releaseFeed = await acquireJournalLock(cp.feed + '.lock');
    const rows = await feedRows(cp.feed);
    if (!(await authorityAt(work, cp.feed))) fail('CURATOR_WORKSPACE_CONFLICT');
    const dir = join(work, 'runs', run.id);
    const approval = await json<{
      seal: string;
      candidate: string;
      treeHash: string;
      action: string;
      proposalSha256?: string;
      reviewSha256?: string;
      versioning?: number;
    }>(join(dir, 'validated.json'));
    if (approval.seal !== seal || !inside(dir, approval.candidate))
      fail('CURATOR_CONFIRMATION_REQUIRED');
    const staged = await treeAt(approval.candidate);
    const proposalBytes = await readFile(join(dir, 'proposal.json'));
    const proposal: Proposal = JSON.parse(decodeUtf8(proposalBytes));
    if (
      approval.proposalSha256 &&
      createHash('sha256').update(proposalBytes).digest('hex') !==
        approval.proposalSha256
    )
      fail('CURATOR_STAGE_CHANGED');
    const review = await reviewAt(dir, run, proposal, proposalBytes);
    if (run.autonomous && approval.reviewSha256 !== review?.sha256)
      fail('CURATOR_STAGE_CHANGED');
    if (approval.versioning !== 1) fail('CURATOR_REVALIDATION_REQUIRED');
    if (digest(staged) !== approval.treeHash) fail('CURATOR_STAGE_CHANGED');
    checkRun(cp, rows, run);
    const target = memoryDirectory(work),
      plan = materialize(memory, run, proposal, target, dir),
      next = plan.tree;
    if (
      versionSeal(run, proposal, digest(staged), plan, review?.sha256) !== seal
    )
      fail('CURATOR_STAGE_CHANGED');
    if (digest(rebase(next, target, approval.candidate)) !== approval.treeHash)
      fail('CURATOR_STAGE_CHANGED');
    // Windows need no check of their own: materialize only adds the next one.
    if (!next['HISTORY.md']!.startsWith(memory['HISTORY.md']!))
      fail('CURATOR_HISTORY_CHANGED');
    await validateTree(
      next,
      target,
      run.external,
      rows,
      run.last.event.sequence,
      cp.feed,
      [...(run.base.excluded ?? []), ...(run.excluded ?? [])],
      plan.files,
      plan.versions,
    );
    const checkpoint: Checkpoint = {
      ...cp,
      version: 3,
      knowledgeVersions: plan.versions,
      sessionId: run.last.event.sessionId,
      sequence: run.last.event.sequence,
      checksum: run.last.checksum,
      memoryHash: digest(next),
      ...(run.excluded?.length || cp.excluded?.length
        ? {
            excluded: [
              ...new Set([...(cp.excluded ?? []), ...(run.excluded ?? [])]),
            ].sort((a, b) => a - b),
          }
        : {}),
      ...(run.nativeHistory ? { nativeHistory: true } : {}),
    };
    // Establish the stable baseline and the inputs that recovery will need.
    // Staging/base trees are not recovery inputs: the record contains both trees.
    await syncTree(target, memory, cp.knowledgeVersions);
    await syncPath(join(work, 'checkpoint.json'));
    await syncPath(join(dir, 'run.json'));
    await syncDirectory(dir);
    await syncDirectory(join(work, 'runs'));
    await syncPath(cp.feed);
    await syncDirectory(dirname(cp.feed));
    await syncDirectory(work);
    await syncDirectory(dirname(work));
    // Re-read the acquired feed at the durable publication boundary; no native oracle.
    const finalRows = await feedRows(cp.feed);
    checkRun(cp, finalRows, run);
    if (!(await authorityAt(work, cp.feed))) fail('CURATOR_WORKSPACE_CONFLICT');
    const record: ApplyRecord = {
      version: 2,
      runId: run.id,
      seal,
      action: approval.action,
      before: cp,
      after: checkpoint,
      previous: memory,
      next,
      revisionFiles: plan.files,
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
    await releaseFeed?.();
    await release();
  }
}

interface TaxonomyRun {
  id: string;
  checkpoint: string;
  thematic: string;
  request: { sequence: number; checksum: string; sessionId: string };
}
const taxonomyId = (id: string) => {
  if (!/^t-[a-f0-9]{64}$/.test(id)) fail('TAXONOMY_RUN_INVALID');
  return id;
};
async function taxonomyDirectory(work: string, id: string, create = false) {
  taxonomyId(id);
  let directory = work;
  for (const part of ['taxonomy-runs', id]) {
    directory = join(directory, part);
    if (create) {
      try {
        await mkdir(directory);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    if (
      (await lstat(directory)).isSymbolicLink() ||
      !(await lstat(directory)).isDirectory() ||
      (await realpath(directory)) !== resolve(directory)
    )
      fail('TAXONOMY_PATH_INVALID');
  }
  return directory;
}
async function taxonomyRunAt(work: string, id: string) {
  const path = join(await taxonomyDirectory(work, id), 'run.json');
  if (
    (await lstat(path)).isSymbolicLink() ||
    !(await lstat(path)).isFile() ||
    (await realpath(path)) !== resolve(path)
  )
    fail('TAXONOMY_PATH_INVALID');
  const run = await json<TaxonomyRun>(path);
  if (run.id !== id) fail('TAXONOMY_RUN_INVALID');
  return run;
}
async function taxonomyCandidate(
  work: string,
  run: TaxonomyRun,
  cp: Checkpoint,
) {
  const base = await thematicCatalog(work, cp.knowledgeVersions);
  if (
    run.checkpoint !== sha(JSON.stringify(cp)) ||
    run.thematic !== base.fingerprint
  )
    fail('TAXONOMY_STALE_PROPOSAL');
  const proposalPath = join(
    await taxonomyDirectory(work, run.id),
    'proposal.json',
  );
  if (
    (await lstat(proposalPath)).isSymbolicLink() ||
    !(await lstat(proposalPath)).isFile() ||
    (await realpath(proposalPath)) !== resolve(proposalPath)
  )
    fail('TAXONOMY_PATH_INVALID');
  const raw = await json<unknown>(proposalPath);
  const proposal = taxonomyProposal(raw, base);
  const seal = thematicHash({ operation: 'taxonomy', run, raw });
  return { base, proposal, seal, raw };
}
export async function prepareTaxonomy(work: string) {
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { cp, rows } = await stateAt(work, false);
    const excluded = recordedExclusions(cp);
    const request = [...rows]
      .reverse()
      .find((r) => r.event.type === 'user_message');
    if (
      !request ||
      excluded.has(request.event.sequence) ||
      !isCheckpointInvocation(request.event.text, cp.feed, false, false, true)
    )
      fail('TAXONOMY_INVOCATION_REQUIRED');
    const id = 't-' + request.checksum;
    const base = await thematicCatalog(work, cp.knowledgeVersions);
    const run: TaxonomyRun = {
      id,
      checkpoint: sha(JSON.stringify(cp)),
      thematic: base.fingerprint,
      request: {
        sequence: request.event.sequence,
        checksum: request.checksum,
        sessionId: request.event.sessionId,
      },
    };
    const dir = join(work, 'taxonomy-runs', id);
    try {
      const existing = await taxonomyRunAt(work, id);
      if (JSON.stringify(existing) !== JSON.stringify(run))
        fail('TAXONOMY_STALE_PROPOSAL');
      return {
        status: 'prepared',
        id,
        run: dir,
        proposal: join(dir, 'proposal.json'),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await taxonomyDirectory(work, id, true);
    await atomicJson(join(dir, 'packet.json'), {
      operation: 'taxonomy',
      id,
      checkpoint: cp.sequence,
      taxonomy: base.taxonomy,
      assignments: base.data.assignments,
      revisions: base.revisions.map((r) => ({
        ...r,
        reference: relative(memoryDirectory(work), archivePath(work, r.file))
          .split(sep)
          .join('/'),
      })),
      proposal: join(dir, 'proposal.json'),
    });
    await atomicJson(join(dir, 'run.json'), run);
    return {
      status: 'prepared',
      id,
      run: dir,
      proposal: join(dir, 'proposal.json'),
    };
  } finally {
    await release();
  }
}
export async function validateTaxonomy(work: string, id: string) {
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { cp } = await stateAt(work, false),
      run = await taxonomyRunAt(work, id);
    const candidate = await taxonomyCandidate(work, run, cp);
    const preview = thematicIndexes(
      work,
      candidate.proposal.taxonomy,
      { version: 1, assignments: candidate.proposal.assignments },
      candidate.base.revisions,
    );
    return {
      status: candidate.proposal.changed ? 'validated' : 'noop',
      id,
      ...(candidate.proposal.changed ? { seal: candidate.seal } : {}),
      categories: candidate.proposal.taxonomy,
      assignments: candidate.proposal.assignments,
      explanations: candidate.proposal.explanations,
      indexes: Object.keys(preview),
      checkpointUnchanged: cp.sequence,
    };
  } finally {
    await release();
  }
}
async function organizationPlan(
  work: string,
  mode: OrganizationPlan['mode'],
  next: Record<string, string>,
): Promise<OrganizationPlan> {
  const previous: Record<string, string | null> = {};
  for (const name of Object.keys(next))
    previous[name] = await organizationText(work, name);
  return { mode, previous, next };
}
async function commitOrganization(
  work: string,
  cp: Checkpoint,
  id: string,
  seal: string,
  plan: OrganizationPlan,
) {
  checkOrganization(plan);
  const record: ApplyRecord = {
    version: 3,
    runId: id,
    seal,
    action: plan.mode,
    before: cp,
    after: cp,
    previous: {},
    next: {},
    organization: plan,
  };
  await syncPath(join(work, 'checkpoint.json'));
  await syncDirectory(work);
  await atomicJson(join(work, 'apply.json'), {
    record,
    checksum: sha(JSON.stringify(record)),
  });
  await recoverApply(work);
}
export async function applyTaxonomy(
  work: string,
  id: string,
  seal: string,
  approvalEvent: number,
) {
  work = await realpath(work);
  taxonomyId(id);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  let releaseFeed: (() => Promise<void>) | undefined;
  try {
    const { cp } = await stateAt(work);
    const priorReceipt = await organizationText(
      work,
      'taxonomy-changes/' + id + '.json',
    );
    if (priorReceipt !== null) {
      if (JSON.parse(priorReceipt).seal !== seal)
        fail('TAXONOMY_CONFIRMATION_REQUIRED');
      let head = (await thematicData(work)).data.receipt;
      const seen = new Set<string>();
      let confirmed = false;
      while (head) {
        if (seen.has(head.id)) fail('TAXONOMY_INTEGRITY_CHANGED');
        seen.add(head.id);
        const text = await organizationText(
          work,
          'taxonomy-changes/' + head.id + '.json',
        );
        if (
          text === null ||
          createHash('sha256').update(text).digest('hex') !== head.hash
        )
          fail('TAXONOMY_INTEGRITY_CHANGED');
        if (head.id === id) {
          confirmed = true;
          break;
        }
        head = JSON.parse(text).previous ?? undefined;
      }
      if (!confirmed) fail('TAXONOMY_COLLISION');
      return {
        status: 'already_applied',
        id,
        checkpointUnchanged: cp.sequence,
      };
    }
    if (await pendingRun(work)) fail('CURATOR_PENDING_EXISTS');
    const run = await taxonomyRunAt(work, id),
      candidate = await taxonomyCandidate(work, run, cp);
    if (!candidate.proposal.changed || candidate.seal !== seal)
      fail('TAXONOMY_CONFIRMATION_REQUIRED');
    releaseFeed = await acquireJournalLock(cp.feed + '.lock');
    const rows = await feedRows(cp.feed),
      excluded = recordedExclusions(cp);
    const request = rows[run.request.sequence - 1];
    if (
      !request ||
      request.checksum !== run.request.checksum ||
      excluded.has(run.request.sequence)
    )
      fail('TAXONOMY_APPROVAL_REQUIRED');
    const shown = [...rows]
      .reverse()
      .find(
        (r) =>
          r.event.type === 'assistant_final' &&
          r.event.sessionId === run.request.sessionId &&
          r.event.sequence > run.request.sequence &&
          !excluded.has(r.event.sequence) &&
          r.event.text.includes(id) &&
          r.event.text.includes(seal),
      );
    const first = shown
      ? rows.find(
          (r) =>
            r.event.type === 'user_message' &&
            r.event.sessionId === run.request.sessionId &&
            r.event.sequence > shown.event.sequence &&
            !excluded.has(r.event.sequence),
        )
      : undefined;
    if (
      !Number.isSafeInteger(approvalEvent) ||
      !first ||
      first.event.sequence !== approvalEvent ||
      rows.some(
        (r) =>
          r.event.type === 'user_message' &&
          r.event.sessionId === run.request.sessionId &&
          r.event.sequence > approvalEvent &&
          !excluded.has(r.event.sequence),
      )
    )
      fail('TAXONOMY_APPROVAL_REQUIRED');
    const after = thematicHash({
      taxonomy: candidate.proposal.taxonomy,
      assignments: candidate.proposal.assignments,
    });
    const receipt =
      JSON.stringify(
        {
          version: 1,
          id,
          seal,
          previous: candidate.base.data.receipt ?? null,
          before: thematicHash({
            taxonomy: candidate.base.taxonomy,
            assignments: candidate.base.data.assignments,
          }),
          after,
          approval: {
            feed: cp.feed,
            sequence: first.event.sequence,
            checksum: first.checksum,
            sessionId: first.event.sessionId,
          },
          proposal: candidate.raw,
        },
        null,
        2,
      ) + '\n';
    const data = {
      version: 1 as const,
      assignments: candidate.proposal.assignments,
      receipt: { id, hash: createHash('sha256').update(receipt).digest('hex') },
    };
    const next = { ['taxonomy-changes/' + id + '.json']: receipt };
    const files: Record<string, string> = {
      ...next,
      'taxonomy.json':
        JSON.stringify(candidate.proposal.taxonomy, null, 2) + '\n',
      ...thematicIndexes(
        work,
        candidate.proposal.taxonomy,
        data,
        candidate.base.revisions,
      ),
      'taxonomy-associations.json': JSON.stringify(data, null, 2) + '\n',
    };
    const plan = await organizationPlan(work, 'taxonomy', files);
    if (plan.previous['taxonomy-changes/' + id + '.json'] !== null)
      fail('TAXONOMY_COLLISION');
    await commitOrganization(work, cp, id, seal, plan);
    return { status: 'applied', id, checkpointUnchanged: cp.sequence };
  } finally {
    await releaseFeed?.();
    await release();
  }
}
export async function rebuildTaxonomy(work: string) {
  work = await realpath(work);
  const release = await acquireJournalLock(join(work, 'curator.lock'));
  try {
    const { cp } = await stateAt(work),
      base = await thematicCatalog(work, cp.knowledgeVersions);
    const plan = await organizationPlan(
      work,
      'taxonomy-rebuild',
      thematicIndexes(work, base.taxonomy, base.data, base.revisions),
    );
    if (
      Object.keys(plan.next).every(
        (name) => plan.previous[name] === plan.next[name],
      )
    )
      return { status: 'noop', checkpointUnchanged: cp.sequence };
    const seal = thematicHash({ checkpoint: cp, plan }),
      id = 't-' + seal;
    await commitOrganization(work, cp, id, seal, plan);
    return { status: 'rebuilt', checkpointUnchanged: cp.sequence };
  } finally {
    await release();
  }
}
