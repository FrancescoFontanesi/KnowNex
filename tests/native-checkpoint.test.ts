import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  stat,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { emptyMemory } from '../src/curator.ts';
import { acquireJournalLock } from '../src/journal-lock.ts';
import { appendFeedEvent } from '../src/feed.ts';
import {
  preparedCheckpoint,
  delegationResult,
  type DelegationResult,
} from '../src/native-checkpoint.ts';
import {
  readCurationInput,
  writeCurationArtifacts,
  writeCurationDraft,
} from '../src/curation-io.ts';
import { nativeFixture } from './native-fixture.ts';

async function fixture(t: test.TestContext, authorized = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knownex-native-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory'),
    feed = join(root, '.knownex/internal/feed'),
    work = join(root, '.knownex/internal/curator');
  await mkdir(memory, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  const peer = await nativeFixture(feed);
  peer.set('native-fixture', ['facts', 'authorization']);
  const prior = process.env.KNOWNEX_CODEX_BIN;
  process.env.KNOWNEX_CODEX_BIN = process.execPath;
  t.after(() => {
    if (prior === undefined) delete process.env.KNOWNEX_CODEX_BIN;
    else process.env.KNOWNEX_CODEX_BIN = prior;
  });
  for (const [type, turnId, text] of [
    ['user_message', 'facts', 'SOURCE_SENTINEL: persist confirmed facts.'],
    ['assistant_final', 'facts', 'Confirmed.'],
    ...(authorized
      ? [['user_message', 'authorization', '$knownex-checkpoint']]
      : []),
  ])
    await appendFeedEvent(
      feed,
      {
        type: type as 'user_message' | 'assistant_final',
        sessionId: 'native-fixture',
        nativeThreadId: 'native-fixture',
        turnId: turnId!,
        text: text!,
        hook: type === 'assistant_final' ? 'Stop' : 'UserPromptSubmit',
      },
      true,
    );
  return { root, memory, work, feed, peer };
}
async function begin(work: string) {
  const r = await preparedCheckpoint(work, {
    stage: 'prepare',
  });
  assert.equal(r.status, 'READY', JSON.stringify(r));
  if (r.status !== 'READY') throw Error('prepare failed');
  return r;
}
async function produce(run: string, kind = 'valid') {
  const p = JSON.parse((await readCurationInput(run, 'packet.json')).text);
  const state =
    '# Native result\n\nMEMORY_SENTINEL\n\n[E002](' + p.feed + ')\n';
  return writeCurationArtifacts(
    run,
    kind === 'noop'
      ? { action: 'noop' }
      : {
          action: 'update',
          state,
          knowledge: {},
          history: {
            summary: 'Native',
            topics: ['Native'],
            transition: 'Confirmed.',
          },
        },
    {
      version: 3,
      summary: 'REVIEW_SENTINEL',
      sources: [2],
      changes:
        kind === 'noop' || kind === 'invalid-review'
          ? []
          : [{ path: 'STATE.md', summary: 'Native update.', sources: [2] }],
      uncertainties: kind === 'uncertainty' ? ['UNRESOLVED'] : [],
      anomalies: kind === 'anomaly' ? ['UNRESOLVED'] : [],
    },
  );
}
function finish(work: string, run: string) {
  return preparedCheckpoint(work, {
    stage: 'complete',
    run,
  }) as Promise<DelegationResult>;
}
async function controllerStatus(run: string) {
  return JSON.parse(await readFile(join(run, 'controller.json'), 'utf8'))
    .status;
}
async function assertMemoryUnchanged(memory: string) {
  for (const [name, expected] of Object.entries(emptyMemory))
    assert.equal(await readFile(join(memory, name), 'utf8'), expected);
}

test('principal prepares and completes, one simulated Curator only materializes and returns receipts', async (t) => {
  const f = await fixture(t);
  const p = await begin(f.work);
  assert.equal(p.through, 2);
  assert.ok(!('request' in p));
  assert.ok(JSON.stringify(p).length < 1000);
  let delegations = 0;
  const assignment = {
    version: 1,
    operation: 'checkpoint',
    workspace: f.root,
    runId: p.runId,
    requestFile: p.requestFile,
    workerMode: 'materialize-only',
    skill: '.agents/skills/knownex-curator/SKILL.md',
  };
  const delegate = async (task: typeof assignment) => {
    delegations++;
    assert.equal(task.workspace, f.root);
    const text = await readFile(task.requestFile, 'utf8');
    assert.ok(!text.includes('SOURCE_SENTINEL'));
    const request = JSON.parse(text.split('INPUT_REFERENCES_JSON\n')[1]!);
    assert.equal(request.workerMode, 'materialize-only');
    assert.equal(request.run, p.run);
    assert.ok(!text.includes('--stage complete'));
    const record = JSON.parse(await readFile(join(p.run, 'run.json'), 'utf8'));
    assert.equal(record.authorization, undefined);
    assert.equal(record.last.event.sequence, 2);
    const prior = process.env.KNOWNEX_CODEX_BIN;
    let receipts;
    process.env.KNOWNEX_CODEX_BIN = join(f.root, 'no-app-server-for-curator');
    try {
      receipts = await produce(request.run);
    } finally {
      process.env.KNOWNEX_CODEX_BIN = prior;
    }
    await assert.rejects(readFile(join(f.feed, 'native-calls.jsonl')), {
      code: 'ENOENT',
    });
    return receipts;
  };
  await delegate(assignment);
  const result = await finish(f.work, p.runId);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.through, 2);
  assert.equal(delegations, 1);
  assert.ok(JSON.stringify(result).length < 1000);
  for (const secret of [
    'SOURCE_SENTINEL',
    'MEMORY_SENTINEL',
    'REVIEW_SENTINEL',
  ])
    assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(
    (await readFile(join(f.memory, 'STATE.md'), 'utf8')).includes(
      'MEMORY_SENTINEL',
    ),
  );
  await assert.rejects(readFile(join(f.feed, 'native-calls.jsonl')), {
    code: 'ENOENT',
  });
  const consumed = await preparedCheckpoint(f.work, {
    stage: 'prepare',
  });
  assert.equal(consumed.status, 'SUCCESS');
  assert.equal(consumed.action, 'noop');
});

