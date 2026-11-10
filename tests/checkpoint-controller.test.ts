import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import { emptyMemory } from '../src/curator.ts';
import {
  readCurationInput,
  stateEvidence,
  writeCurationArtifacts,
} from '../src/curation-io.ts';
import { nativeFixture } from './native-fixture.ts';

test('root CLI dispatches checkpoint without authorization and returns no documents', async (t) => {
  const f = await fixture(t);
  await f.batch(false);
  const result = spawnSync(
    process.execPath,
    ['src/index.ts', 'curate', 'checkpoint', '--work', f.work],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'error');
  assert.equal(output.code, 'CURATOR_HANDOFF_REQUIRED');
  assert.equal(output.phase, 'runtime');
  assert.ok(result.stdout.length < 1000);
  assert.equal(result.stderr, '');
});

async function fixture(t: test.TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'knownex-controller-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory'),
    work = join(root, '.knownex/internal/curator'),
    feed = join(root, '.knownex/internal/feed');
  await mkdir(memory, { recursive: true });
  for (const [n, s] of Object.entries(emptyMemory))
    await writeFile(join(memory, n), s, 'utf8');
  const peer = await nativeFixture(feed);
  await writeFile(join(feed, 'project.jsonl'), '');
  const prior = process.env.KNOWNEX_CODEX_BIN;
  process.env.KNOWNEX_CODEX_BIN = process.execPath;
  t.after(() => {
    if (prior === undefined) delete process.env.KNOWNEX_CODEX_BIN;
    else process.env.KNOWNEX_CODEX_BIN = prior;
  });
  let number = 0;
  async function batch(authorize = true) {
    number++;
    const turn = 'work-' + number,
      consent = 'consent-' + number;
    peer.retain('controller', turn);
    peer.retain('controller', consent);
    for (const [type, text] of [
      ['user_message', 'SOURCE_DOCUMENT_BODY_SENTINEL: update ' + number],
      ['assistant_final', 'Observed result.'],
    ] as const)
      await appendFeedEvent(
        feed,
        {
          type,
          sessionId: 'controller',
          nativeThreadId: 'controller',
          turnId: turn,
          text,
          hook: type === 'user_message' ? 'UserPromptSubmit' : 'Stop',
        },
        true,
      );
    if (authorize)
      await appendFeedEvent(
        feed,
        {
          type: 'user_message',
          sessionId: 'controller',
          nativeThreadId: 'controller',
          turnId: consent,
          text: '$knownex-checkpoint',
          hook: 'UserPromptSubmit',
        },
        true,
      );
  }
  return { root, memory, work, feed, batch };
}
async function artifacts(
  run: string,
  options: {
    noop?: boolean;
    anomaly?: boolean;
    invalid?: boolean;
    invalidProposal?: boolean;
    v1?: boolean;
  } = {},
) {
  const packet = JSON.parse((await readCurationInput(run, 'packet.json')).text),
    before = (await readCurationInput(run, 'base/STATE.md')).text;
  const state =
    '# Project ' +
    packet.through +
    '\n\nDOCUMENT_BODY_SENTINEL\n\n[E' +
    String(packet.through).padStart(3, '0') +
    '](' +
    packet.feed +
    ')\n';
  const proposal = options.noop
    ? { action: 'noop' }
    : {
        action: 'update',
        ...(options.invalidProposal ? { unexpected: true } : {}),
        state,
        knowledge: {},
        history: {
          summary: 'Update',
          topics: ['Project'],
          transition: 'Confirmed.',
        },
      };
  const review = {
    version: options.v1 ? 1 : 2,
    summary: 'REVIEW_BODY_SENTINEL',
    sources: [packet.through],
    changes: options.noop
      ? []
      : [
          {
            path: 'STATE.md',
            summary: 'Operational root.',
            sources: [packet.through],
          },
        ],
    critical: [
      {
        before: options.v1 ? before.split('\n')[0] : stateEvidence(before, 1),
        after: options.v1
          ? (options.noop ? before : state).split('\n')[0]
          : stateEvidence(options.noop ? before : state, 1),
        reason: 'Transition.',
        sources: [packet.through],
      },
    ],
    uncertainties: [],
    anomalies: options.anomaly ? ['UNRESOLVED_SEMANTIC_PROBLEM'] : [],
  };
  if (options.invalid) review.changes = [];
  return writeCurationArtifacts(run, proposal, review);
}

test('controller authorizes, runs once, validates v2 and returns only the final compact result', async (t) => {
  const { checkpoint } = await import('../src/checkpoint-controller.ts');
  const f = await fixture(t);
  await f.batch();
  let calls = 0;
  const worker = async ({ run }: { run: string }) => {
    calls++;
    return artifacts(run);
  };
  const result = await checkpoint(f.work, { worker });
  assert.equal(result.status, 'applied');
  assert.equal(result.through, 2);
  assert.equal(calls, 1);
  const text = JSON.stringify(result);
  for (const s of [
    'SOURCE_DOCUMENT_BODY_SENTINEL',
    'DOCUMENT_BODY_SENTINEL',
    'REVIEW_BODY_SENTINEL',
  ])
    assert.ok(!text.includes(s));
  // No baseline revision-head registry: avoid inventing comparative counts.
  assert.equal(result.knowledge, undefined);
  const replay = await checkpoint(f.work, { worker });
  assert.equal(replay.status, 'applied');
  assert.equal(calls, 1);
  await f.batch();
  const second = await checkpoint(f.work, { worker });
  assert.equal(second.status, 'applied');
  assert.equal(second.through, 5);
  assert.equal(calls, 2);
  assert.ok(
    (await readFile(join(f.memory, 'HISTORY.md'), 'utf8')).includes(
      '# Project 2',
    ),
  );
});

