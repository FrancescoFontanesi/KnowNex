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
import { appendFeedEvent } from '../src/feed.ts';
import { curatorRequest } from '../scripts/curator-request.ts';
import {
  emptyMemory,
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  abandonCurator,
  curatorStatus,
  readPendingEvents,
} from '../src/curator.ts';

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
    appendFeedEvent(
      directory,
      {
        type,
        turnId,
        text,
        sessionId,
        hook: type === 'user_message' ? 'UserPromptSubmit' : 'Stop',
      },
      true,
    );
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
const ideCommand = (body: string) =>
  '# Context from my IDE setup:\n\n## Active file: file.md\n\n## Open tabs:\n- file.md: file.md\n\n## My request:\n' +
  body;

test('optional UTF-8 priorities are frozen once; a prepared batch needs no external directive file', async (t) => {
  const f = await fixture(t);
  await f.event('user_message', 'manual', '$knownex-checkpoint');
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

test('administrative turns remain excluded after subsequent messages from another session', async (t) => {
  for (const mode of ['plain', 'ide', 'native']) {
    const f = await fixture(t);
    const command =
      mode === 'native'
        ? '[$knownex-checkpoint](' +
          join(f.root, '.agents/skills/knownex-checkpoint/SKILL.md') +
          ')'
        : mode === 'ide'
          ? ideCommand('$knownex-checkpoint')
          : '$knownex-checkpoint';
    await f.event('user_message', 'admin', command);
    await f.event('assistant_final', 'admin', 'Administrative report.');
    await f.event('user_message', 'next', 'New project fact.', 'B');
    const p = await f.prepare();
    const packet = JSON.parse(
      await readFile(join(p.run!, 'packet.json'), 'utf8'),
    );
    assert.deepEqual(
      packet.events.map((e: { sequence: number }) => e.sequence),
      [1, 2, 5],
    );
    assert.equal(p.through, 5);
    assert.equal(packet.administrativeExcluded, 2);
    await applyCurator(f.work, (await f.noop(p)).seal);
    assert.equal((await f.status()).through, 5);
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

test('administrative handoff turns are excluded without deleting feed or hiding another session', async (t) => {
  const f = await fixture(t);
  await f.event('user_message', 'manual', '$knownex-checkpoint');
  const first = await f.prepare();
  await applyCurator(f.work, (await f.noop(first)).seal);
  await f.event('user_message', 'other-work', 'Critical new project fact', 'B');
  await f.event('assistant_final', 'other-work', 'Independent result', 'B');
  await f.event('assistant_final', 'manual', 'Progressi salvati.');
  assert.equal((await f.status()).pending, 2);
  assert.equal((await f.status()).pendingRaw, 4);
  await f.event('user_message', 'second', '$knownex-checkpoint');
  const next = await f.prepare();
  const packet = JSON.parse(
    await readFile(join(next.run!, 'packet.json'), 'utf8'),
  );
  assert.equal(packet.through, 5);
  assert.deepEqual(
    packet.events.map((e: { sequence: number }) => e.sequence),
    [4, 5],
  );
  assert.equal(packet.administrativeExcluded, 1);
  await applyCurator(f.work, (await f.noop(next)).seal);
  await appendFeedEvent(
    f.directory,
    {
      type: 'assistant_commentary',
      sessionId: 'A',
      turnId: 'second',
      hook: 'Stop',
      messageId: 'persistence-step',
      text: 'Validazione e applicazione in corso.',
      source: {
        transcriptPath: join(f.root, 'synthetic.jsonl'),
        fileId: 'synthetic',
        snapshotHash: 'a'.repeat(64),
        recordHash: 'b'.repeat(64),
        recordOffset: 0,
        recordBytes: 64,
        turnSource: 'turn_context',
      },
    },
    true,
  );
  await f.event('assistant_final', 'second', 'Progressi salvati.');
  const bytes = await readFile(f.feed),
    cp = await readFile(join(f.work, 'checkpoint.json'));
  const status = await f.status();
  assert.equal(status.pending, 0);
  assert.equal(status.pendingRaw, 4);
  assert.equal(status.administrativePending, 4);
  const view = await readPendingEvents(f.work, f.feed, { limit: 1 });
  assert.deepEqual(view.events, []);
  assert.equal(view.complete, true);
  assert.equal(view.administrativeExcluded, 4);
  const raw = await readPendingEvents(f.work, f.feed, {
    includeAdministrative: true,
    limit: 1,
  });
  assert.equal(raw.events.length, 1);
  await assert.rejects(
    readPendingEvents(f.work, f.feed, {
      cursor: raw.nextCursor!,
      includeAdministrative: false,
    }),
    { code: 'CURATOR_PENDING_CURSOR_STALE' },
  );
  assert.deepEqual(await readFile(f.feed), bytes);
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), cp);
});

test('artifacts are cited as workspace paths, links stay limited to authorized files, invalid proposal UTF-8 is refused', async (t) => {
  const f = await fixture(t);
  const artifact = join(f.root, 'report.md');
  await writeFile(artifact, '# Report\n');
  await f.event('user_message', 'manual', '$knownex-checkpoint');
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