test('rehashed acquired batch changed after materialization blocks complete without changing confirmed memory', async (t) => {
  const f = await fixture(t),
    p = await begin(f.work);
  await produce(p.run);
  const path = join(f.feed, 'project.jsonl');
  const frames = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  frames[0].block.event.text += ' changed';
  let previous: string | null = null;
  for (const frame of frames) {
    frame.block.previous = previous;
    previous = frame.checksum = createHash('sha256')
      .update(JSON.stringify(frame.block))
      .digest('hex');
  }
  await writeFile(path, frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  const result = await finish(f.work, p.runId);
  assert.equal(result.status, 'ERROR');
  assert.equal(result.code, 'CURATOR_STALE_BATCH');
  for (const [name, expected] of Object.entries(emptyMemory))
    assert.equal(await readFile(join(f.memory, name), 'utf8'), expected);
});

test('interrupted Curator leaves a prepared run without consuming another authorization', async (t) => {
  const f = await fixture(t),
    p = await begin(f.work);
  assert.equal(
    JSON.parse(await readFile(join(p.run, 'controller.json'), 'utf8')).status,
    'prepared',
  );
  const repeated = await preparedCheckpoint(f.work, {
    stage: 'prepare',
  });
  assert.equal(repeated.status, 'READY');
  if (repeated.status === 'READY') assert.equal(repeated.runId, p.runId);
  for (const [name, expected] of Object.entries(emptyMemory))
    assert.equal(await readFile(join(f.memory, name), 'utf8'), expected);
});

for (const kind of [
  'anomaly',
  'uncertainty',
  'interrupted',
  'invalid-review',
  'wrong-run',
  'wrong-controller',
] as const)
  test('native publication stops on ' + kind, async (t) => {
    const f = await fixture(t),
      p = await begin(f.work);
    const repeated = await preparedCheckpoint(f.work, {
      stage: 'prepare',
    });
    assert.equal(repeated.status, 'READY');
    if (repeated.status === 'READY') assert.equal(repeated.runId, p.runId);
    let result;
    if (kind === 'interrupted') result = await finish(f.work, p.runId);
    else {
      await produce(p.run, kind);
      if (kind === 'wrong-controller') {
        const controller = join(p.run, 'controller.json'),
          r = JSON.parse(await readFile(controller, 'utf8'));
        r.policy = 'unexpected-policy';
        await writeFile(controller, JSON.stringify(r));
      }
      result = await finish(
        f.work,
        kind === 'wrong-run' ? 'wrong-run' : p.runId,
      );
    }
    if (kind === 'interrupted')
      assert.equal(result.code, 'CURATOR_WORKER_OUTPUT_INCOMPLETE');
    assert.equal(
      result.status,
      kind === 'anomaly' || kind === 'uncertainty' ? 'BLOCKED' : 'ERROR',
    );
    assert.equal(result.through, 0);
    if (kind === 'invalid-review')
      assert.equal(result.code, 'CURATOR_REVIEW_INVALID');
    for (const [name, expected] of Object.entries(emptyMemory))
      assert.equal(await readFile(join(f.memory, name), 'utf8'), expected);
  });

test('native prepare works without any invocation in the feed', async (t) => {
  const f = await fixture(t, false);
  const p = await begin(f.work);
  assert.equal(p.through, 2);
  await produce(p.run);
  const result = await finish(f.work, p.runId);
  assert.equal(result.status, 'SUCCESS');
});

test('native CLI argument errors use the final diagnostic contract without launching a model', () => {
  const result = spawnSync(
    process.execPath,
    [
      'src/index.ts',
      'curate',
      'native',
      '--work',
      '.knownex/internal/curator',
      '--stage',
      'invalid',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: 'ERROR',
    through: null,
    code: 'CURATOR_ARGUMENT_INVALID',
    phase: 'arguments',
  });
});

test('native CLI prepare and complete expose only compact coordination results', async (t) => {
  const f = await fixture(t);
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['src/index.ts', 'curate', 'native', '--work', f.work, ...args],
      { encoding: 'utf8', windowsHide: true },
    );
  const prepared = cli('--stage', 'prepare');
  assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
  const p = JSON.parse(prepared.stdout);
  assert.equal(p.status, 'READY');
  assert.equal(typeof p.requestFile, 'string');
  assert.ok(!('request' in p));
  const receipts = await produce(p.run);
  // The removed hash arguments are rejected before the run is touched.
  const legacy = cli(
    '--stage',
    'complete',
    '--run',
    p.runId,
    '--proposal-sha256',
    receipts.proposal.sha256,
  );
  assert.equal(legacy.status, 1);
  assert.equal(JSON.parse(legacy.stderr).code, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
  assert.equal(await controllerStatus(p.run), 'prepared');
  const completed = cli('--stage', 'complete', '--run', p.runId);
  assert.equal(completed.status, 0, completed.stderr + completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'SUCCESS');
  for (const output of [prepared.stdout, completed.stdout]) {
    assert.ok(Buffer.byteLength(output) < 1000);
    for (const sentinel of [
      'SOURCE_SENTINEL',
      'MEMORY_SENTINEL',
      'REVIEW_SENTINEL',
    ])
      assert.ok(!output.includes(sentinel));
  }
});
test('native noop and compact final projection preserve confirmed documents', async (t) => {
  const f = await fixture(t),
    p = await begin(f.work);
  await produce(p.run, 'noop');
  const result = await finish(f.work, p.runId);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.through, 2);
  for (const [name, expected] of Object.entries(emptyMemory))
    assert.equal(await readFile(join(f.memory, name), 'utf8'), expected);
  assert.ok(
    !JSON.stringify(
      delegationResult({
        status: 'applied',
        through: 2,
        proposal: 'PRIVATE',
      } as any),
    ).includes('PRIVATE'),
  );
});
test('native apply crash recovers the same authorization without another delegation', async (t) => {
  const f = await fixture(t),
    p = await begin(f.work);
  await produce(p.run);
  const module = pathToFileURL(
    join(process.cwd(), 'src/native-checkpoint.ts'),
  ).href;
  const code = `const fs=await import('node:fs/promises'),rename=fs.default.rename;fs.default.rename=async(...a)=>{const r=await rename(...a);if(String(a[1]).replaceAll('\\\\','/').endsWith('/memory/STATE.md'))process.exit(73);return r};(await import('node:module')).syncBuiltinESMExports();const {preparedCheckpoint}=await import(${JSON.stringify(module)});await preparedCheckpoint(${JSON.stringify(f.work)},${JSON.stringify({ stage: 'complete', run: p.runId })});`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 73, child.stderr + child.stdout);
  await appendFeedEvent(
    f.feed,
    {
      type: 'user_message',
      sessionId: 'later',
      turnId: 'later',
      text: 'Arrived after the apply crash.',
      hook: 'portable-source',
    },
    true,
  );
  const result = await finish(f.work, p.runId);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.replayed, true);
  assert.equal(result.through, 2);
  const history = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  assert.equal((history.match(/^- \[H\d{6,}\]/gm) || []).length, 1);
});

