import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  launchCheckpoint,
  providerCommand,
  spawnProvider,
  type RunProvider,
} from '../src/checkpoint-launcher.ts';
import { writeCurationDraft } from '../src/curation-io.ts';
import { emptyMemory } from '../src/curator.ts';
import { appendFeedEvent } from '../src/feed.ts';
import { nativeFixture } from './native-fixture.ts';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knownex-launch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory'),
    feed = join(root, '.knownex/internal/feed');
  await mkdir(memory, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  const peer = await nativeFixture(feed);
  peer.set('launch', ['facts']);
  const prior = process.env.KNOWNEX_CODEX_BIN;
  process.env.KNOWNEX_CODEX_BIN = process.execPath;
  t.after(() => {
    if (prior === undefined) delete process.env.KNOWNEX_CODEX_BIN;
    else process.env.KNOWNEX_CODEX_BIN = prior;
  });
  for (const [type, text] of [
    ['user_message', 'SOURCE_SENTINEL: persist confirmed facts.'],
    ['assistant_final', 'Confirmed.'],
  ] as const)
    await appendFeedEvent(
      feed,
      {
        type,
        sessionId: 'launch',
        nativeThreadId: 'launch',
        turnId: 'facts',
        text,
        hook: type === 'assistant_final' ? 'Stop' : 'UserPromptSubmit',
      },
      true,
    );
  return { root, memory };
}

/** Stand-in for the provider session: curates the run named in its task, like the skill says. */
function curator(calls: string[], outcome: 'deliver' | 'fail' = 'deliver') {
  const run: RunProvider = async (command, _args, _cwd, input) => {
    calls.push(command);
    const task = JSON.parse(
      input.slice(input.indexOf('INPUT_REFERENCES_JSON') + 21),
    );
    assert.ok(task.skill.endsWith('SKILL.md'));
    if (outcome === 'fail') return { exitCode: 1, error: 'provider crashed' };
    const draft = join(task.run, 'draft');
    await mkdir(draft, { recursive: true });
    await writeFile(
      join(draft, 'proposal.json'),
      JSON.stringify({
        action: 'update',
        history: { summary: 'Launch', topics: ['Launch'], transition: 'Done.' },
      }),
    );
    await writeFile(join(draft, 'STATE.md'), '# Stato\n\nLAUNCHED [E001]\n');
    await writeFile(
      join(draft, 'review.json'),
      JSON.stringify({
        version: 3,
        summary: 'Curato.',
        sources: [1],
        changes: [{ path: 'STATE.md', summary: 'Stato.', sources: [1] }],
        uncertainties: [],
        anomalies: [],
      }),
    );
    await writeCurationDraft(task.run);
    return { exitCode: 0 };
  };
  return run;
}

test('provider argv is non-interactive and unpersisted, and rejects unsafe values', () => {
  assert.deepEqual(
    providerCommand(
      { provider: 'codex', model: 'gpt-6.1-terra', effort: 'high' },
      'W',
    ),
    [
      'codex',
      [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '-C',
        'W',
        '-s',
        'workspace-write',
        '-m',
        'gpt-6.1-terra',
        '-c',
        'model_reasoning_effort="high"',
        '-',
      ],
    ],
  );
  assert.deepEqual(
    providerCommand(
      { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      'W',
    ),
    [
      'claude',
      [
        '-p',
        '--no-session-persistence',
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Bash(node:*)',
        '--model',
        'claude-opus-5-5',
        '--effort',
        'high',
      ],
    ],
  );
  // Without model/effort the provider defaults apply.
  assert.ok(!providerCommand({ provider: 'codex' }, 'W')[1].includes('-m'));
  for (const bad of ['gpt 6', 'x"y', '-m', 'a\nb', ''])
    assert.throws(
      () => providerCommand({ provider: 'codex', model: bad }, 'W'),
      { code: 'CHECKPOINT_ARGUMENT_INVALID' },
      JSON.stringify(bad),
    );
  assert.throws(
    () => providerCommand({ provider: 'codex', effort: 'high"]' }, 'W'),
    { code: 'CHECKPOINT_ARGUMENT_INVALID' },
  );
  assert.throws(() => providerCommand({ provider: 'x' as 'codex' }, 'W'), {
    code: 'CHECKPOINT_ARGUMENT_INVALID',
  });
});

test('one launch prepares, lets the session curate and publishes; nothing new means no session', async (t) => {
  const f = await fixture(t),
    calls: string[] = [];
  const result = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls),
  );
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result));
  assert.deepEqual(calls, ['codex']);
  assert.match(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    /LAUNCHED \[E001\]/,
  );
  await assert.rejects(
    stat(join(f.root, '.knownex/internal/checkpoint.lock')),
    { code: 'ENOENT' },
  );
  const again = await launchCheckpoint(
    f.root,
    { provider: 'claude' },
    curator(calls),
  );
  assert.equal(again.status, 'SUCCESS');
  assert.equal(again.action, 'noop');
  assert.deepEqual(calls, ['codex'], 'no session without new events');
});

