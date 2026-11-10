import { decodeUtf8, sha256 } from './artifact-io.ts';
import {
  canonicalWork,
  memoryDirectory,
  revisionDirectory,
  organizationFile,
} from './layout.ts';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseNoteIdentity } from './memory-contract.ts';

type Tree = Record<string, string>;
export interface RevisionRef {
  id: string;
  revision: string;
  hash: string;
  file?: string;
}
interface CheckpointRef {
  through: number;
  hash: string;
}
export interface KnowledgeVersions {
  baseline: number;
  heads: Record<string, RevisionRef>;
  checkpoint: CheckpointRef;
}
export interface RevisionPublication {
  file: string;
  content: string;
}
interface Revision {
  version: 1;
  id: string;
  revision: string;
  name: string;
  previous: RevisionRef | null;
  through: number;
  checksum: string;
  contentHash: string;
}
interface CheckpointRecord {
  version: 1;
  through: number;
  previous: CheckpointRef | null;
  publication: string;
  memoryHash: string;
}
const footer = '\n<!-- knownex-revision:';
const idPattern =
  /^kn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revisionPattern = /^[br]-\d+-\d+-[0-9a-f-]{36}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const namePattern = /^knowledge\/[a-z0-9-]+\.md$/;
const categoryPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const categoryKey = (key: string) =>
  categoryPattern.test(key) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(key);
const checkpointFolder = (through: number) =>
  'checkpoint-' + String(through).padStart(4, '0');