/** Curator side of the native flow: plain draft files, then curate write. */
async function draft(run: string, source = 2, sentinel = 'MEMORY_SENTINEL') {
  const p = JSON.parse((await readCurationInput(run, 'packet.json')).text),
    dir = join(run, 'draft');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'proposal.json'),
    JSON.stringify({
      action: 'update',
      history: { summary: 'Native', topics: ['Native'], transition: 'Done.' },
    }),
  );
  await writeFile(
    join(dir, 'STATE.md'),
    '# Native result\n\n' + sentinel + '\n\n[E002](' + p.feed + ')\n',
  );
  await writeFile(
    join(dir, 'review.json'),
    JSON.stringify({
      version: 3,
      summary: 'REVIEW_SENTINEL',
      sources: [source],
      changes: [{ path: 'STATE.md', summary: 'Native update.', sources: [2] }],
      uncertainties: [],
      anomalies: [],
    }),
  );
}

test('complete before the Curator has delivered consumes nothing and can be repeated', async (t) => {
  const f = await fixture(t),
    p = await begin(f.work);
  for (let attempt = 0; attempt < 2; attempt++) {
    const early = await finish(f.work, p.runId);
    assert.equal(early.status, 'ERROR');
    assert.equal(early.code, 'CURATOR_WORKER_OUTPUT_INCOMPLETE');
    assert.equal(early.phase, 'delivery');
    assert.equal(await controllerStatus(p.run), 'prepared');
  }
  // A writer killed between review and proposal (the commit point) is still undelivered.
  await produce(p.run);
  await rm(join(p.run, 'proposal.json'));
  const partial = await finish(f.work, p.runId);
  assert.equal(partial.code, 'CURATOR_WORKER_OUTPUT_INCOMPLETE');
  assert.equal(await controllerStatus(p.run), 'prepared');
  await assertMemoryUnchanged(f.memory);
  await rm(join(p.run, 'review.json'));
  await produce(p.run);
  const result = await finish(f.work, p.runId);
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result));
  assert.equal(await controllerStatus(p.run), 'applied');
  assert.ok(
    (await readFile(join(f.memory, 'STATE.md'), 'utf8')).includes(
      'MEMORY_SENTINEL',
    ),
  );
});

