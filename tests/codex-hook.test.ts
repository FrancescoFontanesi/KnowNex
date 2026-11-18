import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex hook regression '));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test(
  'the Stop command init installs works in both PowerShell and cmd.exe',
  { skip: process.platform !== 'win32' },
  async (t) => {
    // The command form src/cli/bootstrap.ts writes into a workspace's .codex/hooks.json.
    const declared = 'node ".codex/hooks/knownex-feed.cjs"';
    const scriptArgument = declared.match(/"[^"\r\n]+\.cjs"$/)?.[0];
    assert.ok(
      scriptArgument,
      'hook command must end with a quoted script path',
    );
    for (const shell of ['powershell', 'cmd']) {
      await t.test(shell, async (subtest) => {
        const root = await temporary(subtest);
        await mkdir(join(root, '.codex/hooks'), { recursive: true });
        const script = join(root, '.codex/hooks/feed.cjs');
        await copyFile('.codex/hooks/feed.cjs', script);
        await cp('src', join(root, 'src'), { recursive: true });
        await copyFile('package.json', join(root, 'package.json'));
        const command =
          declared.slice(0, -scriptArgument.length) + '"' + script + '"';
        const input = JSON.stringify({
          hook_event_name: 'Stop',
          session_id: 'synthetic-regression',
          turn_id: 'turn-' + shell,
          last_assistant_message: 'Synthetic final',
        });
        const env = { ...process.env };
        delete env.KNOWNEX_CAPTURE;
        delete env.KNOWNEX_WORKSPACE;
        const result =
          shell === 'powershell'
            ? spawnSync(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', command],
                { input, encoding: 'utf8', windowsHide: true, env },
              )
            : spawnSync(
                process.env.ComSpec || 'cmd.exe',
                ['/C', '"' + command + '"'],
                {
                  input,
                  encoding: 'utf8',
                  windowsHide: true,
                  windowsVerbatimArguments: true,
                  env,
                },
              );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.deepEqual(JSON.parse(result.stdout), {});
        const [frame] = (
          await readFile(
            join(root, '.knownex/internal/feed/project.jsonl'),
            'utf8',
          )
        )
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.equal(frame.block.event.text, 'Synthetic final');
      });
    }
  },
);
