import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
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
import { appendFeedEvent } from '../src/feed.ts';
import {
  nativeAuthorization,
  nativeCheckpoint,
  delegationResult,
} from '../src/native-checkpoint.ts';
import {
  readCurationInput,
  stateEvidence,
  writeCurationArtifacts,
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
  const r = await nativeCheckpoint(work, {
    stage: 'prepare',
    authorization: nativeAuthorization,
  });
  assert.equal(r.status, 'READY', JSON.stringify(r));
  if (r.status !== 'READY') throw Error('prepare failed');
  return r;
}
async function produce(run: string, kind = 'valid') {
  const p = JSON.parse((await readCurationInput(run, 'packet.json')).text),
    before = (await readCurationInput(run, 'base/STATE.md')).text;
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
      version: 2,
      summary: 'REVIEW_SENTINEL',
      sources: [2],
      changes:
        kind === 'noop' || kind === 'invalid-review'
          ? []
          : [{ path: 'STATE.md', summary: 'Native update.', sources: [2] }],
      critical: [
        {
          before: stateEvidence(before, 1),
          after: stateEvidence(kind === 'noop' ? before : state, 1),
          reason: 'Transition verified.',
          sources: [2],
        },
      ],
      uncertainties: kind === 'uncertainty' ? ['UNRESOLVED'] : [],
      anomalies: kind === 'anomaly' ? ['UNRESOLVED'] : [],
    },
  );
}
function finish(
  work: string,
  run: string,
  receipts: Awaited<ReturnType<typeof produce>>,
) {
  return nativeCheckpoint(work, {
    stage: 'complete',
    run,
    proposalSha256: receipts.proposal.sha256,
    reviewSha256: receipts.review!.sha256,
  });
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
    assert.equal(record.authorization.sequence, 3);
    assert.match(record.authorization.checksum, /^[a-f0-9]{64}$/);
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
  const receipts = await delegate(assignment);
  const result = await finish(f.work, p.runId, receipts);
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
  const consumed = await nativeCheckpoint(f.work, {
    stage: 'prepare',
    authorization: nativeAuthorization,
  });
  assert.equal(consumed.status, 'ERROR');
  assert.equal(consumed.code, 'CURATOR_HANDOFF_REQUIRED');
});

test('rehashed acquired batch changed after materialization blocks complete without changing confirmed memory', async (t) => {
  const f = await fixture(t),
    p = await begin(f.work);
  const receipts = await produce(p.run);
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
  const result = await finish(f.work, p.runId, receipts);
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
  const repeated = await nativeCheckpoint(f.work, {
    stage: 'prepare',
    authorization: nativeAuthorization,
  });
  assert.equal(repeated.status, 'ERROR');
  assert.equal(repeated.code, 'CURATOR_CHECKPOINT_RETRY_FORBIDDEN');
  for (const [name, expected] of Object.entries(emptyMemory))
    assert.equal(await readFile(join(f.memory, name), 'utf8'), expected);
});

for (const kind of [
  'anomaly',
  'uncertainty',
  'receipt-mismatch',
  'interrupted',
  'invalid-review',
  'wrong-run',
  'wrong-authorization',
] as const)
  test('native publication stops on ' + kind, async (t) => {
    const f = await fixture(t),
      p = await begin(f.work);
    const repeated = await nativeCheckpoint(f.work, {
      stage: 'prepare',
      authorization: nativeAuthorization,
    });
    assert.equal(repeated.status, 'ERROR');
    assert.equal(repeated.code, 'CURATOR_CHECKPOINT_RETRY_FORBIDDEN');
    let result;
    if (kind === 'interrupted')
      result = await nativeCheckpoint(f.work, {
        stage: 'complete',
        run: p.runId,
        proposalSha256: 'a'.repeat(64),
        reviewSha256: 'b'.repeat(64),
      });
    else {
      const receipts = await produce(p.run, kind);
      if (kind === 'receipt-mismatch')
        receipts.proposal.sha256 = 'a'.repeat(64);
      if (kind === 'wrong-authorization') {
        const controller = join(p.run, 'controller.json'),
          r = JSON.parse(await readFile(controller, 'utf8'));
        r.authorization.sequence = 1;
        await writeFile(controller, JSON.stringify(r));
      }
      result = await finish(
        f.work,
        kind === 'wrong-run' ? 'wrong-run' : p.runId,
        receipts,
      );
    }
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

test('missing authority and forged authority references do not prepare a batch', async (t) => {
  const f = await fixture(t, false);
  for (const authorization of [
    nativeAuthorization,
    'invented-user-permission',
  ]) {
    const r = await nativeCheckpoint(f.work, {
      stage: 'prepare',
      authorization,
    });
    assert.equal(r.status, 'ERROR');
    assert.equal(r.code, 'CURATOR_HANDOFF_REQUIRED');
  }
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
  const prepared = cli(
    '--stage',
    'prepare',
    '--authorization',
    nativeAuthorization,
  );
  assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
  const p = JSON.parse(prepared.stdout);
  assert.equal(p.status, 'READY');
  assert.equal(typeof p.requestFile, 'string');
  assert.ok(!('request' in p));
  const receipts = await produce(p.run);
  const completed = cli(
    '--stage',
    'complete',
    '--run',
    p.runId,
    '--proposal-sha256',
    receipts.proposal.sha256,
    '--review-sha256',
    receipts.review!.sha256,
  );
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
    p = await begin(f.work),
    receipts = await produce(p.run, 'noop');
  const result = await finish(f.work, p.runId, receipts);
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
    p = await begin(f.work),
    receipts = await produce(p.run);
  const module = pathToFileURL(
    join(process.cwd(), 'src/native-checkpoint.ts'),
  ).href;
  const code = `const fs=await import('node:fs/promises'),rename=fs.default.rename;fs.default.rename=async(...a)=>{const r=await rename(...a);if(String(a[1]).replaceAll('\\\\','/').endsWith('/memory/STATE.md'))process.exit(73);return r};(await import('node:module')).syncBuiltinESMExports();const {nativeCheckpoint}=await import(${JSON.stringify(module)});await nativeCheckpoint(${JSON.stringify(f.work)},${JSON.stringify({ stage: 'complete', run: p.runId, proposalSha256: receipts.proposal.sha256, reviewSha256: receipts.review!.sha256 })});`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 73, child.stderr + child.stdout);
  const result = await finish(f.work, p.runId, receipts);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.replayed, true);
  assert.equal(result.through, 2);
  const history = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  assert.equal((history.match(/:begin/g) || []).length, 1);
});
