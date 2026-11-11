import { decodeUtf8 } from './artifact-io.ts';
import { canonicalWork, workFromMemory } from './layout.ts';
import type { KnowledgeVersions } from './knowledge-revisions.ts';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { historySegments } from './history.ts';
import { parseNoteIdentity } from './memory-contract.ts';
import { withConfirmedMemory } from './curator.ts';
import {
  archivePath,
  readKnowledgeRevision,
  revisionFile,
} from './knowledge-revisions.ts';

import {
  thematicCatalog,
  thematicData,
  revisionCategories,
  thematicHash,
  taxonomyError,
} from './taxonomy.ts';
export type MemoryScope = 'history' | 'knowledge';
export interface MemoryResult {
  id: string;
  type: MemoryScope;
  title: string;
  excerpt: string;
  path: string;
  reference: string;
  revision?: string;
  versionReference?: string;
  section?: { anchor: string; title: string };
  category?: string;
  checkpoint?: number;
  thematicCategories?: string[];
  date?: string;
  events?: { from: number; through: number };
}
interface Entry {
  logicalPath?: string;
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
function revisionPlacement(file?: string): {
  checkpoint?: number;
  category?: string;
} {
  const m = file?.match(/^checkpoint-(\d+)\/(?:([^/]+)\/)?[^/]+\.md$/);
  return m
    ? { checkpoint: Number(m[1]), ...(m[2] ? { category: m[2] } : {}) }
    : {};
}

async function memoryRoot(directory: string) {
  const path = resolve(directory),
    info = await lstat(path);
  if (info.isSymbolicLink()) fail('MEMORY_UNSAFE_PATH');
  if (!info.isDirectory()) fail('MEMORY_INVALID');
  const canonical = await realpath(path);
  if (canonicalWork(workFromMemory(path))) {
    for (
      let parent = dirname(path);
      parent !== dirname(parent);
      parent = dirname(parent)
    )
      if ((await lstat(parent)).isSymbolicLink()) fail('MEMORY_UNSAFE_PATH');
  }
  return canonical;
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
    return decodeUtf8(bytes);
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
  return Promise.all(
    segments.map(async (segment, i) => {
      let content: string;
      if (segment.window) content = await textAt(root, segment.window);
      else {
        const start = starts[i]!.index!,
          marker = `<!-- knownex-history:${segment.id}:end -->`;
        const end = text.indexOf(marker, start) + marker.length;
        content = text.slice(start, end + (text[end] === '\n' ? 1 : 0));
      }
      const field = (name: string) => {
        const value = content.match(new RegExp('^- ' + name + ': (.+)$', 'm'));
        return value ? value[1]! : fail('MEMORY_INVALID');
      };
      const topics = field('Argomenti'),
        description = field('Descrizione'),
        date = field('Data').replaceAll('`', '');
      return {
        result: {
          id: segment.id,
          type: 'history' as const,
          title: topics,
          path: segment.window ?? 'HISTORY.md',
          reference: segment.window ?? 'HISTORY.md#' + segment.id.toLowerCase(),
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
    }),
  );
}

/** Chronological HISTORY index, newest first, without window bodies: pick windows to open. */
export async function memoryHistory(
  directory: string,
  options: { last?: number; before?: string } = {},
) {
  const last = options.last ?? 10;
  if (!Number.isSafeInteger(last) || last < 1 || last > 50)
    fail('MEMORY_INVALID_ID');
  const root = await memoryRoot(directory);
  return withConfirmedMemory(root, async () => {
    const entries = await historyEntries(root);
    let end = entries.length;
    if (options.before !== undefined) {
      end = entries.findIndex((e) => e.result.id === options.before);
      if (end < 0) fail('MEMORY_NOT_FOUND');
    }
    return entries
      .slice(Math.max(0, end - last), end)
      .reverse()
      .map((e) => ({ ...e.result, description: e.description }));
  });
}

async function knowledgeEntries(
  root: string,
  view?: { work: string; versions?: KnowledgeVersions },
): Promise<Entry[]> {
  if (view && canonicalWork(view.work)) {
    const entries: Entry[] = [];
    for (const [logicalPath, head] of Object.entries(
      view.versions?.heads ?? {},
    )) {
      const value = await readKnowledgeRevision(
        view.work,
        view.versions,
        head.id,
      );
      const path = relative(root, archivePath(view.work, value.file))
        .split(sep)
        .join('/');
      const content = value.content;
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
      const title = body.match(/^# +([^\r\n]+)$/m)?.[1]?.trim();
      if (!title) fail('MEMORY_INVALID');
      entries.push({
        logicalPath,
        result: {
          id: head.id,
          type: 'knowledge',
          title,
          path,
          reference: path,
        },
        metadata: head.id,
        headings: headings(body),
        body,
        content,
        description: title,
      });
    }
    return entries;
  }
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

// Same anchor spelling as the memory contract; only ATX headings are selectable.
function sections(text: string) {
  const result: {
    title: string;
    anchor: string;
    level: number;
    start: number;
    end: number;
  }[] = [];
  let fence: string | undefined;
  for (const line of text.matchAll(/^.*(?:\n|$)/gm)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line[0])?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^(#{1,6}) +([^\r\n]+)\r?\n?$/.exec(line[0]);
    if (!match) continue;
    result.push({
      title: match[2]!,
      anchor: match[2]!
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/ /g, '-'),
      level: match[1]!.length,
      start: line.index!,
      end: text.length,
    });
  }
  const stack: typeof result = [];
  for (const item of result) {
    while (stack.length && stack.at(-1)!.level >= item.level)
      stack.pop()!.end = item.start;
    stack.push(item);
  }
  return result;
}

function selectSection<T extends { content: string; reference: string }>(
  result: T,
  anchor?: string,
): T & {
  selection?: {
    anchor: string;
    fromLine: number;
    throughLine: number;
    totalLines: number;
  };
} {
  if (anchor === undefined) return result;
  const matches = sections(result.content).filter((s) => s.anchor === anchor);
  if (!matches.length) fail('MEMORY_SECTION_NOT_FOUND');
  if (matches.length > 1) fail('MEMORY_AMBIGUOUS_SECTION');
  const section = matches[0]!;
  const content = result.content.slice(section.start, section.end);
  return {
    ...result,
    content,
    reference: result.reference + '#' + encodeURIComponent(anchor),
    selection: {
      anchor,
      fromLine: result.content.slice(0, section.start).split('\n').length,
      throughLine: result.content
        .slice(0, section.start + content.replace(/\n$/, '').length)
        .split('\n').length,
      totalLines: result.content.replace(/\n$/, '').split('\n').length,
    },
  };
}

function excerpt(entry: Entry, terms: string[]) {
  const hits = [...entry.body.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)]
    .map((m) => ({
      at: m.index!,
      end: m.index! + m[0].length,
      term: words(m[0]).join(''),
    }))
    .filter((m) => terms.includes(m.term));
  // Densest distinct query terms in a fixed window; ties keep the first passage.
  const counts = new Map<string, number>();
  let right = 0,
    best = 0,
    position: number | undefined,
    matchEnd = 0;
  for (let left = 0; left < hits.length; left++) {
    while (right < hits.length && hits[right]!.end - hits[left]!.at <= 180) {
      const term = hits[right++]!.term;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    if (counts.size > best) {
      best = counts.size;
      position = hits[left]!.at;
      matchEnd = hits[right - 1]!.end;
    }
    const term = hits[left]!.term,
      count = counts.get(term) ?? 0;
    if (count <= 1) counts.delete(term);
    else counts.set(term, count - 1);
    if (right === left) right++;
  }
  if (position === undefined)
    return { text: clip(entry.description.replace(/\s+/g, ' ').trim(), 240) };
  const before = [...entry.body.slice(0, position)].slice(-60).join('');
  const candidates = sections(entry.body);
  const section = candidates
    .filter((s) => s.start <= position && s.end > position)
    .at(-1);
  return {
    text: clip(
      (before + entry.body.slice(position)).replace(/\s+/g, ' ').trim(),
      240,
    ),
    ...(entry.result.type === 'knowledge' &&
    section &&
    section.end >= matchEnd &&
    section.level > 1 &&
    section.anchor.length <= 160 &&
    candidates.filter((s) => s.anchor === section.anchor).length === 1
      ? { section: { anchor: section.anchor, title: clip(section.title, 160) } }
      : {}),
  };
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
  return withConfirmedMemory(root, async (view) => {
    const entries = [
      ...(scope === 'knowledge' ? [] : await historyEntries(root)),
      ...(scope === 'history' ? [] : await knowledgeEntries(root, view)),
    ];
    const thematic =
      view && scope !== 'history' ? await thematicData(view.work) : undefined;
    return entries
      .map((entry) => {
        const fields = [
          entry.result.title,
          entry.metadata +
            '\n' +
            (view?.versions?.heads[entry.logicalPath ?? entry.result.path]
              ?.file ?? '') +
            '\n' +
            (thematic &&
            view?.versions?.heads[entry.logicalPath ?? entry.result.path]
              ? revisionCategories(
                  thematic.data,
                  entry.result.id +
                    '@' +
                    view.versions.heads[entry.logicalPath ?? entry.result.path]!
                      .revision,
                  revisionPlacement(
                    view.versions.heads[entry.logicalPath ?? entry.result.path]!
                      .file,
                  ).category,
                ).join(' ')
              : ''),
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
      .map(({ entry }) => {
        const passage = excerpt(entry, terms);
        return {
          ...entry.result,
          ...(thematic &&
          view?.versions?.heads[entry.logicalPath ?? entry.result.path]
            ? {
                thematicCategories: revisionCategories(
                  thematic.data,
                  entry.result.id +
                    '@' +
                    view.versions.heads[entry.logicalPath ?? entry.result.path]!
                      .revision,
                  revisionPlacement(
                    view.versions.heads[entry.logicalPath ?? entry.result.path]!
                      .file,
                  ).category,
                ),
              }
            : {}),
          ...(passage.section
            ? {
                section: passage.section,
                reference:
                  entry.result.path +
                  '#' +
                  encodeURIComponent(passage.section.anchor),
              }
            : {}),
          ...(view?.versions?.heads[entry.logicalPath ?? entry.result.path]
            ? {
                revision:
                  view.versions.heads[entry.logicalPath ?? entry.result.path]!
                    .revision,
                versionReference: relative(
                  root,
                  archivePath(
                    view.work,
                    revisionFile(
                      view.versions.heads[
                        entry.logicalPath ?? entry.result.path
                      ]!,
                    ),
                  ),
                )
                  .split(sep)
                  .join('/'),
                ...revisionPlacement(
                  view.versions.heads[entry.logicalPath ?? entry.result.path]!
                    .file,
                ),
              }
            : {}),
          title: clip(entry.result.title, 160),
          excerpt: passage.text,
        };
      });
  });
}

export async function memoryRead(
  directory: string,
  id: string,
  options: { at?: string | number } = {},
) {
  const parts = id.split('#');
  if (parts.length > 2 || (parts.length === 2 && !parts[1]))
    fail('MEMORY_INVALID_ID');
  id = parts[0]!;
  let anchor: string | undefined;
  try {
    anchor = parts[1] === undefined ? undefined : decodeURIComponent(parts[1]);
  } catch {
    fail('MEMORY_INVALID_ID');
  }
  if (anchor !== undefined && /[#\r\n\0]/.test(anchor))
    fail('MEMORY_INVALID_ID');
  if (id === 'HISTORY.md' && /^h\d{6,}$/.test(anchor ?? '')) {
    id = anchor!.toUpperCase();
    anchor = undefined;
  }
  const window = /^history\/(H\d{6,})\.md$/.exec(id);
  if (window) id = window[1]!;
  const notePath = /^knowledge\/[a-z0-9-]+\.md$/.test(id) ? id : undefined;
  const archived =
    /^(?:\.\.\/revisions\/|knowledge\/)((?:checkpoint-\d{4,}\/(?:[a-z0-9-]+\/)?(?:[a-z0-9-]+?--)?)?(kn-[0-9a-f-]{36})--([br]-\d+-\d+-[0-9a-f-]{36})\.md)$/.exec(
      id,
    );
  if (archived) id = archived[2] + '@' + archived[3];
  const [logical, revision, ...extra] = id.split('@');
  if (
    extra.length ||
    (revision !== undefined &&
      !/^[br]-\d+-\d+-[0-9a-f-]{36}$/.test(revision)) ||
    (revision !== undefined && options.at !== undefined)
  )
    fail('MEMORY_INVALID_ID');
  id = logical!;
  const history = /^H\d{6,}$/.test(id),
    knowledge = !!notePath || /^kn-[0-9a-f-]{36}$/.test(id);
  if (!history && !knowledge) fail('MEMORY_INVALID_ID');
  if (history && anchor !== undefined) fail('MEMORY_INVALID_ID');
  const root = await memoryRoot(directory);
  return withConfirmedMemory(root, async (view) => {
    const selected = notePath
      ? (await knowledgeEntries(root, view)).find(
          (e) => (e.logicalPath ?? e.result.path) === notePath,
        )
      : undefined;
    const thematic =
      view && knowledge ? await thematicData(view.work) : undefined;
    if (notePath && !selected) fail('MEMORY_NOT_FOUND');
    if (selected) id = selected.result.id;
    if (revision !== undefined || options.at !== undefined) {
      if (!knowledge) fail('MEMORY_INVALID_ID');
      if (!view) fail('KNOWLEDGE_REVISIONS_UNAVAILABLE');
      let at: number | undefined;
      if (options.at !== undefined) {
        const value = String(options.at);
        if (/^H\d{6,}$/.test(value)) {
          const segment = historySegments(
            await textAt(root, 'HISTORY.md'),
            view.through,
          ).find((s) => s.id === value);
          if (!segment) fail('MEMORY_NOT_FOUND');
          at = segment.from - 1;
        } else {
          if (
            !/^(0|[1-9]\d*)$/.test(value) ||
            !Number.isSafeInteger(Number(value))
          )
            fail('MEMORY_INVALID_ID');
          at = Number(value);
        }
      }
      const result = await readKnowledgeRevision(view.work, view.versions, id, {
        revision,
        at,
      });
      if (archived && archived[1] !== result.file) fail('MEMORY_NOT_FOUND');
      const path = relative(root, archivePath(view.work, result.file))
        .split(sep)
        .join('/');
      return selectSection(
        {
          id,
          type: 'knowledge' as const,
          path,
          reference: path,
          revision: result.reference.revision,
          sha256: result.reference.hash,
          through: result.metadata.through,
          ...revisionPlacement(result.file),
          ...(thematic
            ? {
                thematicCategories: revisionCategories(
                  thematic.data,
                  id + '@' + result.reference.revision,
                  revisionPlacement(result.file).category,
                ),
              }
            : {}),
          content: result.content,
        },
        anchor,
      );
    }
    const entries = history
      ? await historyEntries(root)
      : selected
        ? [selected]
        : await knowledgeEntries(root, view);
    const entry = entries.find((e) => e.result.id === id);
    if (!entry) fail('MEMORY_NOT_FOUND');
    const { title: _title, ...reference } = entry.result;
    const version =
      view?.versions?.heads[entry.logicalPath ?? entry.result.path];
    return selectSection(
      {
        ...reference,
        content: entry.content,
        ...(version
          ? {
              ...(thematic
                ? {
                    thematicCategories: revisionCategories(
                      thematic.data,
                      id + '@' + version.revision,
                      revisionPlacement(version.file).category,
                    ),
                  }
                : {}),
              revision: version.revision,
              versionReference: relative(
                root,
                archivePath(view!.work, revisionFile(version)),
              )
                .split(sep)
                .join('/'),
              ...revisionPlacement(version.file),
            }
          : {}),
      },
      anchor,
    );
  });
}

export async function memoryCategory(
  directory: string,
  category: string,
  options: { limit?: number; cursor?: string } = {},
) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category))
    taxonomyError('TAXONOMY_CATEGORY_UNKNOWN');
  const limit = options.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    taxonomyError('TAXONOMY_ARGUMENT_INVALID');
  const root = await memoryRoot(directory);
  return withConfirmedMemory(root, async (view) => {
    if (!view) taxonomyError('KNOWLEDGE_REVISIONS_UNAVAILABLE');
    const base = await thematicCatalog(view.work, view.versions);
    const fingerprint = thematicHash({
      category,
      checkpoint: view.versions?.checkpoint ?? view.through,
      metadata: base.fingerprint,
    });
    let offset = 0;
    if (options.cursor !== undefined) {
      try {
        if (
          options.cursor.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(options.cursor)
        )
          throw Error();
        const c = JSON.parse(
          Buffer.from(options.cursor, 'base64url').toString('utf8'),
        );
        if (
          c.fingerprint !== fingerprint ||
          !Number.isSafeInteger(c.offset) ||
          c.offset < 0
        )
          throw Error();
        offset = c.offset;
      } catch {
        taxonomyError('TAXONOMY_CURSOR_INVALID');
      }
    }
    const entries = Object.hasOwn(base.taxonomy, category)
      ? base.revisions.filter((r) =>
          revisionCategories(
            base.data,
            r.id + '@' + r.revision,
            r.category,
          ).includes(category),
        )
      : [];
    if (offset > entries.length) taxonomyError('TAXONOMY_CURSOR_INVALID');
    const results = entries.slice(offset, offset + limit).map((r) => ({
      id: r.id,
      revision: r.revision,
      title: r.title,
      through: r.through,
      sha256: r.hash,
      reference: relative(root, archivePath(view.work, r.file))
        .split(sep)
        .join('/'),
      classification: Object.hasOwn(
        base.data.assignments,
        r.id + '@' + r.revision,
      )
        ? 'retroactive'
        : 'original',
      current: Object.values(view.versions?.heads ?? {}).some(
        (h) => h.id === r.id && h.revision === r.revision,
      ),
    }));
    const next = offset + results.length;
    return {
      status: results.length ? 'ok' : 'not_found',
      category,
      description: base.taxonomy[category] ?? null,
      total: entries.length,
      historicalCoverage: 'versioned-only',
      results,
      nextCursor:
        next < entries.length
          ? Buffer.from(JSON.stringify({ fingerprint, offset: next })).toString(
              'base64url',
            )
          : null,
    };
  });
}
