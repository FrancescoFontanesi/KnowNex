import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { appendFeedEvent } from '../src/feed.ts';
import {
  emptyMemory,
  initCurator,
  requestCurator,
  checkpointQuestion,
  prepareCurator,
  validateCurator,
  applyCurator,
  curatorStatus,
  abandonCurator,
} from '../src/curator.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-consent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, 'seed'),
    directory = join(root, 'feed');
  const work = join(root, 'curator'),
    directive = join(root, 'directive.md');
  await mkdir(seed);
  await mkdir(directory);
  for (const [name, body] of Object.entries(emptyMemory))
    await writeFile(join(seed, name), body);
  const feed = join(directory, 'project.jsonl');
  await writeFile(feed, '');
  await writeFile(directive, 'Consolidate significant facts only.');
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
  await event('user_message', 'work', 'Work');
  await event('assistant_final', 'work', 'Result');
  await event('user_message', 'ask', 'Next task');
  const request = await requestCurator(work, 'milestone-one');
  assert.equal(request.status, 'requested');
  const prepare = () =>
    prepareCurator(work, directive, { request: request.request });
  const status = () => curatorStatus(work, feed);
  return { work, feed, directive, event, request, prepare, status };
}

test('one acquired approval freezes one cutoff; CLI cannot bypass consent; failure and replay preserve pending', async (t) => {
  const f = await fixture(t);
  const other = join(f.work, '..', 'other-curator');
  await initCurator(other, join(f.work, '..', 'seed'), f.feed, 0);
  await assert.rejects(requestCurator(other, 'another-key'), {
    code: 'CURATOR_WORKSPACE_CONFLICT',
  });
  await assert.rejects(prepareCurator(f.work, f.directive), {
    code: 'CURATOR_CONSENT_REQUIRED',
  });
  await assert.rejects(f.prepare(), { code: 'CURATOR_CONSENT_REQUIRED' });
  await f.event('assistant_final', 'ask', checkpointQuestion);
  await f.event('user_message', 'approve', 'Sì');
  const prep = await f.prepare();
  assert.ok(prep.proposal);
  const packet = JSON.parse(
    await readFile(join(prep.run!, 'packet.json'), 'utf8'),
  );
  assert.deepEqual(
    packet.events.map((e: { sequence: number }) => e.sequence),
    [1, 2],
  );
  const denied = spawnSync(
    process.execPath,
    [
      'src/index.ts',
      'curate',
      'prepare',
      '--work',
      f.work,
      '--directive',
      f.directive,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.stderr).code, 'CURATOR_CONSENT_REQUIRED');
  await writeFile(prep.proposal, '{"action":"invalid"}');
  await assert.rejects(validateCurator(f.work));
  assert.equal((await f.status()).through, 0);
  assert.equal((await f.status()).pending, 5);
  // S4.4 C: a failed checkpoint report is captured, with no new request/retry.
  await f.event(
    'assistant_final',
    'approve',
    'Persistent memory validation failure',
  );
  const failedPending = await readFile(join(f.work, 'pending.json'));
  await assert.rejects(
    requestCurator(f.work, 'failure-is-not-a-new-milestone'),
    { code: 'CURATOR_PENDING_EXISTS' },
  );
  assert.deepEqual(await readFile(join(f.work, 'pending.json')), failedPending);
  assert.ok(
    (await readFile(f.feed, 'utf8')).includes(
      'Persistent memory validation failure',
    ),
  );
  assert.equal((await f.status()).through, 0);
  assert.equal((await f.status()).pending, 6);
  // Deterministic fixture correction, never an automatic LLM retry.
  await writeFile(prep.proposal, '{"action":"noop"}');
  const approval = await validateCurator(f.work);
  const ledger = await readFile(join(f.work, 'consent.json'));
  await rm(join(f.work, 'consent.json'));
  const unapproved = spawnSync(
    process.execPath,
    [
      'src/index.ts',
      'curate',
      'apply',
      '--work',
      f.work,
      '--confirm',
      approval.seal,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(unapproved.status, 1);
  assert.equal(JSON.parse(unapproved.stderr).code, 'CURATOR_CONSENT_REQUIRED');
  assert.equal((await f.status()).through, 0);
  await writeFile(join(f.work, 'consent.json'), ledger);
  await f.event('user_message', 'later', 'Later work');
  await applyCurator(f.work, approval.seal);
  const bytes = await readFile(join(f.work, 'checkpoint.json'));
  assert.equal((await f.status()).through, 2);
  assert.equal((await f.status()).pending, 5);
  await applyCurator(f.work, approval.seal); // Receipt replay creates no operation.
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), bytes);
  await assert.rejects(f.prepare(), { code: 'CURATOR_CONSENT_REQUIRED' });
});

