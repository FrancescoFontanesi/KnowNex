import { decodeUtf8, sha256 } from '../shared/artifact-io.ts';
import {
  canonicalWork,
  memoryDirectory,
  revisionDirectory,
  organizationFile,
} from '../shared/layout.ts';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { historySegments } from './history.ts';
import { parseNoteIdentity } from './memory-contract.ts';
import { fail, object } from '../shared/check.ts';

type Tree = Record<string, string>;
interface RevisionRef {
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
  previous: null;
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
/**
 * Logical note keys: `knowledge/H000004/<name>.md` for notes filed by that checkpoint.
 * An archived revision (`…kn-<id>--r-….md`) is never a logical key.
 */
const namePattern =
  /^knowledge\/H\d{6,}\/(?![a-z0-9-]*kn-[0-9a-f-]{36}--[br]-)[a-z0-9-]+\.md$/;
const categoryPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const categoryKey = (key: string) =>
  categoryPattern.test(key) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(key);
/**
 * New revision files start with the note name (`storage--kn-…--r-….md`) so people browsing
 * the vault see what a file is. The prefix is cosmetic: identity checks use `name`, without it.
 */
const slug = (logical: string) =>
  logical.slice(logical.lastIndexOf('/') + 1, -3) + '--';
/**
 * `H000002/[category/]<name>--kn-…--r-….md`: the folder is the checkpoint's HISTORY id. The path
 * alone cannot tell `through`, so verifyVersionState checks it against HISTORY.md.
 */
function placement(file: string) {
  const m =
    /^(H\d{6,})\/(?:([a-z0-9-]+)\/)?[a-z0-9-]+?--(kn-[a-f0-9-]+--[br]-[a-f0-9-]+\.md)$/.exec(
      file,
    );
  if (!m || (m[2] !== undefined && !categoryKey(m[2]))) return;
  return { history: m[1]!, category: m[2], name: m[3]! };
}
const revisionHash = (text: string) => sha256(text);
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
    Object.keys(x).length === 4 &&
    typeof x.file === 'string' &&
    placement(x.file)?.name === x.id + '--' + x.revision + '.md'
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
    fail('KNOWLEDGE_REVISION_INVALID');
  const ids = new Set<string>();
  for (const [name, ref] of Object.entries(x.heads)) {
    if (!namePattern.test(name) || !isRef(ref) || ids.has(ref.id))
      fail('KNOWLEDGE_REVISION_INVALID');
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
      fail('KNOWLEDGE_REVISION_INVALID');
  }
  return join(revisionDirectory(work, file), file);
}
async function archiveText(work: string, file: string) {
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
  if (at < 0 || !text.endsWith(' -->\n')) fail('KNOWLEDGE_REVISION_INVALID');
  const content = text.slice(0, at);
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(at + footer.length, -5));
  } catch {
    fail('KNOWLEDGE_REVISION_INVALID');
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
    raw.previous !== null ||
    !Number.isSafeInteger(raw.through) ||
    Number(raw.through) < 0 ||
    typeof raw.checksum !== 'string' ||
    (raw.through !== 0 && !hashPattern.test(raw.checksum)) ||
    raw.contentHash !== revisionHash(content) ||
    parseNoteIdentity(content).id !== raw.id ||
    content.includes(footer)
  )
    fail('KNOWLEDGE_REVISION_INVALID');
  return { metadata: raw as unknown as Revision, content };
}
export function checkPublications(
  files: unknown,
): asserts files is RevisionPublication[] {
  if (!Array.isArray(files)) fail('KNOWLEDGE_REVISION_INVALID');
  const seen = new Set<string>();
  for (const f of files) {
    if (
      !object(f) ||
      Object.keys(f).length !== 2 ||
      typeof f.file !== 'string' ||
      typeof f.content !== 'string' ||
      seen.has(f.file)
    )
      fail('KNOWLEDGE_REVISION_INVALID');
    archivePath('.', f.file);
    seen.add(f.file);
    if (f.file.endsWith('.md')) {
      const { metadata } = decodeRevision(f.content);
      if (
        !placement(f.file) ||
        revisionFile({ ...metadata, file: f.file }) !== f.file
      )
        fail('KNOWLEDGE_REVISION_INVALID');
    } else if (checkpointFile(decodeCheckpoint(f.content).through) !== f.file)
      fail('KNOWLEDGE_REVISION_INVALID');
  }
}
function decodeCheckpoint(text: string) {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    fail('KNOWLEDGE_REVISION_INVALID');
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
    fail('KNOWLEDGE_REVISION_INVALID');
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
interface VersionPlan {
  tree: Tree;
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
  /** HISTORY id of this checkpoint (`H000002`): the folder of the notes it writes. */
  folder?: string,
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
    heads: Record<string, RevisionRef>,
  ) => {
    if (source.includes(footer)) fail('KNOWLEDGE_REVISION_INVALID');
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
      previous: null, // notes are never rewritten: every new revision starts its own chain
      through,
      checksum,
      contentHash: revisionHash(content),
    };
    const text = content + footer + JSON.stringify(metadata) + ' -->\n';
    ref.hash = revisionHash(text);
    files.push({ file: revisionFile(ref), content: text });
    return revisionLinks(content, target, join(memory, name), memory, work);
  };
  // Notes only exist as revisions: a memory with notes but no revision state is not ours.
  if (!prior && Object.keys(before).some((n) => n.startsWith('knowledge/')))
    fail('KNOWLEDGE_REVISION_INVALID');
  const heads = structuredClone(oldHeads);
  // Knowledge is a log: only notes absent from the active tree are new revisions.
  const changed = Object.keys(raw).filter(
    (name) => namePattern.test(name) && !before[name],
  );
  if (Object.keys(categories).some((name) => !changed.includes(name)))
    fail('CURATOR_CATEGORY_INVALID');
  if (changed.length && !/^H\d{6,}$/.test(folder ?? ''))
    fail('KNOWLEDGE_REVISION_INVALID');
  for (const name of changed)
    heads[name] = {
      id: parseNoteIdentity(raw[name]!).id,
      revision: 'r-' + runId,
      hash: '',
      file:
        folder +
        '/' +
        (categories[name] ? categories[name] + '/' : '') +
        slug(name) +
        revisionFile({
          id: parseNoteIdentity(raw[name]!).id,
          revision: 'r-' + runId,
        }),
    };
  for (const name of changed)
    tree[name] = create(name, raw[name]!, heads[name]!.revision, heads);
  tree['STATE.md'] = revisionLinks(
    raw['STATE.md']!,
    join(memory, 'STATE.md'),
    join(memory, 'STATE.md'),
    memory,
    work,
    heads,
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
    fail('KNOWLEDGE_REVISION_INVALID');
  if (!ref.file || !placement(ref.file)) fail('KNOWLEDGE_REVISION_INVALID');
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
  const match = name.match(
    /^[a-z0-9-]+?--(kn-[a-f0-9-]+)--([br]-[a-f0-9-]+)\.md$/,
  );
  if (!match || archivePath(work, file) !== target)
    fail('KNOWLEDGE_REFERENCE_INVALID');
  // Notes are never rewritten: a note has exactly one revision, its head.
  const ref = Object.values(state.heads).find((r) => r.id === match[1]);
  if (!ref || ref.revision !== match[2] || revisionFile(ref) !== file)
    fail('KNOWLEDGE_REFERENCE_INVALID');
  return (await loadRevision(work, ref, files)).content;
}
async function loadCheckpoint(work: string, ref: CheckpointRef) {
  const text = await archiveText(work, checkpointFile(ref.through));
  if (revisionHash(text) !== ref.hash) fail('KNOWLEDGE_CHECKPOINT_CHANGED');
  const record = decodeCheckpoint(text);
  if (record.through !== ref.through) fail('KNOWLEDGE_REVISION_INVALID');
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
    const folder = ref.file && placement(ref.file)?.history;
    if (
      folder &&
      historySegments(memory['HISTORY.md'] ?? '', sequence).find(
        (s) => s.id === folder,
      )?.through !== metadata.through
    )
      fail('KNOWLEDGE_REFERENCE_INVALID');
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
  const ref = Object.values(state.heads).find((r) => r.id === id);
  if (!ref) fail('MEMORY_NOT_FOUND');
  if (options.at !== undefined) {
    let cp: CheckpointRef | null = state.checkpoint;
    while (cp && cp.through > options.at)
      cp = (await loadCheckpoint(work, cp)).previous;
    if (!cp || cp.through !== options.at)
      fail('KNOWLEDGE_CHECKPOINT_NOT_FOUND');
    await loadCheckpoint(work, cp);
  }
  if (options.revision !== undefined && options.revision !== ref.revision)
    fail('KNOWLEDGE_REVISION_NOT_FOUND');
  const value = await loadRevision(work, ref);
  if (options.at !== undefined && value.metadata.through > options.at)
    fail('KNOWLEDGE_NOT_AT_CHECKPOINT');
  return { ...value, reference: ref, file: revisionFile(ref) };
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
  for (const ref of Object.values(state?.heads ?? {})) {
    const value = await loadRevision(work, ref);
    const file = revisionFile(ref);
    result.push({
      id: ref.id,
      revision: ref.revision,
      hash: ref.hash,
      file,
      name: value.metadata.name,
      through: value.metadata.through,
      title:
        value.content.match(/^# +([^\r\n]+)$/m)?.[1] ?? value.metadata.name,
      ...(placement(file)?.category
        ? { category: placement(file)!.category }
        : {}),
    });
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
