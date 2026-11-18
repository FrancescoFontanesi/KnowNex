import { basename, dirname, join, resolve } from 'node:path';

/** Only the new installed layout uses external memory; standalone work stays compatible. */
export const canonicalWork = (work: string) =>
  basename(resolve(work)) === 'curator' &&
  basename(dirname(resolve(work))) === 'internal' &&
  basename(dirname(dirname(resolve(work)))) === '.knownex';
export const memoryDirectory = (work: string) =>
  canonicalWork(work) ? resolve(work, '../../memory') : join(work, 'memory');
export const workFromMemory = (memory: string) =>
  basename(dirname(resolve(memory))) === '.knownex' &&
  basename(memory) === 'memory'
    ? resolve(memory, '../internal/curator')
    : dirname(memory);
export const revisionDirectory = (work: string, file: string) =>
  canonicalWork(work) && file.endsWith('.md')
    ? join(memoryDirectory(work), 'knowledge')
    : join(work, 'revisions');
export const organizationFile = (work: string, name: string) =>
  join(
    canonicalWork(work) && !name.startsWith('taxonomy-changes/')
      ? memoryDirectory(work)
      : work,
    name,
  );

export function workspaceLayout(root: string) {
  const internal = join(resolve(root), '.knownex/internal');
  return {
    internal,
    work: join(internal, 'curator'),
    memory: join(resolve(root), '.knownex/memory'),
    feed: join(internal, 'feed'),
  };
}

export const workspaceFromFeed = (feed: string) =>
  resolve(
    dirname(feed),
    basename(dirname(dirname(feed))) === 'internal' ? '../../..' : '../..',
  );
