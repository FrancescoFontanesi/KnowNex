import { existsSync } from 'node:fs';
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
  root = resolve(root);
  const legacy = ['feed', 'seed', 'curator'].some((n) =>
    existsSync(join(root, '.knownex', n)),
  );
  if (legacy && existsSync(join(root, '.knownex/internal/feed')))
    throw Object.assign(new Error('WORKSPACE_LAYOUT_AMBIGUOUS'), {
      code: 'WORKSPACE_LAYOUT_AMBIGUOUS',
    });
  const internal = legacy
    ? join(root, '.knownex')
    : join(root, '.knownex/internal');
  return {
    legacy,
    internal,
    work: join(internal, 'curator'),
    memory: legacy
      ? join(root, '.knownex/seed')
      : join(root, '.knownex/memory'),
    feed: join(internal, 'feed'),
    captures: join(internal, 'captures'),
  };
}

/** Old documented CLI arguments remain aliases, never additional files. */
export function resolveWorkArgument(work: string) {
  const path = resolve(work);
  if (canonicalWork(path))
    return workspaceLayout(resolve(path, '../../..')).work;
  if (basename(path) === 'curator' && basename(dirname(path)) === '.knownex')
    return workspaceLayout(resolve(path, '../..')).work;
  return path;
}
export const workspaceFromFeed = (feed: string) =>
  resolve(
    dirname(feed),
    basename(dirname(dirname(feed))) === 'internal' ? '../../..' : '../..',
  );
