import assert from 'node:assert/strict';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import {
  initCurator,
  readPendingEvents,
  requestCurator,
  checkpointQuestion,
  prepareCurator,
  validateCurator,
  applyCurator,
} from '../src/curator.ts';
import { sessionContext, runtimeStatus } from '../src/runtime.ts';

async function fixture(t: TestContext, largeState = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'knownex-pending-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.knownex/feed'),
    seed = join(root, 'memory'),
    work = join(root, '.knownex/curator');
  await mkdir(directory, { recursive: true });
  await mkdir(seed);
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
  await event('user_message', 'initial', 'Decisione A; collaudo P aperto.');
  await writeFile(
    join(seed, 'STATE.md'),
    '# Stato\n\nDecisione A; collaudo P aperto. ' +
      (largeState ? 'x'.repeat(7000) : '') +
      '\n[E001](../.knownex/feed/project.jsonl)\n',
  );
  await writeFile(join(seed, 'HISTORY.md'), '# History\n');
  const feed = join(directory, 'project.jsonl');
  // Reviewed synthetic initial state, not a product bootstrap bypass.
  await initCurator(work, seed, feed, 1);
  const read = (options = {}) => readPendingEvents(work, feed, options);
  const paths = [
    feed,
    join(work, 'checkpoint.json'),
    join(work, 'memory/STATE.md'),
    join(work, 'memory/HISTORY.md'),
    join(work, 'consent.json'),
    join(work, 'pending.json'),
  ];
  const snapshot = () =>
    Promise.all(
      paths.map(async (file) => {
        try {
          return {
            file,
            bytes: await readFile(file),
            mtime: (await stat(file, { bigint: true })).mtimeNs,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return { file, absent: true };
          throw error;
        }
      }),
    );
  return { root, work, feed, event, read, snapshot };
}

test('A/B: later sessions retrieve completion and supersession sources in bounded stable windows', async (t) => {
  const f = await fixture(t);
  const completion =
    'Collaudo P completato secondo il report di A (risultato dichiarato).';
  const decision = 'Decisione utente: B sostituisce A.';
  await f.event('assistant_final', 'initial', completion);
  await f.event('user_message', 'change', decision);
  await f.event('assistant_final', 'change', 'Decisione ricevuta.');
  const before = await f.snapshot();
  const context = await sessionContext(f.root);
  assert.match(context, /confermato fino al checkpoint E1/);
  assert.match(context, /Eventi successivi possono cambiare/);
  assert.ok(context.includes('Decisione A'));
  assert.ok(!context.includes(completion)); // No automatic pending injection.
  const first = await f.read({ limit: 1 });
  assert.equal(first.events[0]!.text, completion);
  assert.equal(first.events[0]!.sessionId, 'A');
  assert.equal(first.pendingComplete, false);
  assert.ok(first.nextCursor);
  assert.deepEqual(await f.snapshot(), before);
  await f.event('user_message', 'resume', 'Riprendi il lavoro', 'B');
  const afterAppend = await f.snapshot();
  const second = await f.read({ cursor: first.nextCursor!, limit: 1 });
  assert.equal(second.events[0]!.text, decision);
  assert.equal(second.newerEvents, 1);
  const third = await f.read({ cursor: second.nextCursor! });
  assert.equal(third.complete, true);
  assert.equal(third.pendingComplete, false);
  assert.deepEqual(
    [first, second, third].flatMap((page) =>
      page.events.map((e) => e.sequence),
    ),
    [2, 3, 4],
  );
  const bytes = await readFile(f.feed);
  for (const e of [...first.events, ...second.events, ...third.events]) {
    const [start, end] = e.sourceBytes as number[];
    const frame = JSON.parse(bytes.subarray(start, end).toString('utf8'));
    assert.equal(frame.checksum, e.checksum);
    assert.equal(frame.block.event.text, e.text);
  }
  assert.deepEqual(await f.snapshot(), afterAppend);
});

