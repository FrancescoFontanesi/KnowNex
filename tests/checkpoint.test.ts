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
  await applyCurator(f.work, approved.seal, true);
  assert.equal((await f.status()).through, 2);
});

test('the old skill name is administrative history, never a new authorization', async (t) => {
  for (const native of [false, true]) {
    const f = await fixture(t);
    const text = native
      ? `[$knownex-handoff](${join(f.root, '.agents/skills/knownex-handoff/SKILL.md')})`
      : '$knownex-handoff';
    await f.event('user_message', 'old-command', text);
    const before = await readFile(f.feed);
    assert.equal((await f.status()).handoff.status, 'none');
    assert.equal((await f.status()).administrativePending, 1);
    await assert.rejects(f.prepare(), { code: 'CURATOR_HANDOFF_REQUIRED' });
    assert.deepEqual(await readFile(f.feed), before);
  }
});

test('suggestions, ordinary replies, quoted commands and legacy consent never authorize a batch', async (t) => {
  for (const text of [
    'Sì',
    'Save the progress',
    'Non ora',
    'Describe $knownex-checkpoint',
    '`$knownex-checkpoint`',
    '```\n$knownex-checkpoint\n```',
    '$knownex-checkpoint-other',
    '[$knownex-checkpoint](F:/another/.agents/skills/knownex-checkpoint/SKILL.md)',
  ])
    await t.test(text, async (t) => {
      const f = await fixture(t);
      await writeFile(
        join(f.work, 'consent.json'),
        '{"assessment":{"decision":"approved"}}',
      );
      await f.event('user_message', 'reply', text);
      const before = await readFile(f.feed);
      assert.equal((await f.status()).handoff.status, 'none');
      await assert.rejects(f.prepare(), { code: 'CURATOR_HANDOFF_REQUIRED' });
      assert.deepEqual(await readFile(f.feed), before);
      assert.equal((await f.status()).through, 0);
    });
});

test('plain, IDE-wrapped and native skill invocations each authorize one frozen batch', async (t) => {
  for (const mode of ['plain', 'ide', 'native'])
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const command =
        mode === 'native'
          ? `[$knownex-checkpoint](${join(f.root, '.agents/skills/knownex-checkpoint/SKILL.md')})`
          : mode === 'ide'
            ? ideCommand('$knownex-checkpoint')
            : '$knownex-checkpoint Consolidate this phase.';
      await f.event('user_message', 'manual', command);
      assert.equal((await f.status()).handoff.status, 'available');
      const before = await readFile(f.feed),
        prep = await f.prepare();
      const packet = JSON.parse(
        await readFile(join(prep.run!, 'packet.json'), 'utf8'),
      );
      assert.deepEqual(
        packet.events.map((e: { sequence: number }) => e.sequence),
        [1, 2],
      );
      assert.equal(packet.through, 2);
      assert.equal(packet.directive, '');
      const request = await curatorRequest(prep.run!);
      assert.equal(
        JSON.parse(request.text.split('INPUT_REFERENCES_JSON\n')[1]!).packet
          .path,
        join(prep.run!, 'packet.json'),
      );
      await assert.rejects(readFile(f.directive), { code: 'ENOENT' });
      await assert.rejects(readFile(join(f.root, '.knownex/directive.md')), {
        code: 'ENOENT',
      });
      assert.equal((await f.status()).handoff.status, 'consumed');
      assert.equal((await f.prepare()).run, prep.run);
      await f.event(
        'user_message',
        'later',
        'New technical fact after cutoff',
        'B',
      );
      const approval = await f.noop(prep);
      await applyCurator(f.work, approval.seal, true);
      const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
      await applyCurator(f.work, approval.seal, true);
      assert.deepEqual(
        await readFile(join(f.work, 'checkpoint.json')),
        checkpoint,
      );
      assert.ok(
        (await readFile(f.feed)).subarray(0, before.length).equals(before),
      );
      assert.equal((await f.status()).through, 2);
      assert.equal((await f.status()).pending, mode === 'plain' ? 2 : 1);
      assert.equal((await f.status()).pendingRaw, 2);
      if (mode === 'plain') {
        const mixed = await readPendingEvents(f.work, f.feed);
        assert.ok(mixed.events.some((e) => e.text === command));
      }
      await assert.rejects(f.prepare(), { code: 'CURATOR_HANDOFF_REQUIRED' });
      await assert.rejects(readFile(join(f.work, 'consent.json')), {
        code: 'ENOENT',
      });
    });
});

test('an assistant command and a closed user turn cannot authorize another batch', async (t) => {
  const f = await fixture(t);
  await f.event('assistant_final', 'model', '$knownex-checkpoint');
  await assert.rejects(f.prepare(), { code: 'CURATOR_HANDOFF_REQUIRED' });
  await f.event('user_message', 'manual', '$knownex-checkpoint');
  await assert.rejects(prepareCurator(f.work, undefined, { through: 4 }), {
    code: 'CURATOR_HANDOFF_CUTOFF_INVALID',
  });
  await f.event(
    'assistant_final',
    'manual',
    'Turn completed without applying.',
  );
  await assert.rejects(f.prepare(), { code: 'CURATOR_HANDOFF_REQUIRED' });
});