test('a failed session publishes nothing, names the provider error and the same batch can be retried', async (t) => {
  const f = await fixture(t),
    calls: string[] = [];
  const failed = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls, 'fail'),
  );
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.code, 'CHECKPOINT_PROVIDER_FAILED');
  assert.equal(failed.cause, 'provider crashed');
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
  const runs = await readdir(join(f.root, '.knownex/internal/curator/runs'));
  const retried = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls),
  );
  assert.equal(retried.status, 'SUCCESS', JSON.stringify(retried));
  assert.deepEqual(
    await readdir(join(f.root, '.knownex/internal/curator/runs')),
    runs,
    'the retry curates the batch already frozen, not a new one',
  );
});

test('a second launch while one is curating stops at once without a session', async (t) => {
  const f = await fixture(t),
    calls: string[] = [];
  let resume!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  const slow: RunProvider = async (...args) => {
    await gate;
    return curator(calls)(...args);
  };
  const first = launchCheckpoint(f.root, { provider: 'codex' }, slow);
  await new Promise((r) => setTimeout(r, 300));
  const second = await launchCheckpoint(
    f.root,
    { provider: 'claude' },
    curator(calls),
  );
  assert.equal(second.status, 'ERROR');
  assert.equal(second.code, 'CHECKPOINT_BUSY');
  resume();
  assert.equal((await first).status, 'SUCCESS');
  assert.deepEqual(calls, ['codex']);
});

test('outside a KnowNex workspace nothing is created', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-launch-none-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await launchCheckpoint(root, { provider: 'codex' }, () =>
    assert.fail('no session'),
  );
  assert.equal(result.code, 'KNOWNEX_WORKSPACE_REQUIRED');
  assert.deepEqual(await readdir(root), []);
});

test('the real spawner disables capture, passes the task on stdin and reports only status and last error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'knownex-spawn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = (code: number) =>
    "const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{" +
    "fs.writeFileSync('seen.json',JSON.stringify({capture:process.env.KNOWNEX_CAPTURE,input:s}));" +
    `console.log('MODEL OUTPUT');console.error('first\\nlast line');process.exit(${code})})`;
  assert.deepEqual(
    await spawnProvider(process.execPath, ['-e', script(0)], dir, 'TASK è'),
    { exitCode: 0 },
  );
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'seen.json'), 'utf8')), {
    capture: '0',
    input: 'TASK è',
  });
  assert.deepEqual(
    await spawnProvider(process.execPath, ['-e', script(3)], dir, 'x'),
    { exitCode: 3, error: 'last line' },
  );
  assert.deepEqual(
    await spawnProvider(join(dir, 'missing-provider.exe'), [], dir, 'x'),
    { exitCode: null, error: 'ENOENT' },
  );
});

test("the model's own output never reaches the launcher's stdout", () => {
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { spawnProvider } from './src/checkpoint-launcher.ts';" +
        "await spawnProvider(process.execPath, ['-e', 'console.log(\"MODEL OUTPUT\")'], '.', '');",
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('the CLI accepts exactly one provider and rejects bad arguments before touching the workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-launch-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [
    [],
    ['--codex', '--claude'],
    ['--codex', '--model'],
    ['--codex', '--bogus'],
    ['--codex', '-m', ' '],
  ]) {
    const r = spawnSync(
      process.execPath,
      ['src/index.ts', 'checkpoint', ...args, '--workspace', root],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(JSON.parse(r.stderr).code, 'INVALID_ARGUMENTS');
  }
  assert.deepEqual(await readdir(root), []);
});