test('unauthorized requests do not start a worker or change memory', async (t) => {
  const { checkpoint } = await import('../src/checkpoint-controller.ts');
  const f = await fixture(t);
  await f.batch(false);
  let calls = 0;
  const result = await checkpoint(f.work, {
    worker: async () => {
      calls++;
      throw Error('must not run');
    },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'CURATOR_HANDOFF_REQUIRED');
  assert.equal(calls, 0);
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
});

test('controller accepts a v1 review without rewriting its evidence format', async (t) => {
  const { checkpoint } = await import('../src/checkpoint-controller.ts');
  const f = await fixture(t);
  await f.batch();
  let runPath = '';
  const result = await checkpoint(f.work, {
    worker: async ({ run }) => {
      runPath = run;
      return artifacts(run, { v1: true });
    },
  });
  assert.equal(result.status, 'applied');
  const review = JSON.parse(
    await readFile(join(runPath, 'review.json'), 'utf8'),
  );
  assert.equal(review.version, 1);
  assert.equal(typeof review.critical[0].before, 'string');
  const receipt = JSON.parse(
    await readFile(join(runPath, 'controller.json'), 'utf8'),
  );
  for (const key of [
    'startedAt',
    'preparedAt',
    'workerStartedAt',
    'workerCompletedAt',
    'validatedAt',
    'applyStartedAt',
    'completedAt',
  ]) {
    assert.ok(Number.isFinite(Date.parse(receipt[key])), key);
  }
});

test('noop confirms events without rewriting Markdown', async (t) => {
  const { checkpoint } = await import('../src/checkpoint-controller.ts');
  const f = await fixture(t);
  await f.batch();
  const result = await checkpoint(f.work, {
    worker: ({ run }) => artifacts(run, { noop: true }),
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.through, 2);
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
});

for (const kind of [
  'invalid',
  'invalid-proposal',
  'anomaly',
  'uncertainty',
  'failure',
  'interrupted',
  'incomplete',
] as const)
  test(
    'controller stops on ' + kind + ' and forbids an unauthorized worker retry',
    async (t) => {
      const { checkpoint } = await import('../src/checkpoint-controller.ts');
      const f = await fixture(t);
      await f.batch();
      let calls = 0;
      const worker = async ({ run }: { run: string }) => {
        calls++;
        if (kind === 'failure' || kind === 'interrupted')
          throw Object.assign(Error('PRIVATE_DIAGNOSTIC_SENTINEL'), {
            code:
              kind === 'interrupted'
                ? 'CURATOR_WORKER_INTERRUPTED'
                : 'CURATOR_WORKER_FAILED',
          });
        if (kind === 'incomplete') return {};
        if (kind === 'uncertainty') {
          const r = await artifacts(run);
          const review = JSON.parse(await readFile(r.review!.path, 'utf8'));
          review.uncertainties = ['SOURCE_SCOPE_UNRESOLVED'];
          await writeFile(r.review!.path, JSON.stringify(review));
          return {
            ...r,
            review: {
              ...r.review!,
              sha256: (await import('../src/artifact-io.ts')).sha256(
                await readFile(r.review!.path),
              ),
              bytes: (await readFile(r.review!.path)).length,
            },
          };
        }
        return artifacts(run, {
          invalid: kind === 'invalid',
          invalidProposal: kind === 'invalid-proposal',
          anomaly: kind === 'anomaly',
        });
      };
      const result = await checkpoint(f.work, { worker });
      assert.ok(['error', 'blocked'].includes(result.status));
      assert.equal(calls, 1);
      assert.equal(
        await readFile(join(f.memory, 'STATE.md'), 'utf8'),
        emptyMemory['STATE.md'],
      );
      assert.ok(
        !JSON.stringify(result).includes('PRIVATE_DIAGNOSTIC_SENTINEL'),
      );
      const retried = await checkpoint(f.work, { worker });
      assert.equal(retried.code, 'CURATOR_CHECKPOINT_RETRY_FORBIDDEN');
      assert.equal(calls, 1);
    },
  );

test('controller recovers an already authorized publication without starting another worker', async (t) => {
  const { checkpoint } = await import('../src/checkpoint-controller.ts');
  const f = await fixture(t);
  await f.batch();
  const module = pathToFileURL(
      join(process.cwd(), 'src/checkpoint-controller.ts'),
    ).href,
    io = pathToFileURL(join(process.cwd(), 'src/curation-io.ts')).href;
  const code = `const fs=await import('node:fs/promises'),rename=fs.default.rename;fs.default.rename=async(...a)=>{const r=await rename(...a);if(String(a[1]).replaceAll('\\\\','/').endsWith('/memory/STATE.md'))process.exit(73);return r};(await import('node:module')).syncBuiltinESMExports();const c=await import(${JSON.stringify(module)}),io=await import(${JSON.stringify(io)});await c.checkpoint(${JSON.stringify(f.work)},{worker:async({run})=>{const p=JSON.parse((await io.readCurationInput(run,'packet.json')).text);return io.writeCurationArtifacts(run,{action:'update',state:'# Recovered\\n\\n[E002]('+p.feed+')\\n',history:{summary:'Recovery',topics:['Recovery'],transition:'Recovered.'},knowledge:{}},{version:2,summary:'Recovery',sources:[2],changes:[{path:'STATE.md',summary:'Recovery',sources:[2]}],critical:[],uncertainties:[],anomalies:[]})}});`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(child.status, 73, child.stderr);
  let called = 0;
  const result = await checkpoint(f.work, {
    worker: async () => {
      called++;
      throw Error('must not run');
    },
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.replayed, true);
  assert.equal(called, 0);
  assert.equal(result.through, 2);
  const h = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  assert.equal((h.match(/:begin -->/g) ?? []).length, 1);
});
