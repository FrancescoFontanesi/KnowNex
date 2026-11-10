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
import { appendFeedEvent } from '../src/feed.ts';

const hash = (text: string | Buffer) =>
  createHash('sha256').update(text).digest('hex');
const historical =
  'Il p95 sotto 900 ms per ricerca testuale semplice è un target, non una misura.\n' +
  "L'ingestione richiede staging e switch dopo validazione per evitare indici misti; la tenuta ai crash non è testata.\n" +
  'Unicode: ≥ 5 µm, °C, 漢字, e\u0301, 😀.\n' +
  'Retention: 14 giorni.\nRipetuto.\nRipetuto.\n';
const reference = (text: string, startLine: number, endLine = startLine) => ({
  sha256: hash(text),
  startLine,
  endLine,
});

async function fixture(t: test.TestContext, content = historical) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-critical-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory');
  const work = join(root, '.knownex/internal/curator');
  const feed = join(root, '.knownex/internal/feed');
  await mkdir(memory, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  const append = (n: number) =>
    appendFeedEvent(feed, {
      type: 'user_message',
      sessionId: 's',
      turnId: String(n),
      text: n === 1 ? historical : 'Retention ora 7 giorni; resto invariato.',
      hook: 'UserPromptSubmit',
    });
  await append(1);
  await initCurator(work, memory, join(feed, hash('s') + '.jsonl'), 0);
  const first = await prepareCurator(work, undefined, {
    through: 1,
    autonomous: true,
  });
  const packet = JSON.parse(
    await readFile(join(first.run!, 'packet.json'), 'utf8'),
  );
  const state = content + '\n# VELA\n\n[E001](' + packet.feed + ')\n';
  const proposal = {
    action: 'update',
    state,
    history: { summary: 'Initial', topics: ['Test'], transition: 'Initial.' },
    knowledge: {},
  };
  const bytes = JSON.stringify(proposal);
  const initialReview = {
    version: 2,
    proposalSha256: hash(bytes),
    summary: 'Review',
    sources: [1],
    changes: [{ path: 'STATE.md', summary: 'State', sources: [1] }],
    critical: [] as unknown[],
    uncertainties: [],
    anomalies: [],
  };
  await writeFile(first.proposal!, bytes);
  await writeFile(
    join(first.run!, 'review.json'),
    JSON.stringify(initialReview),
  );
  await applyCurator(work, (await validateCurator(work)).seal);
  await append(2);
  const prepared = await prepareCurator(work, undefined, {
    through: 2,
    autonomous: true,
  });
  const dir = prepared.run!;
  const p = JSON.parse(await readFile(join(dir, 'packet.json'), 'utf8'));
  const before = await readFile(join(dir, 'base/STATE.md'), 'utf8');
  assert.equal(before, p.context['STATE.md']);
  const after =
    before.replace('14 giorni', '7 giorni') + '\n[E002](' + p.feed + ')\n';
  const next = { ...proposal, state: after };
  const nextBytes = JSON.stringify(next);
  await writeFile(prepared.proposal!, nextBytes);
  const review = {
    ...initialReview,
    proposalSha256: hash(nextBytes),
    sources: [2],
    changes: [{ path: 'STATE.md', summary: 'Retention', sources: [2] }],
    critical: [] as unknown[],
  };
  const save = () =>
    writeFile(join(dir, 'review.json'), JSON.stringify(review));
  const entry = (old: unknown, current: unknown) => ({
    before: old,
    after: current,
    reason: 'Continuità o modifica autorizzata.',
    sources: [2],
  });
  return { work, memory, dir, before, after, review, save, entry };
}

test('critical evidence resolves VELA CP3 typography from frozen lines, without rewriting review bytes', async (t) => {
  const f = await fixture(t);
  const manifest = JSON.parse(
    await readFile(join(f.dir, 'inputs.json'), 'utf8'),
  );
  assert.equal(manifest.files['base/STATE.md'].sha256, hash(f.before));
  for (const quote of [
    'il p95 sotto 900 ms per ricerca testuale semplice è un target, non una misura',
    'L’ingestione richiede staging e switch dopo validazione per evitare indici misti; la tenuta ai crash non è testata.',
  ]) {
    f.review.critical = [f.entry(quote, quote)];
    await f.save();
    await assert.rejects(validateCurator(f.work), /CURATOR_REVIEW_INVALID/);
  }
  f.review.critical = [1, 2, 3, 5, 6].map((line) =>
    f.entry(reference(f.before, line), reference(f.after, line)),
  );
  f.review.critical.push(
    f.entry(reference(f.before, 4), reference(f.after, 4)),
  );
  await f.save();
  const original = await readFile(join(f.dir, 'review.json'));
  const validated = await validateCurator(f.work);
  assert.ok(validated.review);
  assert.equal(
    validated.review.report.critical[0]!.before,
    f.before.split('\n')[0],
  );
  assert.equal(
    validated.review.report.critical[1]!.before,
    f.before.split('\n')[1],
  );
  assert.equal(
    validated.review.report.critical[2]!.before,
    f.before.split('\n')[2],
  );
  assert.equal(
    validated.review.report.critical[5]!.before,
    'Retention: 14 giorni.',
  );
  assert.equal(
    validated.review.report.critical[5]!.after,
    'Retention: 7 giorni.',
  );
  assert.equal(validated.review.sha256, hash(original));
  assert.deepEqual(await readFile(join(f.dir, 'review.json')), original);
  await applyCurator(f.work, validated.seal);
  assert.ok(
    (await readFile(join(f.memory, 'STATE.md'), 'utf8')).includes('7 giorni'),
  );
  const history = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  assert.ok(history.includes('Retention: 14 giorni.'));
});

