import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { historySegments } from './history.ts';
import { parseNoteIdentity } from './memory-contract.ts';
import { withConfirmedMemory } from './curator.ts';

export type MemoryScope = 'history' | 'knowledge';
export interface MemoryResult {
  id: string;
  type: MemoryScope;
  title: string;
  excerpt: string;
  path: string;
  reference: string;
  date?: string;
  events?: { from: number; through: number };
}
interface Entry {
  result: Omit<MemoryResult, 'excerpt'>;
  metadata: string;
  headings: string;
  body: string;
  content: string;
  description: string;
}
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const clip = (text: string, length: number) => {
  const chars = [...text];
  return chars.length > length
    ? chars.slice(0, length - 1).join('') + '…'
    : text;
};
const words = (text: string) =>
  text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
const headings = (text: string) =>
  [...text.matchAll(/^#{1,6} +([^\r\n]+)$/gm)].map((m) => m[1]!).join('\n');

async function memoryRoot(directory: string) {
  const path = resolve(directory),
    info = await lstat(path);
  if (info.isSymbolicLink()) fail('MEMORY_UNSAFE_PATH');
  if (!info.isDirectory()) fail('MEMORY_INVALID');
  return realpath(path);
}
async function insidePath(root: string, name: string, directory = false) {
  let path = root;
  for (const part of name.split('/')) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) fail('MEMORY_UNSAFE_PATH');
  }
  const canonical = await realpath(path),
    rel = relative(root, canonical);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
    fail('MEMORY_UNSAFE_PATH');
  const info = await lstat(canonical);
  if (directory ? !info.isDirectory() : !info.isFile()) fail('MEMORY_INVALID');
  return canonical;
}
async function textAt(root: string, name: string) {
  const file = await insidePath(root, name);
  const bytes = await readFile(file);
  // A replacement by a symlink during the read must not escape the authorized root.
  if ((await insidePath(root, name)) !== file) fail('MEMORY_UNSAFE_PATH');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail('MEMORY_INVALID');
  }
}

export async function memoryState(directory: string) {
  const root = await memoryRoot(directory);
  return withConfirmedMemory(root, () => textAt(root, 'STATE.md'));
}

async function historyEntries(root: string): Promise<Entry[]> {
  const text = await textAt(root, 'HISTORY.md');
  const starts = [
    ...text.matchAll(/^<!-- knownex-history:(H\d+):begin -->$/gm),
  ];
  if (new Set(starts.map((m) => m[1])).size !== starts.length)
    fail('MEMORY_AMBIGUOUS_ID');
  let segments: ReturnType<typeof historySegments>;
  try {
    segments = historySegments(text, Number.MAX_SAFE_INTEGER);
  } catch {
    return fail('MEMORY_INVALID');
  }
  return segments.map((segment, i) => {
    const start = starts[i]!.index!,
      marker = `<!-- knownex-history:${segment.id}:end -->`;
    const end = text.indexOf(marker, start) + marker.length;
    const content = text.slice(start, end + (text[end] === '\n' ? 1 : 0));
    const field = (name: string) =>
      content.match(new RegExp('^- ' + name + ': (.+)$', 'm'))![1]!;
    const topics = field('Argomenti'),
      description = field('Descrizione'),
      date = field('Data').replaceAll('`', '');
    return {
      result: {
        id: segment.id,
        type: 'history',
        title: topics,
        path: 'HISTORY.md',
        reference: 'HISTORY.md#' + segment.id.toLowerCase(),
        date: clip(date, 64),
        events: { from: segment.from, through: segment.through },
      },
      metadata: [segment.id, date, topics, description, field('Eventi')].join(
        '\n',
      ),
      headings: headings(content),
      body: content,
      content,
      description,
    };
  });
}

async function knowledgeEntries(root: string): Promise<Entry[]> {
  let folder: string;
  try {
    folder = await insidePath(root, 'knowledge', true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: Entry[] = [],
    ids = new Set<string>();
  for (const name of (await readdir(folder)).sort()) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (!/^[a-z0-9-]+\.md$/.test(name)) fail('MEMORY_INVALID');
    const path = 'knowledge/' + name,
      content = await textAt(root, path);
    let id: string;
    try {
      id = parseNoteIdentity(content).id;
    } catch {
      return fail('MEMORY_INVALID');
    }
    if (ids.has(id)) fail('MEMORY_AMBIGUOUS_ID');
    ids.add(id);
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const title = body.match(/^# +([^\r\n]+)$/m)?.[1]?.trim();
    if (!title) fail('MEMORY_INVALID');
    result.push({
      result: { id, type: 'knowledge', title, path, reference: path },
      metadata: id,
      headings: headings(body),
      body,
      content,
      description: title,
    });
  }
  return result;
}

function excerpt(entry: Entry, terms: string[]) {
  for (const match of entry.body.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!terms.includes(words(match[0]).join(''))) continue;
    const before = [...entry.body.slice(0, match.index)].slice(-60).join('');
    return clip(
      (before + entry.body.slice(match.index)).replace(/\s+/g, ' ').trim(),
      240,
    );
  }
  return clip(entry.description.replace(/\s+/g, ' ').trim(), 240);
}

/** AND lexical search. Field presence, never term frequency, determines ranking. */
export async function memoryFind(
  directory: string,
  query: string,
  scope?: MemoryScope,
): Promise<MemoryResult[]> {
  const terms = [...new Set(words(query))];
  if (!terms.length) fail('MEMORY_QUERY_INVALID');
  if (scope !== undefined && scope !== 'history' && scope !== 'knowledge')
    fail('MEMORY_INVALID_SCOPE');
  const root = await memoryRoot(directory);
  return withConfirmedMemory(root, async () => {
    const entries = [
      ...(scope === 'knowledge' ? [] : await historyEntries(root)),
      ...(scope === 'history' ? [] : await knowledgeEntries(root)),
    ];
    return entries
      .map((entry) => {
        const fields = [
          entry.result.title,
          entry.metadata,
          entry.headings,
          entry.body,
        ].map((s) => new Set(words(s)));
        const weights = [8, 5, 3, 1];
        if (terms.some((t) => !fields.some((f) => f.has(t))))
          return { entry, score: 0 };
        const score = terms.reduce(
          (sum, t) =>
            sum +
            fields.reduce((n, f, i) => n + (f.has(t) ? weights[i]! : 0), 0),
          0,
        );
        return { entry, score };
      })
      .filter((r) => r.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.entry.result.type < b.entry.result.type
            ? -1
            : a.entry.result.type > b.entry.result.type
              ? 1
              : a.entry.result.id < b.entry.result.id
                ? -1
                : a.entry.result.id > b.entry.result.id
                  ? 1
                  : 0),
      )
      .slice(0, 5)
      .map(({ entry }) => ({
        ...entry.result,
        title: clip(entry.result.title, 160),
        excerpt: excerpt(entry, terms),
      }));
  });
}

export async function memoryRead(directory: string, id: string) {
  const history = /^H\d{6,}$/.test(id),
    knowledge = /^kn-[0-9a-f-]{36}$/.test(id);
  if (!history && !knowledge) fail('MEMORY_INVALID_ID');
  const root = await memoryRoot(directory);
  return withConfirmedMemory(root, async () => {
    const entries = history
      ? await historyEntries(root)
      : await knowledgeEntries(root);
    const entry = entries.find((e) => e.result.id === id);
    if (!entry) fail('MEMORY_NOT_FOUND');
    const { title: _title, ...reference } = entry.result;
    return { ...reference, content: entry.content };
  });
}