for (const [kind, status, outcome] of [
  ['invalid-review', 'ERROR', 'failed'],
  ['anomaly', 'BLOCKED', 'blocked'],
] as const)
  test(
    'after delivery a ' +
      kind +
      ' outcome is final and a later complete cannot rewrite it',
    async (t) => {
      const f = await fixture(t),
        p = await begin(f.work);
      await produce(p.run, kind);
      assert.equal((await finish(f.work, p.runId)).status, status);
      assert.equal(await controllerStatus(p.run), outcome);
      const again = await finish(f.work, p.runId);
      assert.equal(again.status, 'ERROR');
      assert.equal(again.code, 'CURATOR_CHECKPOINT_RETRY_FORBIDDEN');
      assert.equal(await controllerStatus(p.run), outcome);
      await assertMemoryUnchanged(f.memory);
    },
  );

test('native Curator gets the validation error from write, fixes the draft and the same batch completes', async (t) => {
  const f = await fixture(t),
    p = await begin(f.work);
  await draft(p.run, 99);
  await assert.rejects(writeCurationDraft(p.run), {
    code: 'CURATOR_REVIEW_INVALID',
  });
  for (const name of ['proposal.json', 'review.json', 'validated.json'])
    await assert.rejects(stat(join(p.run, name)), { code: 'ENOENT' });
  assert.ok(!(await readdir(p.run)).some((n) => n.startsWith('candidate-')));
  assert.equal(await controllerStatus(p.run), 'prepared');
  await draft(p.run);
  await writeCurationDraft(p.run);
  const result = await finish(f.work, p.runId);
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result));
  assert.ok(
    (await readFile(join(f.memory, 'STATE.md'), 'utf8')).includes(
      'MEMORY_SENTINEL',
    ),
  );
});

