import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyCurator,
  emptyMemory,
  initCurator,
  prepareCurator,
  validateCurator,
} from '../src/curator.ts';
import { writeCurationArtifacts } from '../src/curation-io.ts';
import { appendFeedEvent } from '../src/feed.ts';

const hash = (text: string | Buffer) =>
  createHash('sha256').update(text).digest('hex');

/** A prepared autonomous run with a valid STATE update and a v3 review (not yet saved). */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory');
  const work = join(root, '.knownex/internal/curator');
  const feed = join(root, '.knownex/internal/feed');
  await mkdir(memory, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  await appendFeedEvent(feed, {
    type: 'user_message',
    sessionId: 's',
    turnId: '1',
    text: 'Retention: 14 giorni.',
    hook: 'UserPromptSubmit',
  });
  await initCurator(work, memory, join(feed, hash('s') + '.jsonl'), 0);
  const prepared = await prepareCurator(work, undefined, {
    through: 1,
    autonomous: true,
  });
  const dir = prepared.run!;
  const packet = JSON.parse(await readFile(join(dir, 'packet.json'), 'utf8'));
  const proposal = {
    action: 'update',
    state: '# Progetto\n\nRetention: 14 giorni [E001](' + packet.feed + ').\n',
    history: { summary: 'Retention', topics: ['Dati'], transition: 'Avvio.' },
    knowledge: {},
  };
  const bytes = JSON.stringify(proposal);
  await writeFile(prepared.proposal!, bytes);
  const review: Record<string, unknown> = {
    version: 3,
    proposalSha256: hash(bytes),
    summary: 'Retention registrata',
    sources: [1],
    changes: [{ path: 'STATE.md', summary: 'Retention', sources: [1] }],
    uncertainties: [],
    anomalies: [],
  };
  const save = () =>
    writeFile(join(dir, 'review.json'), JSON.stringify(review));
  return { work, memory, dir, review, save };
}

test('a v3 review without critical validates and publishes', async (t) => {
  const f = await fixture(t);
  await f.save();
  await applyCurator(f.work, (await validateCurator(f.work)).seal);
  assert.match(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    /Retention: 14 giorni/,
  );
});

test('a v3 review rejects critical, unknown versions and v2 without critical', async (t) => {
  const f = await fixture(t);
  for (const change of [
    { critical: [] }, // v3 has no critical field
    { version: 4 },
    { version: 2 }, // a legacy version must still carry its critical list
    { version: 2, critical: 'none' },
  ]) {
    const original = { ...f.review };
    Object.assign(f.review, change);
    await f.save();
    await assert.rejects(
      validateCurator(f.work),
      /CURATOR_REVIEW_INVALID/,
      JSON.stringify(change),
    );
    for (const key of Object.keys(f.review)) delete f.review[key];
    Object.assign(f.review, original);
  }
  await f.save();
  await validateCurator(f.work);
});

test('sealed v1/v2 reviews still publish, whatever their critical list says', async (t) => {
  for (const version of [1, 2]) {
    const f = await fixture(t);
    // Line references that the removed checker would have rejected: they are now inert.
    f.review.version = version;
    f.review.critical = [
      { before: { startLine: 99, endLine: 1 }, after: 'missing', reason: '' },
    ];
    await f.save();
    await applyCurator(f.work, (await validateCurator(f.work)).seal);
  }
});

test('the review stays bound to frozen inputs, proposal bytes and the seal', async (t) => {
  const f = await fixture(t);
  await f.save();
  let v = await validateCurator(f.work);
  const stateFile = join(f.dir, 'base/STATE.md');
  const before = await readFile(stateFile, 'utf8');
  await writeFile(stateFile, before + 'tampered');
  await assert.rejects(applyCurator(f.work, v.seal), /CURATOR_INPUTS_CHANGED/);
  await writeFile(stateFile, before);
  f.review.summary = 'Altro rapporto';
  await f.save();
  await assert.rejects(applyCurator(f.work, v.seal), /CURATOR_STAGE_CHANGED/);
  v = await validateCurator(f.work);
  const proposal = await readFile(join(f.dir, 'proposal.json'));
  await writeFile(
    join(f.dir, 'proposal.json'),
    Buffer.concat([proposal, Buffer.from(' ')]),
  );
  await assert.rejects(applyCurator(f.work, v.seal), /CURATOR_STAGE_CHANGED/);
  await writeFile(join(f.dir, 'proposal.json'), proposal);
  await applyCurator(f.work, v.seal);
});

test('the canonical writer only produces v3 reviews', async (t) => {
  const f = await fixture(t);
  const proposal = JSON.parse(
    await readFile(join(f.dir, 'proposal.json'), 'utf8'),
  );
  await rm(join(f.dir, 'proposal.json'));
  const { proposalSha256: _, ...review } = f.review;
  await assert.rejects(
    writeCurationArtifacts(f.dir, proposal, {
      ...review,
      version: 2,
      critical: [],
    }),
    /CURATOR_REVIEW_INVALID/,
  );
  await writeCurationArtifacts(f.dir, proposal, review);
  await applyCurator(f.work, (await validateCurator(f.work)).seal);
});