test('non-structural failures can be withdrawn and retried only under fresh acquired consent', async (t) => {
  for (const mode of [
    'delegation',
    'invalid-json',
    'semantic-review',
    'before-apply',
  ]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      await f.event('assistant_final', 'ask', checkpointQuestion);
      await f.event('user_message', 'approve', 'Sì');
      const prep = await f.prepare();
      const runId = basename(prep.run!);
      const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
      const consent = await readFile(join(f.work, 'consent.json'));
      const feed = await readFile(f.feed);
      const run = await readFile(join(prep.run!, 'run.json'));
      let oldSeal: string | undefined;
      if (mode === 'delegation')
        await assert.rejects(validateCurator(f.work), { code: 'ENOENT' });
      else if (mode === 'invalid-json') {
        await writeFile(prep.proposal!, '{');
        await assert.rejects(validateCurator(f.work));
      } else {
        await writeFile(prep.proposal!, '{"action":"noop"}');
        oldSeal = (await validateCurator(f.work)).seal;
        // No semantic classifier: review rejection is an explicit principal decision.
        if (mode === 'before-apply')
          await assert.rejects(applyCurator(f.work, 'wrong-seal'), {
            code: 'CURATOR_CONFIRMATION_REQUIRED',
          });
      }
      assert.equal(
        await realpath((await f.status()).unconfirmedRun!),
        prep.run,
      );
      await assert.rejects(requestCurator(f.work, 'blocked-while-active'), {
        code: 'CURATOR_PENDING_EXISTS',
      });
      await assert.rejects(abandonCurator(f.work, 'wrong-run'), {
        code: 'CURATOR_STALE_BATCH',
      });
      const withdrawn = spawnSync(
        process.execPath,
        ['src/index.ts', 'curate', 'abandon', '--work', f.work, '--run', runId],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(withdrawn.status, 0, withdrawn.stderr);
      assert.equal(JSON.parse(withdrawn.stdout).status, 'abandoned');
      assert.equal((await f.status()).activeRun, null);
      assert.equal(
        await realpath((await f.status()).unconfirmedRun!),
        prep.run,
      );
      assert.equal((await f.status()).pending, 5);
      assert.deepEqual(
        await readFile(join(f.work, 'checkpoint.json')),
        checkpoint,
      );
      assert.deepEqual(await readFile(join(f.work, 'consent.json')), consent);
      assert.deepEqual(await readFile(f.feed), feed);
      assert.deepEqual(await readFile(join(prep.run!, 'run.json')), run);
      assert.equal((await abandonCurator(f.work, runId)).status, 'not_pending');
      const resumed = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          "import { curatorStatus } from './src/curator.ts'; console.log(JSON.stringify(await curatorStatus(process.argv[1], process.argv[2])));",
          f.work,
          f.feed,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(resumed.status, 0, resumed.stderr);
      const resumedState = JSON.parse(resumed.stdout);
      assert.equal(await realpath(resumedState.unconfirmedRun), prep.run);
      assert.equal(resumedState.pending, 5);
      assert.equal(resumedState.activeRun, null);
      await assert.rejects(f.prepare(), { code: 'CURATOR_CONSENT_REQUIRED' });
      if (oldSeal)
        await assert.rejects(applyCurator(f.work, oldSeal), {
          code: 'CURATOR_NO_PENDING',
        });
      await f.event(
        'assistant_final',
        'approve',
        'Materializzazione non confermata; eventi conservati.',
      );
      await f.event('user_message', 'manual', 'checkpoint', 'B');
      // A fresh process/session can create a new request, never reusing the old grant.
      const asked = spawnSync(
        process.execPath,
        [
          'src/index.ts',
          'curate',
          'request',
          '--work',
          f.work,
          '--milestone',
          'manual-new-attempt',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(asked.status, 0, asked.stderr);
      const request = JSON.parse(asked.stdout);
      assert.equal(request.status, 'requested');
      assert.notEqual(request.request, f.request.request);
      await assert.rejects(
        prepareCurator(f.work, f.directive, { request: request.request }),
        { code: 'CURATOR_CONSENT_REQUIRED' },
      );
      await f.event('assistant_final', 'manual', request.question, 'B');
      await f.event('user_message', 'manual-yes', 'Sì', 'B');
      const next = await prepareCurator(f.work, f.directive, {
        request: request.request,
      });
      assert.notEqual(next.run, prep.run);
      await writeFile(next.proposal!, '{"action":"noop"}');
      const approval = await validateCurator(f.work);
      await applyCurator(f.work, approval.seal);
      assert.equal((await f.status()).through, 6);
      assert.equal((await f.status()).pending, 3);
      assert.equal((await f.status()).unconfirmedRun, null);
      assert.ok((await readFile(f.feed)).subarray(0, feed.length).equals(feed));
    });
  }
});

test('No, ambiguity, absence and a reply in a different session never authorize; same milestone is not reasked', async (t) => {
  for (const answer of ['No', 'Forse', null, 'restart', 'unrelated', 'model']) {
    await t.test(String(answer), async (t) => {
      const f = await fixture(t);
      if (answer !== 'unrelated')
        await f.event('assistant_final', 'ask', checkpointQuestion);
      if (answer === 'model')
        await f.event('assistant_final', 'model-report', 'Sì');
      else if (answer !== null)
        await f.event(
          'user_message',
          'answer',
          answer === 'restart' || answer === 'unrelated' ? 'Sì' : answer,
          answer === 'restart' ? 'B' : 'A',
        );
      await assert.rejects(f.prepare(), { code: 'CURATOR_CONSENT_REQUIRED' });
      const restarted = spawnSync(
        process.execPath,
        [
          'src/index.ts',
          'curate',
          'prepare',
          '--work',
          f.work,
          '--directive',
          f.directive,
          '--request',
          f.request.request!,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(restarted.status, 1);
      assert.equal(
        JSON.parse(restarted.stderr).code,
        'CURATOR_CONSENT_REQUIRED',
      );
      const again = await requestCurator(f.work, 'milestone-one');
      assert.equal(again.request, f.request.request);
      assert.equal(again.question, undefined);
      assert.equal((await f.status()).through, 0);
      assert.ok((await f.status()).pending >= 3);
    });
  }
});