function placement(file: string) {
  const m =
    /^(checkpoint-(\d{4,}))\/(?:([a-z0-9-]+)\/)?(kn-[a-f0-9-]+--[br]-[a-f0-9-]+\.md)$/.exec(
      file,
    );
  if (
    !m ||
    !Number.isSafeInteger(Number(m[2])) ||
    checkpointFolder(Number(m[2])) !== m[1] ||
    (m[3] !== undefined && !categoryKey(m[3]))
  )
    return;
  return { through: Number(m[2]), category: m[3], name: m[4]! };
}
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
export const revisionHash = (text: string) => sha256(text);
function fail(code = 'KNOWLEDGE_REVISION_INVALID'): never {
  throw Object.assign(new Error(code), { code });
}
export function checkTaxonomy(
  value: unknown,
): asserts value is Record<string, string> {
  if (
    !object(value) ||
    Object.entries(value).some(
      ([key, description]) =>
        !categoryKey(key) ||
        typeof description !== 'string' ||
        !description.trim() ||
        /[\0\r\n]/.test(description),
    )
  )
    fail('CURATOR_TAXONOMY_INVALID');
}
export async function readTaxonomy(
  work: string,
): Promise<Record<string, string>> {
  const path = organizationFile(work, 'taxonomy.json');
  try {
    if (
      (await lstat(path)).isSymbolicLink() ||
      !(await lstat(path)).isFile() ||
      (await realpath(path)) !== resolve(path)
    )
      fail('CURATOR_TAXONOMY_INVALID');
    const value: unknown = JSON.parse(decodeUtf8(await readFile(path), true));
    checkTaxonomy(value);
    if (
      (await lstat(path)).isSymbolicLink() ||
      (await realpath(path)) !== resolve(path)
    )
      fail('CURATOR_TAXONOMY_INVALID');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if ((error as NodeJS.ErrnoException).code === 'CURATOR_TAXONOMY_INVALID')
      throw error;
    fail('CURATOR_TAXONOMY_INVALID');
  }
}
function isRef(x: unknown): x is RevisionRef {
  return (
    object(x) &&
    typeof x.id === 'string' &&
    idPattern.test(x.id) &&
    typeof x.revision === 'string' &&
    revisionPattern.test(x.revision) &&
    typeof x.hash === 'string' &&
    hashPattern.test(x.hash) &&
    Object.keys(x).length === (x.file === undefined ? 3 : 4) &&
    (x.file === undefined ||
      (typeof x.file === 'string' &&
        placement(x.file)?.name === x.id + '--' + x.revision + '.md'))
  );
}
function isCheckpointRef(x: unknown): x is CheckpointRef {
  return (
    object(x) &&
    Number.isSafeInteger(x.through) &&
    Number(x.through) >= 0 &&
    typeof x.hash === 'string' &&
    hashPattern.test(x.hash) &&
    Object.keys(x).length === 2
  );
}
export function checkVersionState(
  x: unknown,
  through: number,
): asserts x is KnowledgeVersions {
  if (
    !object(x) ||
    Object.keys(x).length !== 3 ||
    !Number.isSafeInteger(x.baseline) ||
    Number(x.baseline) < 0 ||
    Number(x.baseline) > through ||
    !object(x.heads) ||
    !isCheckpointRef(x.checkpoint) ||
    x.checkpoint.through !== through
  )
    fail();
  const ids = new Set<string>();
  for (const [name, ref] of Object.entries(x.heads)) {
    if (!namePattern.test(name) || !isRef(ref) || ids.has(ref.id)) fail();
    ids.add(ref.id);
  }
}
export const revisionFile = (
  ref: Pick<RevisionRef, 'id' | 'revision' | 'file'>,
) => {
  if (!idPattern.test(ref.id) || !revisionPattern.test(ref.revision))
    fail('MEMORY_INVALID_ID');
  const name = ref.id + '--' + ref.revision + '.md';
  if (ref.file !== undefined && placement(ref.file)?.name !== name)
    fail('MEMORY_INVALID_ID');
  return ref.file ?? name;
};
function checkpointFile(through: number) {
  return 'c-' + through + '.json';
}
export function archivePath(work: string, file: string) {
  if (!/^c-\d+\.json$/.test(file)) {
    const location = placement(file);
    const m = (location?.name ?? file).match(
      /^(kn-[a-f0-9-]+)--([br]-[a-f0-9-]+)\.md$/,
    );
    if (
      !m ||
      revisionFile({
        id: m[1]!,
        revision: m[2]!,
        ...(location ? { file } : {}),
      }) !== file
    )
      fail();
  }
  return join(revisionDirectory(work, file), file);
}
export async function archiveText(work: string, file: string) {
  const path = archivePath(work, file);
  const check = async () => {
    let part = revisionDirectory(work, file);
    for (const component of ['', ...file.split('/').slice(0, -1)]) {
      part = join(part, component);
      if (
        (await lstat(part)).isSymbolicLink() ||
        !(await lstat(part)).isDirectory() ||
        (await realpath(part)) !== resolve(part)
      )
        fail('KNOWLEDGE_ARCHIVE_UNSAFE');
    }
  };
  try {
    await check();
    if (
      (await lstat(dirname(path))).isSymbolicLink() ||
      !(await lstat(path)).isFile() ||
      (await lstat(path)).isSymbolicLink()
    )
      fail('KNOWLEDGE_ARCHIVE_UNSAFE');
    const canonical = await realpath(path);
    if (canonical !== resolve(path)) fail('KNOWLEDGE_ARCHIVE_UNSAFE');
    const bytes = await readFile(path);
    await check();
    if (
      (await lstat(path)).isSymbolicLink() ||
      (await realpath(path)) !== canonical ||
      (await lstat(dirname(path))).isSymbolicLink()
    )
      fail('KNOWLEDGE_ARCHIVE_UNSAFE');
    return decodeUtf8(bytes);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      fail('KNOWLEDGE_REVISION_MISSING');
    throw e;
  }
}
function decodeRevision(text: string) {
  const at = text.lastIndexOf(footer);
  if (at < 0 || !text.endsWith(' -->\n')) fail();
  const content = text.slice(0, at);
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(at + footer.length, -5));
  } catch {
    fail();
  }
  if (
    !object(raw) ||
    Object.keys(raw).length !== 8 ||
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    !idPattern.test(raw.id) ||
    typeof raw.revision !== 'string' ||
    !revisionPattern.test(raw.revision) ||
    typeof raw.name !== 'string' ||
    !namePattern.test(raw.name) ||
    (raw.previous !== null &&
      (!isRef(raw.previous) ||
        raw.previous.id !== raw.id ||
        raw.previous.revision === raw.revision)) ||
    !Number.isSafeInteger(raw.through) ||
    Number(raw.through) < 0 ||
    typeof raw.checksum !== 'string' ||
    (raw.through !== 0 && !hashPattern.test(raw.checksum)) ||
    raw.contentHash !== revisionHash(content) ||
    parseNoteIdentity(content).id !== raw.id ||
    content.includes(footer)
  )
    fail();
  return { metadata: raw as unknown as Revision, content };
}
export function checkPublications(
  files: unknown,
): asserts files is RevisionPublication[] {
  if (!Array.isArray(files)) fail();
  const seen = new Set<string>();
  for (const f of files) {
    if (
      !object(f) ||
      Object.keys(f).length !== 2 ||
      typeof f.file !== 'string' ||
      typeof f.content !== 'string' ||
      seen.has(f.file)
    )
      fail();
    archivePath('.', f.file);
    seen.add(f.file);
    if (f.file.endsWith('.md')) {
      const { metadata } = decodeRevision(f.content);
      const location = placement(f.file);
      if (
        revisionFile({ ...metadata, ...(location ? { file: f.file } : {}) }) !==
          f.file ||
        (location && location.through !== metadata.through)
      )
        fail();
    } else if (checkpointFile(decodeCheckpoint(f.content).through) !== f.file)
      fail();
  }
}
function decodeCheckpoint(text: string) {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    fail();
  }
  if (
    !object(x) ||
    Object.keys(x).length !== 5 ||
    x.version !== 1 ||
    !Number.isSafeInteger(x.through) ||
    Number(x.through) < 0 ||
    (x.previous !== null &&
      (!isCheckpointRef(x.previous) ||
        x.previous.through >= Number(x.through))) ||
    typeof x.publication !== 'string' ||
    !revisionPattern.test(x.publication) ||
    typeof x.memoryHash !== 'string' ||
    !hashPattern.test(x.memoryHash)
  )
    fail();
  return x as unknown as CheckpointRecord;
}
const href = (from: string, target: string, fragment?: string) =>
  relative(dirname(from), target).split(sep).map(encodeURIComponent).join('/') +
  (fragment ? '#' + fragment : '');