test('critical evidence rejects absent, ambiguous, wrong-version and mismatched range claims', async (t) => {
  const f = await fixture(t);
  const good = reference(f.before, 1);
  const invalid: unknown[] = [
    'missing historical element',
    'Ripetuto.',
    'Unicode: ≥ 5 µm, °C, 漢字, é, 😀.', // NFC is not the original NFD.
    { ...good, sha256: hash(f.after) },
    { ...good, sha256: hash(f.before.toUpperCase()) },
    { ...good, startLine: 0 },
    { ...good, startLine: 999 },
    { ...good, endLine: 999 },
    { ...good, endLine: 0 },
    { ...good, startLine: 1.5 },
    { ...good, endLine: 1.5 },
    { ...good, startLine: '1' },
    { ...good, startLine: 3, endLine: 2 },
    { ...good, sha256: undefined },
    { ...good, file: 'STATE.md' },
    { ...good, text: 'unrelated invented quotation' },
  ];
  for (const ref of invalid) {
    f.review.critical = [f.entry(ref, reference(f.after, 1))];
    await f.save();
    await assert.rejects(validateCurator(f.work), /CURATOR_REVIEW_INVALID/);
  }
  f.review.critical = [f.entry(good, reference(f.before, 4))];
  await f.save();
  await assert.rejects(validateCurator(f.work), /CURATOR_REVIEW_INVALID/);
  f.review.critical = [f.entry('', '')];
  await f.save();
  await assert.rejects(validateCurator(f.work), /CURATOR_REVIEW_INVALID/);
  f.review.critical = [
    f.entry(f.before.split('\n')[0], f.after.split('\n')[0]),
  ];
  await f.save();
  await validateCurator(f.work); // Unambiguous literal citations remain supported.
  f.review.version = 1;
  f.review.critical = [f.entry(good, reference(f.after, 1))];
  await f.save();
  await assert.rejects(validateCurator(f.work), /CURATOR_REVIEW_INVALID/);
  f.review.critical = [f.entry('Ripetuto.', 'Ripetuto.')];
  await f.save();
  const legacy = await validateCurator(f.work);
  await applyCurator(f.work, legacy.seal); // Preserve old literal semantics and seals.
});

test('resolved critical evidence stays bound to inputs, proposal and the raw review seal', async (t) => {
  const f = await fixture(t);
  f.review.critical = [f.entry(reference(f.before, 4), reference(f.after, 4))];
  await f.save();
  let v = await validateCurator(f.work);
  const stateFile = join(f.dir, 'base/STATE.md');
  await writeFile(stateFile, f.before + 'tampered');
  await assert.rejects(applyCurator(f.work, v.seal), /CURATOR_INPUTS_CHANGED/);
  await writeFile(stateFile, f.before);
  f.review.critical = [f.entry(reference(f.before, 1), reference(f.after, 1))];
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

test('critical evidence supports additions, removals and noop without changing frozen versions', async (t) => {
  const f = await fixture(t);
  f.review.critical = [
    f.entry('', reference(f.after, 4)),
    f.entry(reference(f.before, 4), ''),
    f.entry(reference(f.before, 1, 3), reference(f.after, 1, 3)),
  ];
  await f.save();
  const updated = await validateCurator(f.work);
  assert.equal(
    updated.review!.report.critical[2]!.before,
    f.before.split('\n').slice(0, 3).join('\n'),
  );
  const noop = JSON.stringify({ action: 'noop' });
  await writeFile(join(f.dir, 'proposal.json'), noop);
  f.review.proposalSha256 = hash(noop);
  f.review.changes = [];
  f.review.critical = [f.entry(reference(f.before, 1), reference(f.before, 1))];
  await f.save();
  const validated = await validateCurator(f.work);
  await applyCurator(f.work, validated.seal);
  const checkpoint = JSON.parse(
    await readFile(join(f.work, 'checkpoint.json'), 'utf8'),
  );
  assert.equal(checkpoint.sequence, 2);
  assert.ok(
    (await readFile(join(f.memory, 'STATE.md'), 'utf8')).includes('14 giorni'),
  );
});

test('critical evidence preserves CRLF bytes and rejects hashes of normalized text', async (t) => {
  const f = await fixture(t, historical.replaceAll('\n', '\r\n'));
  const ref = reference(f.before, 1, 3);
  f.review.critical = [f.entry(ref, reference(f.after, 1, 3))];
  await f.save();
  const v = await validateCurator(f.work);
  assert.equal(
    v.review!.report.critical[0]!.before,
    f.before.split('\n').slice(0, 3).join('\n'),
  );
  assert.ok(v.review!.report.critical[0]!.before.endsWith('\r'));
  f.review.critical = [
    f.entry(
      { ...ref, sha256: hash(f.before.replaceAll('\r\n', '\n')) },
      reference(f.after, 1, 3),
    ),
  ];
  await f.save();
  await assert.rejects(validateCurator(f.work), /CURATOR_REVIEW_INVALID/);
});
