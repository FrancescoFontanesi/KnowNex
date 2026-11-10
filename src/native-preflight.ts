import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withNativeRpc } from './native-rpc.ts';

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
// Compare filesystem locations only. Approval always comes from the RPC result
// for the caller's exact cwd, never from merging differently spelled trust keys.
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

/** Approval readiness only: never executes hooks, captures prompts or consumes authority. */
export async function nativePreflight(workspace: string) {
  const root = resolve(workspace);
  await realpath(root); // Check existence without rewriting Codex's hook identity.
  return withNativeRpc(
    root,
    'CURATOR_NATIVE_HOOKS_UNAVAILABLE',
    async (call) => {
      const effective = await call('config/read', {
        cwd: root,
        includeLayers: false,
      });
      const config = object(effective.config) ? effective.config : {};
      const runtimeEnabled =
        object(config.features) && config.features.hooks === true;
      const result = await call('hooks/list', { cwds: [root] });
      if (!Array.isArray(result.data))
        throw Object.assign(new Error(), {
          code: 'CURATOR_NATIVE_HOOKS_INVALID',
        });
      const entry = result.data.find(
        (e) => object(e) && typeof e.cwd === 'string' && samePath(e.cwd, root),
      );
      if (!object(entry) || !Array.isArray(entry.hooks))
        throw Object.assign(new Error(), {
          code: 'CURATOR_NATIVE_HOOKS_INVALID',
        });
      const commands = ['knownex-feed.cjs', 'feed.cjs'].map(
        (name) => `node ".codex/hooks/${name}"`,
      );
      const hooks = await Promise.all(
        ['userPromptSubmit', 'stop'].map(async (event) => {
          const matches = (entry.hooks as unknown[]).filter(
            (h) =>
              object(h) &&
              h.eventName === event &&
              h.source === 'project' &&
              typeof h.sourcePath === 'string' &&
              samePath(h.sourcePath, join(root, '.codex/hooks.json')) &&
              commands.includes(h.command as string),
          ) as Record<string, unknown>[];
          const script =
            matches[0]?.command === commands[0]
              ? 'knownex-feed.cjs'
              : 'feed.cjs';
          const file = await lstat(join(root, '.codex/hooks', script)).catch(
            (e: NodeJS.ErrnoException) => {
              if (e.code !== 'ENOENT') throw e;
              return null;
            },
          );
          const scriptAvailable = !!file?.isFile() && !file.isSymbolicLink();
          const status =
            matches.length === 0
              ? 'absent'
              : matches.length !== 1
                ? 'ambiguous'
                : !runtimeEnabled || matches[0]!.enabled !== true
                  ? 'disabled'
                  : matches[0]!.trustStatus !== 'trusted'
                    ? 'unapproved'
                    : !scriptAvailable
                      ? 'unavailable'
                      : 'approved';
          return { event, status, scriptAvailable };
        }),
      );
      const ready = hooks.every((h) => h.status === 'approved');
      return {
        status: ready ? ('ready' as const) : ('blocked' as const),
        workspace: root,
        runtimeEnabled,
        hooks,
        executionVerified: false,
        ...(ready
          ? {}
          : {
              action:
                'Open Codex in this workspace; use /hooks or Review hooks to enable and approve the KnowNex capture hooks. Missing hooks require checking the installation. No trust settings were changed.',
            }),
      };
    },
  );
}