/** Relocation preserves link targets; only unmarked logical Knowledge links are pinned. */
export function revisionLinks(
  text: string,
  from: string,
  to: string,
  memory: string,
  work: string,
  heads?: Record<string, RevisionRef>,
) {
  return text.replace(
    /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g,
    (whole: string, label: string, link: string, offset: number) => {
      const [url, fragment] = link.split('#');
      if (!url || /^[a-z]+:/i.test(url)) return whole;
      let target = resolve(dirname(from), decodeURIComponent(url));
      const key = relative(memory, target).split(sep).join('/');
      const floating = text
        .slice(offset + whole.length)
        .startsWith('<!-- knownex:current -->');
      if (
        (!floating || canonicalWork(work)) &&
        heads &&
        namePattern.test(key)
      ) {
        const ref = heads[key];
        if (!ref) fail('KNOWLEDGE_REFERENCE_INVALID');
        target = archivePath(work, revisionFile(ref));
      }
      return `[${label}](${href(to, target, fragment)})`;
    },
  );
}
export interface VersionPlan {
  tree: Tree;
  previousState: string;
  versions: KnowledgeVersions;
  files: RevisionPublication[];
}
/** No archive enumeration: only the active tree and this promotion's changes. */
export function planVersions(
  work: string,
  before: Tree,
  raw: Tree,
  prior: KnowledgeVersions | undefined,
  base: { sequence: number; checksum: string; memoryHash: string },
  runId: string,
  through: number,
  checksum: string,
  categories: Record<string, string> = {},
  taxonomy: Record<string, string> = {},
  chronological = true,
): VersionPlan {
  checkTaxonomy(taxonomy);
  if (
    !object(categories) ||
    Object.values(categories).some(
      (c) => typeof c !== 'string' || !Object.hasOwn(taxonomy, c),
    )
  )
    fail('CURATOR_CATEGORY_INVALID');
  const memory = memoryDirectory(work),
    files: RevisionPublication[] = [],
    tree = { ...raw };
  const oldHeads: Record<string, RevisionRef> = prior
    ? structuredClone(prior.heads)
    : {};
  const create = (
    name: string,
    source: string,
    revision: string,
    previous: RevisionRef | null,
    cutoff: number,
    sourceChecksum: string,
    heads: Record<string, RevisionRef>,
  ) => {
    if (source.includes(footer)) fail();
    const ref = heads[name]!;
    const target = archivePath(work, revisionFile(ref));
    const content = revisionLinks(
      source,
      join(memory, name),
      target,
      memory,
      work,
      heads,
    );
    const metadata: Revision = {
      version: 1,
      id: ref.id,
      revision,
      name,
      previous,
      through: cutoff,
      checksum: sourceChecksum,
      contentHash: revisionHash(content),
    };
    const text = content + footer + JSON.stringify(metadata) + ' -->\n';
    ref.hash = revisionHash(text);
    files.push({ file: revisionFile(ref), content: text });
    return revisionLinks(content, target, join(memory, name), memory, work);
  };
  if (!prior) {
    for (const [name, text] of Object.entries(before))
      if (namePattern.test(name))
        oldHeads[name] = {
          id: parseNoteIdentity(text).id,
          revision: 'b-' + runId,
          hash: '',
          ...(chronological
            ? {
                file:
                  checkpointFolder(base.sequence) +
                  '/' +
                  revisionFile({
                    id: parseNoteIdentity(text).id,
                    revision: 'b-' + runId,
                  }),
              }
            : {}),
        };
    for (const [name, ref] of Object.entries(oldHeads))
      create(
        name,
        before[name]!,
        ref.revision,
        null,
        base.sequence,
        base.checksum,
        oldHeads,
      );
  }
  const heads = structuredClone(oldHeads);
  const changed = Object.keys(raw).filter((name) => {
    if (!namePattern.test(name) || raw[name] === before[name]) return false;
    if (!before[name]) return true;
    try {
      const file = join(memory, name);
      return (
        revisionLinks(raw[name]!, file, file, memory, work, oldHeads) !==
        revisionLinks(before[name]!, file, file, memory, work, oldHeads)
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'KNOWLEDGE_REFERENCE_INVALID')
        return true;
      throw e;
    }
  });
  if (prior)
    for (const name of Object.keys(oldHeads))
      if (!changed.includes(name)) tree[name] = before[name]!;
  if (Object.keys(categories).some((name) => !changed.includes(name)))
    fail('CURATOR_CATEGORY_INVALID');
  for (const name of changed)
    heads[name] = {
      id: parseNoteIdentity(raw[name]!).id,
      revision: 'r-' + runId,
      hash: '',
      ...(chronological
        ? {
            file:
              checkpointFolder(through) +
              '/' +
              (categories[name] ? categories[name] + '/' : '') +
              revisionFile({
                id: parseNoteIdentity(raw[name]!).id,
                revision: 'r-' + runId,
              }),
          }
        : {}),
    };
  for (const name of changed)
    tree[name] = create(
      name,
      raw[name]!,
      heads[name]!.revision,
      oldHeads[name] ?? null,
      through,
      checksum,
      heads,
    );
  if (!prior)
    for (const [name, ref] of Object.entries(oldHeads))
      if (!changed.includes(name)) {
        const text = files.find((f) => f.file === revisionFile(ref))!.content;
        tree[name] = revisionLinks(
          decodeRevision(text).content,
          archivePath(work, revisionFile(ref)),
          join(memory, name),
          memory,
          work,
        );
      }
  tree['STATE.md'] = revisionLinks(
    raw['STATE.md']!,
    join(memory, 'STATE.md'),
    join(memory, 'STATE.md'),
    memory,
    work,
    heads,
  );
  const previousState = revisionLinks(
    before['STATE.md']!,
    join(memory, 'STATE.md'),
    join(memory, 'STATE.md'),
    memory,
    work,
    oldHeads,
  );
  let checkpoint = prior?.checkpoint;
  if (!checkpoint) {
    const content =
      JSON.stringify({
        version: 1,
        through: base.sequence,
        previous: null,
        publication: 'b-' + runId,
        memoryHash: base.memoryHash,
      } satisfies CheckpointRecord) + '\n';
    files.push({ file: checkpointFile(base.sequence), content });
    checkpoint = { through: base.sequence, hash: revisionHash(content) };
  }
  return {
    tree,
    previousState,
    files,
    versions: { baseline: prior?.baseline ?? base.sequence, heads, checkpoint },
  };
}
export function finishVersions(
  plan: VersionPlan,
  through: number,
  memoryHash: string,
  runId: string,
) {
  const content =
    JSON.stringify({
      version: 1,
      through,
      previous: plan.versions.checkpoint,
      publication: 'r-' + runId,
      memoryHash,
    } satisfies CheckpointRecord) + '\n';
  plan.files.push({ file: checkpointFile(through), content });
  plan.versions.checkpoint = { through, hash: revisionHash(content) };
  return plan;
}
export async function checkRevisionPublication(
  work: string,
  file: RevisionPublication,
  required = false,
) {
  try {
    const text = await archiveText(work, file.file);
    if (text !== file.content) fail('KNOWLEDGE_REVISION_COLLISION');
    return true;
  } catch (e) {
    if (
      !required &&
      (e as NodeJS.ErrnoException).code === 'KNOWLEDGE_REVISION_MISSING'
    )
      return false;
    throw e;
  }
}
async function loadRevision(
  work: string,
  ref: RevisionRef,
  files: RevisionPublication[] = [],
) {
  const text =
    files.find((p) => p.file === revisionFile(ref))?.content ??
    (await archiveText(work, revisionFile(ref)));
  if (revisionHash(text) !== ref.hash) fail('KNOWLEDGE_REVISION_CHANGED');
  const value = decodeRevision(text);
  if (value.metadata.id !== ref.id || value.metadata.revision !== ref.revision)
    fail();
  if (
    ref.file !== undefined &&
    placement(ref.file)?.through !== value.metadata.through
  )
    fail();
  return value;
}
export async function resolveVersionLink(
  work: string,
  target: string,
  state: KnowledgeVersions | undefined,
  files: RevisionPublication[],
) {
  const file = relative(revisionDirectory(work, 'revision.md'), target)
    .split(sep)
    .join('/');
  if (!state || file.startsWith('../') || isAbsolute(file)) return;
  const name = target.split(/[\\/]/).at(-1)!;
  const match = name.match(/^(kn-[a-f0-9-]+)--([br]-[a-f0-9-]+)\.md$/);
  if (!match || archivePath(work, file) !== target)
    fail('KNOWLEDGE_REFERENCE_INVALID');
  let ref = Object.values(state.heads).find((r) => r.id === match[1]);
  let last = Number.MAX_SAFE_INTEGER;
  while (ref) {
    const value = await loadRevision(work, ref, files);
    if (value.metadata.through >= last) fail();
    last = value.metadata.through;
    if (ref.revision === match[2]) {
      if (revisionFile(ref) !== file) fail('KNOWLEDGE_REFERENCE_INVALID');
      return value.content;
    }
    ref = value.metadata.previous ?? undefined;
  }
  fail('KNOWLEDGE_REFERENCE_INVALID');
}
async function loadCheckpoint(work: string, ref: CheckpointRef) {
  const text = await archiveText(work, checkpointFile(ref.through));
  if (revisionHash(text) !== ref.hash) fail('KNOWLEDGE_CHECKPOINT_CHANGED');
  const record = decodeCheckpoint(text);
  if (record.through !== ref.through) fail();
  return record;
}
export async function verifyVersionState(
  work: string,
  memory: Tree,
  state: KnowledgeVersions,
  sequence: number,
  memoryHash: string,
) {
  checkVersionState(state, sequence);
  const cp = await loadCheckpoint(work, state.checkpoint);
  if (cp.memoryHash !== memoryHash) fail('KNOWLEDGE_REFERENCE_INVALID');
  const notes = Object.keys(memory).filter((n) => namePattern.test(n));
  if (notes.length !== Object.keys(state.heads).length)
    fail('KNOWLEDGE_REFERENCE_INVALID');
  for (const name of notes) {
    const ref = state.heads[name];
    if (!ref || ref.id !== parseNoteIdentity(memory[name]!).id)
      fail('KNOWLEDGE_REFERENCE_INVALID');
    const { metadata, content } = await loadRevision(work, ref);
    if (
      metadata.name !== name ||
      metadata.through > sequence ||
      metadata.through < state.baseline ||
      revisionLinks(
        content,
        archivePath(work, revisionFile(ref)),
        join(memoryDirectory(work), name),
        memoryDirectory(work),
        work,
      ) !== memory[name]
    )
      fail('KNOWLEDGE_REFERENCE_INVALID');
  }
}
export async function readKnowledgeRevision(
  work: string,
  state: KnowledgeVersions | undefined,
  id: string,
  options: { revision?: string; at?: number } = {},
) {
  if (!state) fail('KNOWLEDGE_REVISIONS_UNAVAILABLE');
  let ref = Object.values(state.heads).find((r) => r.id === id);
  if (!ref) fail('MEMORY_NOT_FOUND');
  if (options.at !== undefined) {
    if (options.at < state.baseline) fail('KNOWLEDGE_LEGACY_HISTORY');
    let cp: CheckpointRef | null = state.checkpoint;
    while (cp && cp.through > options.at)
      cp = (await loadCheckpoint(work, cp)).previous;
    if (!cp || cp.through !== options.at)
      fail('KNOWLEDGE_CHECKPOINT_NOT_FOUND');
    await loadCheckpoint(work, cp);
  }
  let lastThrough = Number.MAX_SAFE_INTEGER;
  while (ref) {
    const value = await loadRevision(work, ref);
    if (value.metadata.through >= lastThrough) fail();
    lastThrough = value.metadata.through;
    if (
      (options.revision === undefined || options.revision === ref.revision) &&
      (options.at === undefined || value.metadata.through <= options.at)
    )
      return { ...value, reference: ref, file: revisionFile(ref) };
    ref = value.metadata.previous ?? undefined;
  }
  fail(
    options.at === undefined
      ? 'KNOWLEDGE_REVISION_NOT_FOUND'
      : 'KNOWLEDGE_NOT_AT_CHECKPOINT',
  );
}

