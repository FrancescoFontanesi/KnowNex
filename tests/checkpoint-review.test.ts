import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import {
  applyCurator,
  emptyMemory,
  initCurator,
  prepareCurator,
  validateCurator,
} from '../src/curator.ts';

const hash = (v: string | Buffer) =>
  createHash('sha256').update(v).digest('hex');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory'),
    work = join(root, '.knownex/internal/curator'),
    feed = join(root, '.knownex/internal/feed');
  await mkdir(memory, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  await appendFeedEvent(feed, {
    type: 'user_message',
    sessionId: 's',
    turnId: '1',
    text: 'Preserve the open prerequisite.',
    hook: 'UserPromptSubmit',
  });
  await initCurator(work, memory, join(feed, hash('s') + '.jsonl'), 0);
  const prepared = await prepareCurator(work, undefined, {
    through: 1,
    autonomous: true,
  });
  const dir = prepared.run!;
  const packet = JSON.parse(await readFile(join(dir, 'packet.json'), 'utf8'));
  const state =
    '# Project\n\nDOCUMENT_BODY_NOT_FOR_ORDINARY_PARENT\n\n[E001](' +
    packet.feed +
    ')\n';
  const proposal = {
    action: 'update',
    state,
    knowledge: {},
    history: {
      summary: 'Requirement',
      topics: ['Project'],
      transition: 'Open prerequisite added.',
    },
  };
  const bytes = JSON.stringify(proposal);
  await writeFile(prepared.proposal!, bytes);
  const review = {
    version: 2,
    proposalSha256: hash(bytes),
    summary: 'Open prerequisite preserved.',
    sources: [1],
    changes: [
      { path: 'STATE.md', summary: 'Added open prerequisite.', sources: [1] },
    ],
    critical: [
      {
        before: '',
        after: { sha256: hash(state), startLine: 3, endLine: 3 },
        reason: 'New prerequisite remains open.',
        sources: [1],
      },
    ],
    uncertainties: [] as string[],
    anomalies: [] as string[],
  };
  const save = () =>
    writeFile(join(dir, 'review.json'), JSON.stringify(review));
  await save();
  const validate = (summary = true) =>
    spawnSync(
      process.execPath,
      [
        'src/index.ts',
        'curate',
        'validate',
        '--work',
        work,
        ...(summary ? ['--summary'] : []),
      ],
      { encoding: 'utf8', windowsHide: true },
    );
  return { work, memory, dir, review, save, validate };
}

test('ordinary compact validation exposes decisions, checks and receipts without source bodies or applying', async (t) => {
  const f = await fixture(t);
  const raw = await readFile(join(f.dir, 'review.json'));
  const runSkill = await readFile(join(f.dir, 'SKILL.md'), 'utf8');
  const sourceSkill = (
    await readFile('.agents/skills/knownex-curator/SKILL.md', 'utf8')
  ).replaceAll('../../../docs/MEMORY-CONTRACT.md', 'MEMORY-CONTRACT.md');
  assert.equal(runSkill, sourceSkill);
  assert.deepEqual(
    await readFile(join(f.dir, 'MEMORY-CONTRACT.md')),
    await readFile('docs/MEMORY-CONTRACT.md'),
  );
  const cli = f.validate();
  assert.equal(cli.status, 0, cli.stderr);
  const compact = JSON.parse(cli.stdout);
  assert.ok(!cli.stdout.includes('DOCUMENT_BODY_NOT_FOR_ORDINARY_PARENT'));
  assert.deepEqual(compact.review.report.critical, [
    {
      index: 0,
      textChange: 'added',
      reason: f.review.critical[0]!.reason,
      sources: [1],
    },
  ]);
  assert.equal(compact.proposalSha256, f.review.proposalSha256);
  assert.equal(compact.review.sha256, hash(raw));
  assert.equal(compact.checks.frozenInputs, true);
  assert.equal(compact.checks.provenance, true);
  assert.equal(compact.checks.links, true);
  const full = f.validate(false);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(compact.seal, JSON.parse(full.stdout).seal);
  assert.deepEqual(await readFile(join(f.dir, 'review.json')), raw);
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
  const detailed = await validateCurator(f.work);
  assert.equal(
    detailed.review!.report.critical[0]!.after,
    'DOCUMENT_BODY_NOT_FOR_ORDINARY_PARENT',
  );
  await applyCurator(f.work, detailed.seal);
  assert.ok(
    (await readFile(join(f.memory, 'STATE.md'), 'utf8')).includes(
      'DOCUMENT_BODY_NOT_FOR_ORDINARY_PARENT',
    ),
  );
});

test('compact validation retains escalation evidence; withholding apply preserves confirmed memory', async (t) => {
  const f = await fixture(t);
  f.review.anomalies = ['Blocker removal not justified by an approved source.'];
  f.review.uncertainties = [
    'Authority of the reported completion is unresolved.',
  ];
  await f.save();
  const cli = f.validate();
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.deepEqual(result.review.report.anomalies, f.review.anomalies);
  assert.deepEqual(result.review.report.uncertainties, f.review.uncertainties);
  assert.equal(result.review.path, join(f.dir, 'review.json'));
  assert.equal(result.review.report.critical[0].index, 0);
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
  await assert.rejects(
    applyCurator(f.work, 'not-the-authorized-seal'),
    /CURATOR_CONFIRMATION_REQUIRED/,
  );
  f.review.changes = [];
  await f.save();
  const incomplete = f.validate();
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /CURATOR_REVIEW_INVALID/);
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
});

test('compact noop reports rationale and confirms events without rewriting memory', async (t) => {
  const f = await fixture(t);
  const bytes = JSON.stringify({ action: 'noop' });
  await writeFile(join(f.dir, 'proposal.json'), bytes);
  f.review.proposalSha256 = hash(bytes);
  f.review.summary = 'No durable change.';
  f.review.changes = [];
  f.review.critical = [];
  await f.save();
  const cli = f.validate();
  assert.equal(cli.status, 0, cli.stderr);
  const compact = JSON.parse(cli.stdout);
  assert.equal(compact.action, 'noop');
  assert.equal(compact.review.report.summary, 'No durable change.');
  assert.deepEqual(compact.review.report.critical, []);
  await applyCurator(f.work, compact.seal);
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
  const checkpoint = JSON.parse(
    await readFile(join(f.work, 'checkpoint.json'), 'utf8'),
  );
  assert.equal(checkpoint.sequence, 1);
});
