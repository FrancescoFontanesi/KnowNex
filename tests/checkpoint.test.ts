import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { appendFeedEvent } from '../src/feed/feed.ts';
import {
  emptyMemory,
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  abandonCurator,
  curatorStatus,
} from '../src/curation/curator.ts';

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'knownex-checkpoint-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.knownex/feed'),
    work = join(root, '.knownex/curator'),
    seed = join(root, 'memory');
  const feed = join(directory, 'project.jsonl'),
    directive = join(root, 'directive.md');
  await mkdir(directory, { recursive: true });
  await mkdir(seed);
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(seed, name), text);
  await writeFile(feed, '');
  await initCurator(work, seed, feed, 0);
  const event = (
    type: 'user_message' | 'assistant_final',
    turnId: string,
    text: string,
    sessionId = 'A',
  ) =>
    appendFeedEvent(directory, {
      type,
      turnId,
      text,
      sessionId,
      hook: type === 'user_message' ? 'UserPromptSubmit' : 'Stop',
    });
  await event(
    'user_message',
    'work',
    'Project decision and open prerequisite.',
  );
  await event(
    'assistant_final',
    'work',
    'Result verified. You can invoke $knownex-checkpoint when useful.',
  );
  const prepare = () => prepareCurator(work);
  const status = () => curatorStatus(work, feed);
  const noop = async (run: { proposal?: string }) => {
    await writeFile(run.proposal!, '{"action":"noop"}');
    return validateCurator(work);
  };
  return {
    root,
    work,
    seed,
    feed,
    directive,
    directory,
    event,
    prepare,
    status,
    noop,
  };
}
test('optional UTF-8 priorities are frozen once; a prepared batch needs no external directive file', async (t) => {
  const f = await fixture(t);
  const priority =
    'Priorita: caffè, Ελληνικά, 日本語, 🧠, e\u0301. Verificare il blocker aperto.';
  await writeFile(f.directive, priority, 'utf8');
  const prepared = await prepareCurator(f.work, f.directive);
  const packet = await readFile(join(prepared.run!, 'packet.json'));
  const run = await readFile(join(prepared.run!, 'run.json'));
  assert.equal(JSON.parse(packet.toString('utf8')).directive, priority);
  await unlink(f.directive);
  assert.equal((await f.prepare()).run, prepared.run);
  assert.deepEqual(await readFile(join(prepared.run!, 'packet.json')), packet);
  assert.deepEqual(await readFile(join(prepared.run!, 'run.json')), run);
  const approved = await f.noop(prepared);
  await applyCurator(f.work, approved.seal);
  assert.equal((await f.status()).through, 2);
});

test('prepare is triggered by the command, independently of the last user text', async (t) => {
  for (const text of [
    'Continue',
    'Describe $knownex-checkpoint',
    '\x60$knownex-checkpoint\x60',
    '$knownex-checkpoint-other',
  ]) {
    const f = await fixture(t);
    await f.event('user_message', 'later', text);
    const p = await f.prepare();
    assert.equal(p.through, 3);
    const packet = JSON.parse(
      await readFile(join(p.run!, 'packet.json'), 'utf8'),
    );
    assert.equal(packet.events.at(-1).text, text);
    assert.equal((await f.status()).through, 0);
  }
});

test('explicit withdrawal preserves failed source events and permits another explicit prepare', async (t) => {
  const f = await fixture(t);
  const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
  await assert.rejects(prepareCurator(f.work, join(f.root, 'missing.md')), {
    code: 'ENOENT',
  });
  const p = await f.prepare();
  await writeFile(p.proposal!, '{');
  await assert.rejects(validateCurator(f.work));
  assert.equal((await f.prepare()).run, p.run);
  await abandonCurator(f.work, basename(p.run!));
  const next = await f.prepare();
  assert.notEqual(next.run, p.run);
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), checkpoint);
  await applyCurator(f.work, (await f.noop(next)).seal);
  assert.equal((await f.status()).through, 2);
});

test('one feed cannot be prepared by a different curator workspace', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const other = join(f.root, '.knownex/other');
  await initCurator(other, f.seed, f.feed, 0);
  await assert.rejects(prepareCurator(other), {
    code: 'CURATOR_WORKSPACE_CONFLICT',
  });
});

test('changing the frozen run after validation cannot bypass the publication seal', async (t) => {
  const f = await fixture(t);
  const p = await f.prepare(),
    approval = await f.noop(p);
  const file = join(p.run!, 'run.json'),
    run = JSON.parse(await readFile(file, 'utf8'));
  run.directive = 'Changed after validation';
  await writeFile(file, JSON.stringify(run));
  await assert.rejects(applyCurator(f.work, approval.seal), {
    code: 'CURATOR_STAGE_CHANGED',
  });
});

test('a new prepare cannot bypass inconsistent memory', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const owner = await readFile(f.feed + '.curator.json');
  await writeFile(join(f.work, 'memory/STATE.md'), '# Unexpected edit\n');
  await assert.rejects(f.prepare());
  assert.deepEqual(await readFile(f.feed + '.curator.json'), owner);
});

test('artifacts are cited as workspace paths, links stay limited to authorized files, invalid proposal UTF-8 is refused', async (t) => {
  const f = await fixture(t);
  const artifact = join(f.root, 'report.md');
  await writeFile(artifact, '# Report\n');
  const prep = await prepareCurator(f.work, undefined, {
    artifacts: [artifact],
  });
  const packet = JSON.parse(
    await readFile(join(prep.run!, 'packet.json'), 'utf8'),
  );
  const link = packet.artifacts.find((p: string) => p.endsWith('/report.md'));
  const proposal = {
    action: 'update',
    state: '# State\n\nResult in `report.md`. [E001]\n',
    history: {
      summary: 'Result',
      topics: ['Report'],
      transition: 'Report prepared.',
    },
    knowledge: {},
  };
  // A plain workspace path is the canonical artifact reference: no link is required.
  await writeFile(prep.proposal!, JSON.stringify(proposal));
  await validateCurator(f.work);
  const outside = join(f.root, 'secret.md');
  await writeFile(outside, '# Secret\n');
  proposal.state = '# State\n\n[Secret](../../secret.md) [E001]\n';
  await writeFile(prep.proposal!, JSON.stringify(proposal));
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_LINK_INVALID',
  });
  proposal.state = '# State\n\n[Report](' + link + ') [E001]\n';
  const good = JSON.stringify(proposal);
  await writeFile(
    prep.proposal!,
    Buffer.from(good.replace('# State', '# St\xffte'), 'latin1'),
  );
  await assert.rejects(validateCurator(f.work), {
    code: 'KNOWNEX_UTF8_INVALID',
  });
  await writeFile(prep.proposal!, good, 'utf8');
  const validated = await validateCurator(f.work);
  assert.equal(
    validated.proposalSha256,
    createHash('sha256').update(Buffer.from(good)).digest('hex'),
  );
  await writeFile(prep.proposal!, good + '\n');
  await assert.rejects(applyCurator(f.work, validated.seal), {
    code: 'CURATOR_STAGE_CHANGED',
  });
  await writeFile(prep.proposal!, good, 'utf8');
  await applyCurator(f.work, validated.seal);
  const state = await readFile(join(f.work, 'memory/STATE.md'), 'utf8');
  assert.ok(state.includes('[Report]('));
  assert.equal((await f.status()).through, 2);
});