/** Explicit maintenance only: enumerate reachable confirmed revisions, never orphan files. */
export async function knowledgeCatalog(
  work: string,
  state?: KnowledgeVersions,
) {
  const result: {
    id: string;
    revision: string;
    hash: string;
    file: string;
    name: string;
    through: number;
    title: string;
    category?: string;
  }[] = [];
  const seen = new Set<string>();
  for (const head of Object.values(state?.heads ?? {})) {
    let ref: RevisionRef | undefined = head;
    let through = Number.MAX_SAFE_INTEGER;
    while (ref) {
      const key = ref.id + '@' + ref.revision;
      if (seen.has(key)) break;
      seen.add(key);
      const value = await loadRevision(work, ref);
      if (value.metadata.through >= through) fail();
      through = value.metadata.through;
      const file = revisionFile(ref);
      result.push({
        id: ref.id,
        revision: ref.revision,
        hash: ref.hash,
        file,
        name: value.metadata.name,
        through,
        title:
          value.content.match(/^# +([^\r\n]+)$/m)?.[1] ?? value.metadata.name,
        ...(placement(file)?.category
          ? { category: placement(file)!.category }
          : {}),
      });
      ref = value.metadata.previous ?? undefined;
    }
  }
  return result.sort(
    (a, b) =>
      a.through - b.through ||
      a.id.localeCompare(b.id, 'en') ||
      a.revision.localeCompare(b.revision, 'en'),
  );
}

/** Project the existing HEAD metadata into the unchanged logical Curator contract.
 * Only STATE/HISTORY and immutable publications are stored in canonical memory. */
export async function activeKnowledge(work: string, state?: KnowledgeVersions) {
  const tree: Tree = {};
  for (const [name, ref] of Object.entries(state?.heads ?? {})) {
    const { content } = await loadRevision(work, ref);
    tree[name] = revisionLinks(
      content,
      archivePath(work, revisionFile(ref)),
      join(memoryDirectory(work), name),
      memoryDirectory(work),
      work,
    );
  }
  return tree;
}