test('preparation failure spends the invocation and preserves pending across processes', async (t) => {
  const f = await fixture(t);
  await f.event('user_message', 'manual', '$knownex-checkpoint');
  const before = await readFile(f.feed);
  await assert.rejects(prepareCurator(f.work, join(f.root, 'missing.md')), {
    code: 'ENOENT',
  });
  await assert.rejects(f.prepare(), { code: 'CURATOR_HANDOFF_CONSUMED' });
  assert.ok((await f.status()).unconfirmedRun);
  assert.deepEqual(await readFile(f.feed), before);
  assert.equal((await f.status()).through, 0);
});

test('failed curation requires withdrawal and a new user invocation; it never renews authorization', async (t) => {
  for (const failure of ['delegation', 'json', 'review', 'before-apply'])
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      await f.event('user_message', 'manual', '$knownex-checkpoint');
      const prep = await f.prepare(),
        checkpoint = await readFile(join(f.work, 'checkpoint.json')),
        feed = await readFile(f.feed);
      if (failure === 'delegation')
        await assert.rejects(validateCurator(f.work), { code: 'ENOENT' });
      else if (failure === 'json') {
        await writeFile(prep.proposal!, '{');
        await assert.rejects(validateCurator(f.work));
      } else {
        const seal = await f.noop(prep);
        if (failure === 'before-apply')
          await assert.rejects(applyCurator(f.work, 'wrong'), {
            code: 'CURATOR_CONFIRMATION_REQUIRED',
          });
        else assert.ok(seal);
      }
      // Review rejection is an explicit fixture decision, not a semantic classifier.
      await abandonCurator(f.work, basename(prep.run!));
      await assert.rejects(f.prepare(), { code: 'CURATOR_HANDOFF_CONSUMED' });
      assert.deepEqual(
        await readFile(join(f.work, 'checkpoint.json')),
        checkpoint,
      );
      assert.deepEqual(await readFile(f.feed), feed);
      await f.event(
        'assistant_final',
        'manual',
        'Not confirmed; events retained.',
      );
      await f.event('user_message', 'retry', '$knownex-checkpoint', 'B');
      const next = await f.prepare();
      assert.notEqual(next.run, prep.run);
      await applyCurator(f.work, (await f.noop(next)).seal, true);
      assert.equal((await f.status()).through, 2);
      assert.equal((await f.status()).pending, 0);
      assert.equal((await f.status()).pendingRaw, 3);
    });
});

test('the same feed cannot spend an invocation through a different curator workspace', async (t) => {
  const f = await fixture(t);
  await f.event('user_message', 'manual', '$knownex-checkpoint');
  await f.prepare();
  const other = join(f.root, '.knownex/other');
  await initCurator(other, f.seed, f.feed, 0);
  await assert.rejects(prepareCurator(other), {
    code: 'CURATOR_WORKSPACE_CONFLICT',
  });
});

test('legacy uncommitted batches can be withdrawn but not promoted by the new policy', async (t) => {
  const f = await fixture(t);
  await f.event('user_message', 'manual', '$knownex-checkpoint');
  const prep = await f.prepare(),
    approval = await f.noop(prep);
  const file = join(prep.run!, 'run.json'),
    run = JSON.parse(await readFile(file, 'utf8'));
  delete run.authorization;
  run.consent = {
    request: 'old-request',
    sequence: 3,
    checksum: '0'.repeat(64),
  };
  await writeFile(file, JSON.stringify(run));
  await assert.rejects(applyCurator(f.work, approval.seal, true), {
    code: 'CURATOR_HANDOFF_REQUIRED',
  });
  assert.equal(
    (await abandonCurator(f.work, basename(prep.run!))).status,
    'abandoned',
  );
  assert.equal((await f.status()).through, 0);
});

test('a new manual invocation cannot bypass inconsistent storage', async (t) => {
  const f = await fixture(t);
  await f.event('user_message', 'manual', '$knownex-checkpoint');
  await f.prepare();
  const owner = await readFile(f.feed + '.curator.json');
  await writeFile(join(f.work, 'memory/STATE.md'), '# Unexpected edit\n');
  await f.event('user_message', 'new-command', '$knownex-checkpoint');
  await assert.rejects(f.prepare());
  assert.deepEqual(await readFile(f.feed + '.curator.json'), owner);
});

test('administrative handoff turns are excluded without deleting feed or hiding another session', async (t) => {
  const f = await fixture(t);
  await f.event('user_message', 'manual', '$knownex-checkpoint');
  const first = await f.prepare();
  await applyCurator(f.work, (await f.noop(first)).seal, true);
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
  await applyCurator(f.work, (await f.noop(next)).seal, true);
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

test('artifact paths need authorized Markdown links and invalid proposal UTF-8 is refused', async (t) => {
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
    state: '# State\n\nResult in `report.md`. [E001](' + packet.feed + ')\n',
    history: {
      summary: 'Result',
      topics: ['Report'],
      transition: 'Report prepared.',
    },
    knowledge: {},
  };
  await writeFile(prep.proposal!, JSON.stringify(proposal));
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_ARTIFACT_LINK_REQUIRED',
  });
  proposal.state =
    '# State\n\n[Report](' + link + ') [E001](' + packet.feed + ')\n';
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
  await assert.rejects(applyCurator(f.work, validated.seal, true), {
    code: 'CURATOR_STAGE_CHANGED',
  });
  await writeFile(prep.proposal!, good, 'utf8');
  await applyCurator(f.work, validated.seal, true);
  const state = await readFile(join(f.work, 'memory/STATE.md'), 'utf8');
  assert.ok(state.includes('[Report]('));
  assert.equal((await f.status()).through, 2);
});