test('complete while a Curator write is in progress stops busy without consuming the run', async (t) => {
  const f = await fixture(t),
    p = await begin(f.work);
  await draft(p.run);
  await writeCurationDraft(p.run);
  // The Curator is rewriting its delivery: write holds the delivery lock.
  const release = await acquireJournalLock(join(p.run, 'delivery.lock'));
  const busy = await finish(f.work, p.runId);
  await release();
  assert.equal(busy.status, 'ERROR');
  assert.equal(busy.code, 'DESTINATION_BUSY');
  assert.equal(busy.phase, 'delivery');
  assert.equal(await controllerStatus(p.run), 'prepared');
  await assertMemoryUnchanged(f.memory);
  assert.equal((await finish(f.work, p.runId)).status, 'SUCCESS');
});

test('a Curator write while complete freezes the delivery is refused and changes nothing', async (t) => {
  const f = await fixture(t),
    p = await begin(f.work);
  await draft(p.run);
  // complete is checking the delivery and freezing the run: it holds the delivery lock.
  const release = await acquireJournalLock(join(p.run, 'delivery.lock'));
  await assert.rejects(writeCurationDraft(p.run), { code: 'DESTINATION_BUSY' });
  await release();
  for (const name of ['proposal.json', 'review.json'])
    await assert.rejects(stat(join(p.run, name)), { code: 'ENOENT' });
  assert.equal(await controllerStatus(p.run), 'prepared');
  await writeCurationDraft(p.run);
  assert.equal((await finish(f.work, p.runId)).status, 'SUCCESS');
});

test('a rewrite racing complete never loses the batch and publishes exactly the frozen delivery', async (t) => {
  for (let round = 0; round < 6; round++) {
    const f = await fixture(t),
      p = await begin(f.work);
    await draft(p.run, 2, 'FIRST_SENTINEL');
    await writeCurationDraft(p.run);
    await draft(p.run, 2, 'SECOND_SENTINEL');
    // Real interleaving in one process: neither side awaits the other.
    const [, raced] = await Promise.all([
      writeCurationDraft(p.run).catch((e) => e),
      finish(f.work, p.runId),
    ]);
    let result = raced;
    if (
      result.code === 'DESTINATION_BUSY' ||
      result.code === 'CURATOR_WORKER_OUTPUT_INCOMPLETE'
    )
      result = await finish(f.work, p.runId);
    assert.equal(result.status, 'SUCCESS', JSON.stringify(raced));
    assert.equal(await controllerStatus(p.run), 'applied');
    const frozen = JSON.parse(
      await readFile(join(p.run, 'proposal.json'), 'utf8'),
    ).state;
    const published = await readFile(join(f.memory, 'STATE.md'), 'utf8');
    const winner = frozen.includes('SECOND_SENTINEL')
      ? 'SECOND_SENTINEL'
      : 'FIRST_SENTINEL';
    assert.ok(published.includes(winner), round + ': ' + winner);
    assert.ok(
      !published.includes(
        winner === 'FIRST_SENTINEL' ? 'SECOND_SENTINEL' : 'FIRST_SENTINEL',
      ),
    );
  }
});

test('a corrupt feed stops native prepare before any run or delegation, through API and CLI', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.feed, 'project.jsonl'), 'corrupt\n');
  const result = await preparedCheckpoint(f.work, { stage: 'prepare' });
  assert.equal(result.status, 'ERROR');
  assert.equal((result as DelegationResult).code, 'CURATOR_FEED_CORRUPT');
  assert.ok(!('requestFile' in result));
  await assert.rejects(readdir(join(f.work, 'runs')), { code: 'ENOENT' });
  await assertMemoryUnchanged(f.memory);
  const cli = spawnSync(
    process.execPath,
    [
      'src/index.ts',
      'curate',
      'native',
      '--stage',
      'prepare',
      '--work',
      f.work,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(cli.status, 1);
  const output = JSON.parse(cli.stdout);
  assert.equal(output.status, 'ERROR');
  assert.equal(output.code, 'CURATOR_FEED_CORRUPT');
  assert.ok(cli.stdout.length < 1000);
});

test('the removed provider-specific launcher is not a command and starts nothing', async (t) => {
  const f = await fixture(t);
  const result = spawnSync(
    process.execPath,
    ['src/index.ts', 'curate', 'checkpoint', '--work', f.work],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'CURATOR_ARGUMENT_INVALID');
  await assert.rejects(readdir(join(f.work, 'runs')), { code: 'ENOENT' });
});
