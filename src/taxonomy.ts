import { memoryDirectory, canonicalWork, organizationFile } from './layout.ts';
import { archivePath } from './knowledge-revisions.ts';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  checkTaxonomy,
  knowledgeCatalog,
  readTaxonomy,
  type KnowledgeVersions,
} from './knowledge-revisions.ts';

export const thematicHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const revisionKey =
  /^kn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@[br]-\d+-\d+-[0-9a-f-]{36}$/;
const runKey = /^t-[0-9a-f]{64}$/;
export function taxonomyError(code: string): never {
  throw Object.assign(new Error(code), { code });
}
export interface ThematicData {
  version: 1;
  assignments: Record<string, string[]>;
  receipt?: { id: string; hash: string };
}
export interface OrganizationPlan {
  mode: 'taxonomy' | 'taxonomy-rebuild';
  previous: Record<string, string | null>;
  next: Record<string, string>;
}
export const organizationPath = (name: string) =>
  name === 'taxonomy.json' ||
  name === 'taxonomy-associations.json' ||
  /^taxonomy-changes\/t-[0-9a-f]{64}\.json$/.test(name) ||
  /^topics\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name);

export async function organizationText(
  work: string,
  name: string,
): Promise<string | null> {
  if (!organizationPath(name)) taxonomyError('TAXONOMY_PATH_INVALID');
  work = await realpath(work);
  let path =
    canonicalWork(work) && !name.startsWith('taxonomy-changes/')
      ? memoryDirectory(work)
      : work;
  try {
    for (const part of name.split('/')) {
      path = join(path, part);
      if (
        (await lstat(path)).isSymbolicLink() ||
        (await realpath(path)) !== resolve(path)
      )
        taxonomyError('TAXONOMY_PATH_INVALID');
    }
    if (!(await lstat(path)).isFile()) taxonomyError('TAXONOMY_PATH_INVALID');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      await readFile(path),
    );
    if (
      (await lstat(path)).isSymbolicLink() ||
      (await realpath(path)) !== resolve(path)
    )
      taxonomyError('TAXONOMY_PATH_INVALID');
    return text;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export function checkThematic(value: unknown): asserts value is ThematicData {
  if (
    !object(value) ||
    value.version !== 1 ||
    !object(value.assignments) ||
    Object.keys(value).some(
      (k) => !['version', 'assignments', 'receipt'].includes(k),
    )
  )
    taxonomyError('TAXONOMY_INVALID');
  for (const [key, categories] of Object.entries(value.assignments))
    if (
      !revisionKey.test(key) ||
      !Array.isArray(categories) ||
      categories.some((c) => typeof c !== 'string') ||
      new Set(categories).size !== categories.length
    )
      taxonomyError('TAXONOMY_INVALID');
  if (
    value.receipt !== undefined &&
    (!object(value.receipt) ||
      Object.keys(value.receipt).length !== 2 ||
      typeof value.receipt.id !== 'string' ||
      !runKey.test(value.receipt.id) ||
      typeof value.receipt.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.receipt.hash))
  )
    taxonomyError('TAXONOMY_INVALID');
}
export async function thematicData(work: string) {
  const taxonomy = await readTaxonomy(work);
  const text = await organizationText(work, 'taxonomy-associations.json');
  const data: unknown =
    text === null ? { version: 1, assignments: {} } : JSON.parse(text);
  checkThematic(data);
  if (text !== null && !data.receipt)
    taxonomyError('TAXONOMY_INTEGRITY_CHANGED');
  for (const categories of Object.values(data.assignments))
    if (categories.some((c) => !Object.hasOwn(taxonomy, c)))
      taxonomyError('TAXONOMY_CATEGORY_UNKNOWN');
  if (data.receipt) {
    const receipt = await organizationText(
      work,
      'taxonomy-changes/' + data.receipt.id + '.json',
    );
    if (
      receipt === null ||
      createHash('sha256').update(receipt).digest('hex') !==
        data.receipt.hash ||
      JSON.parse(receipt).after !==
        thematicHash({ taxonomy, assignments: data.assignments })
    )
      taxonomyError('TAXONOMY_INTEGRITY_CHANGED');
  }
  return { taxonomy, data, fingerprint: thematicHash({ taxonomy, data }) };
}
export function revisionCategories(
  data: ThematicData,
  key: string,
  original?: string,
) {
  return Object.hasOwn(data.assignments, key)
    ? data.assignments[key]!
    : original
      ? [original]
      : [];
}
export async function thematicCatalog(
  work: string,
  versions?: KnowledgeVersions,
) {
  const state = await thematicData(work);
  const revisions = await knowledgeCatalog(work, versions);
  const keys = new Set(revisions.map((r) => r.id + '@' + r.revision));
  if (Object.keys(state.data.assignments).some((k) => !keys.has(k)))
    taxonomyError('TAXONOMY_REVISION_UNKNOWN');
  return { ...state, revisions };
}
export function taxonomyProposal(
  raw: unknown,
  base: Awaited<ReturnType<typeof thematicCatalog>>,
) {
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (k) => !['categories', 'assignments', 'explanations'].includes(k),
    ) ||
    !object(raw.categories) ||
    !object(raw.assignments) ||
    (raw.explanations !== undefined && typeof raw.explanations !== 'string')
  )
    taxonomyError('TAXONOMY_PROPOSAL_INVALID');
  checkTaxonomy(raw.categories);
  const taxonomy = { ...base.taxonomy, ...raw.categories };
  const assignments = { ...base.data.assignments, ...raw.assignments };
  const data: unknown = { version: 1, assignments };
  checkThematic(data);
  const keys = new Set(base.revisions.map((r) => r.id + '@' + r.revision));
  if (Object.keys(data.assignments).some((k) => !keys.has(k)))
    taxonomyError('TAXONOMY_REVISION_UNKNOWN');
  if (
    Object.values(data.assignments).some((v) =>
      v.some((c) => !Object.hasOwn(taxonomy, c)),
    )
  )
    taxonomyError('TAXONOMY_CATEGORY_UNKNOWN');
  return {
    taxonomy,
    assignments: data.assignments,
    explanations: raw.explanations ?? '',
    changed:
      thematicHash({ taxonomy, assignments }) !==
      thematicHash({
        taxonomy: base.taxonomy,
        assignments: base.data.assignments,
      }),
  };
}
export function thematicIndexes(
  work: string,
  taxonomy: Record<string, string>,
  data: ThematicData,
  revisions: Awaited<ReturnType<typeof knowledgeCatalog>>,
) {
  const files: Record<string, string> = {};
  const clean = (text: string) => text.replace(/[\[\]<>\r\n]/g, ' ');
  let home =
    '# Temi KnowNex\n\nVista derivata ricostruibile. Le classificazioni non modificano fatti o decisioni storiche.\n\n';
  for (const key of Object.keys(taxonomy).sort()) {
    const name = 'topics/category-' + key + '.md';
    home += `- [${key}](category-${key}.md): ${clean(taxonomy[key]!)}\n`;
    let text = `# ${key}\n\n${taxonomy[key]}\n\nVista tematica derivata; le associazioni retroattive sono organizzazione successiva, non fatti storici.\n`;
    let through = -1;
    for (const r of revisions)
      if (
        revisionCategories(data, r.id + '@' + r.revision, r.category).includes(
          key,
        )
      ) {
        if (through !== r.through) {
          through = r.through;
          text += `\n## Checkpoint ${through}\n\n`;
        }
        const href = relative(
          dirname(organizationFile(work, 'topics/index.md')),
          archivePath(work, r.file),
        )
          .split(sep)
          .map(encodeURIComponent)
          .join('/');
        text += `- [${clean(r.title)}](${href}) — ${r.id}@${r.revision}${Object.hasOwn(data.assignments, r.id + '@' + r.revision) ? ' (classificazione retroattiva)' : ''}\n`;
      }
    files[name] = text;
  }
  files['topics/index.md'] = home;
  return files;
}
export function checkOrganization(
  value: unknown,
): asserts value is OrganizationPlan {
  if (
    !object(value) ||
    !['taxonomy', 'taxonomy-rebuild'].includes(value.mode as string) ||
    !object(value.previous) ||
    !object(value.next) ||
    Object.keys(value).length !== 3 ||
    JSON.stringify(Object.keys(value.previous).sort()) !==
      JSON.stringify(Object.keys(value.next).sort())
  )
    taxonomyError('CURATOR_RECOVERY_INVALID');
  for (const [name, text] of Object.entries(value.next))
    if (
      !organizationPath(name) ||
      typeof text !== 'string' ||
      !(
        value.previous[name] === null ||
        typeof value.previous[name] === 'string'
      ) ||
      (value.mode === 'taxonomy-rebuild' && !name.startsWith('topics/'))
    )
      taxonomyError('CURATOR_RECOVERY_INVALID');
  if (value.mode === 'taxonomy') {
    if (
      typeof value.next['taxonomy.json'] !== 'string' ||
      typeof value.next['taxonomy-associations.json'] !== 'string'
    )
      taxonomyError('CURATOR_RECOVERY_INVALID');
    const taxonomy: unknown = JSON.parse(value.next['taxonomy.json']);
    checkTaxonomy(taxonomy);
    const data: unknown = JSON.parse(value.next['taxonomy-associations.json']);
    checkThematic(data);
    if (!data.receipt) taxonomyError('CURATOR_RECOVERY_INVALID');
    const receiptPath = 'taxonomy-changes/' + data.receipt.id + '.json';
    if (
      value.previous[receiptPath] !== null ||
      Object.keys(value.next).some(
        (name) => name.startsWith('taxonomy-changes/') && name !== receiptPath,
      ) ||
      Object.values(data.assignments).some((categories) =>
        categories.some((key) => !Object.hasOwn(taxonomy, key)),
      )
    )
      taxonomyError('CURATOR_RECOVERY_INVALID');
    const receipt = value.next[receiptPath];
    if (
      typeof receipt !== 'string' ||
      createHash('sha256').update(receipt).digest('hex') !==
        data.receipt.hash ||
      JSON.parse(receipt).after !==
        thematicHash({ taxonomy, assignments: data.assignments })
    )
      taxonomyError('CURATOR_RECOVERY_INVALID');
  }
}