test('C: deferred checkpoint does not prevent read-only recall; no consent is consumed and stale cursors fail', async (t) => {
  const f = await fixture(t);
  await f.event('assistant_final', 'initial', 'Progresso dopo il checkpoint');
  await f.event('user_message', 'ask', 'Prosegui');
  const request = await requestCurator(f.work, 'deferred');
  await f.event('assistant_final', 'ask', checkpointQuestion);
  await f.event('user_message', 'no', 'No');
  const before = await f.snapshot();
  const runtime = await runtimeStatus(f.root);
  assert.ok(runtime.status === 'ok');
  assert.equal(runtime.consent?.status, 'declined');
  const page = await f.read({ limit: 1 });
  const child = spawnSync(
    process.execPath,
    [
      'src/index.ts',
      'pending',
      '--workspace',
      f.root,
      '--from',
      '2',
      '--through',
      '5',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
  const read = JSON.parse(child.stdout);
  assert.equal(read.cutoff, 1);
  assert.equal(read.events[0].text, 'Progresso dopo il checkpoint');
  assert.equal(read.events.at(-1).text, 'No');
  assert.ok(Buffer.byteLength(child.stdout) <= 16384);
  const directive = join(f.root, 'directive.md');
  await writeFile(directive, 'Synthetic protocol test only.');
  await assert.rejects(
    prepareCurator(f.work, directive, { request: request.request }),
    { code: 'CURATOR_CONSENT_REQUIRED' },
  );
  assert.deepEqual(await f.snapshot(), before);
  // Only a separate, explicitly approved operation changes the checkpoint.
  await f.event('user_message', 'manual', 'checkpoint', 'B');
  const next = await requestCurator(f.work, 'fresh-manual');
  await f.event('assistant_final', 'manual', next.question!, 'B');
  await f.event('user_message', 'yes', 'Sì', 'B');
  const prep = await prepareCurator(f.work, directive, {
    request: next.request,
  });
  await writeFile(prep.proposal!, '{"action":"noop"}');
  await applyCurator(f.work, (await validateCurator(f.work)).seal);
  const committed = await f.snapshot();
  await assert.rejects(f.read({ cursor: page.nextCursor! }), {
    code: 'CURATOR_PENDING_CURSOR_STALE',
  });
  assert.deepEqual(await f.snapshot(), committed);
});

test('D: omitted STATE, long Unicode events and incomplete feed tails have explicit coverage limits', async (t) => {
  const f = await fixture(t, true);
  const text = 'Caffè Ελληνικά 日本語 🧠 e\u0301 "\u0000\n'.repeat(2000);
  await f.event('assistant_final', 'initial', text);
  const before = await f.snapshot();
  const context = await sessionContext(f.root);
  assert.match(context, /STATE oltre il limite di contesto/);
  assert.ok(!context.includes('x'.repeat(7000)));
  assert.ok(Buffer.byteLength(context) < 8192);
  let page = await f.read();
  assert.equal(page.events[0]!.textComplete, false);
  assert.equal(page.complete, false);
  const fragments: string[] = [];
  let lastCursor: string | undefined;
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 30);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) + 1 <= 16384);
    for (const event of page.events) fragments.push(event.text as string);
    if (!page.nextCursor) break;
    lastCursor = page.nextCursor;
    page = await f.read({ cursor: lastCursor });
  }
  assert.deepEqual(Buffer.from(fragments.join('')), Buffer.from(text));
  assert.equal(page.pendingComplete, true);
  assert.deepEqual(await f.snapshot(), before);
  await appendFile(f.feed, '{"unfinished":');
  const incomplete = await f.snapshot();
  assert.ok(lastCursor);
  const tail = await f.read({ cursor: lastCursor });
  assert.ok(tail.incompleteTailBytes > 0);
  assert.equal(tail.complete, true);
  assert.equal(tail.pendingComplete, false);
  assert.deepEqual(await f.snapshot(), incomplete);
});
