import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function snapshot(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await snapshot(p, base)));
    else if (!/\.cjs$|^package\.json$/.test(e.name))
      out.push(
        `${p.slice(base.length)}:${(await readFile(p)).toString('hex')}`,
      );
  }
  return out.sort();
}

const entries = [
  ['feed', { hook_event_name: 'UserPromptSubmit', prompt: 'p', turn_id: 't' }],
  [
    'feed',
    { hook_event_name: 'Stop', last_assistant_message: 'a', turn_id: 't' },
  ],
  ['session', { hook_event_name: 'SessionStart' }],
] as const;

for (const [name, extra] of entries) {
  test(`KNOWNEX_CAPTURE=0: ${name}.cjs ${extra.hook_event_name} writes nothing and emits no context`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'knownex optout '));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.codex/hooks'), { recursive: true });
    await cp('src', join(root, 'src'), { recursive: true });
    await copyFile('package.json', join(root, 'package.json'));
    const script = join(root, `.codex/hooks/${name}.cjs`);
    await copyFile(`.codex/hooks/${name}.cjs`, script);
    const source = join(root, 'source.jsonl');
    await writeFile(source, '{"a":1}\n');
    const payload = {
      session_id: 's',
      transcript_path: source,
      ...extra,
    };
    const run = (capture?: string) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KNOWNEX_WORKSPACE: root,
      };
      delete env.KNOWNEX_CAPTURE;
      if (capture !== undefined) env.KNOWNEX_CAPTURE = capture;
      return spawnSync(process.execPath, [script], {
        input: JSON.stringify(payload),
        cwd: root,
        encoding: 'utf8',
        env,
      });
    };
    const before = await snapshot(root);
    const off = run('0');
    assert.equal(off.status, 0);
    assert.equal(off.stdout, '');
    assert.deepEqual(await snapshot(root), before);
    // Control: without the variable the behavior stays the current one.
    const on = run();
    assert.equal(on.status, 0);
    if (name === 'session') assert.match(on.stdout, /additionalContext/);
    else assert.notDeepEqual(await snapshot(root), before);
  });
}
