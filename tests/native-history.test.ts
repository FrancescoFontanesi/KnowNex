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
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import { nativeThread } from '../src/native-history.ts';
import {
  emptyMemory,
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  curatorStatus,
  readPendingEvents,
} from '../src/curator.ts';
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'knownex-feed-authority-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const prior = process.env.KNOWNEX_CODEX_BIN;
  process.env.KNOWNEX_CODEX_BIN = join(root, 'no-codex.exe');
  t.after(() => {
    if (prior === undefined) delete process.env.KNOWNEX_CODEX_BIN;
    else process.env.KNOWNEX_CODEX_BIN = prior;
  });
  const directory = join(root, '.knownex/feed'),
    feed = join(directory, 'project.jsonl'),
    work = join(root, '.knownex/curator'),
    seed = join(root, 'seed');
  await mkdir(directory, { recursive: true });
  await mkdir(seed);
  for (const [n, text] of Object.entries(emptyMemory))
    await writeFile(join(seed, n), text);
  await writeFile(feed, '');
  await initCurator(work, seed, feed, 0);
  const checkpoint = join(work, 'checkpoint.json');
  const cp = JSON.parse(await readFile(checkpoint, 'utf8'));
  cp.nativeHistory = true;
  await writeFile(checkpoint, JSON.stringify(cp));
  const event = async (
    turnId: string,
    text: string,
    type: 'user_message' | 'assistant_final' = 'user_message',
    nativeThreadId: string | null = 'original-thread',
  ) =>
    appendFeedEvent(
      directory,
      {
        type,
        sessionId: 'original-session',
        nativeThreadId,
        turnId,
        text,
        hook: type === 'user_message' ? 'UserPromptSubmit' : 'Stop',
      },
      true,
    );
  const pair = async (turn: string) => {
    await event(turn, 'Persist ' + turn);
    await event(turn, 'Confirmed ' + turn, 'assistant_final', null);
  };
  const prepare = () => prepareCurator(work);
  const proposal = async (p: Awaited<ReturnType<typeof prepare>>) => {
    const packet = JSON.parse(
      await readFile(join(p.run!, 'packet.json'), 'utf8'),
    );
    await writeFile(
      p.proposal!,
      JSON.stringify({
        action: 'update',
        state:
          '# Project\n\nProgress [E' +
          String(packet.through).padStart(3, '0') +
          '](' +
          packet.feed +
          ')\n',
        history: {
          summary: 'Progress',
          topics: ['Project'],
          transition: 'Recorded progress.',
        },
        knowledge: {},
      }),
    );
    return validateCurator(work);
  };
  return {
    root,
    directory,
    feed,
    work,
    checkpoint,
    event,
    pair,
    prepare,
    proposal,
  };
}
test('capture reads only local native header; missing history never invents identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-header-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.jsonl');
  await writeFile(
    source,
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'fork', session_id: 'tree' },
    }) + '\n',
  );
  assert.equal(await nativeThread(source, 'tree'), 'fork');
  await assert.rejects(nativeThread(source, 'different'), {
    code: 'FEED_NATIVE_IDENTITY_INVALID',
  });
});
test('recorded feed is authoritative with nativeHistory metadata and unavailable Codex', async (t) => {
  const f = await fixture(t);
  await f.pair('first');
  await f.pair('second');
  await f.event('authorize', '$knownex-checkpoint');
  const raw = await readFile(f.feed),
    p = await f.prepare(),
    packet = JSON.parse(await readFile(join(p.run!, 'packet.json'), 'utf8'));
  assert.deepEqual(
    packet.events.map((e: { sequence: number }) => e.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(packet.discardedExcluded, 0);
  const approved = await f.proposal(p);
  await applyCurator(f.work, approved.seal);
  assert.equal((await curatorStatus(f.work, f.feed)).through, 4);
  assert.equal(
    JSON.parse(await readFile(f.checkpoint, 'utf8')).nativeHistory,
    true,
  );
  assert.deepEqual(await readFile(f.feed), raw);
  await applyCurator(f.work, approved.seal);
  await f.pair('third');
  await f.event('authorize-next', '$knownex-checkpoint');
  const next = await f.prepare(),
    approval = await f.proposal(next);
  await applyCurator(f.work, approval.seal);
  assert.equal(
    (await readFile(join(f.work, 'memory/HISTORY.md'), 'utf8')).match(
      /:begin -->/g,
    )?.length,
    2,
  );
});
test('legacy confirmed exclusions remain fixed without rewriting the feed', async (t) => {
  const f = await fixture(t);
  await f.pair('first');
  await f.event('authorize', '$knownex-checkpoint');
  const p = await f.prepare(),
    file = join(p.run!, 'run.json');
  const run = JSON.parse(await readFile(file, 'utf8'));
  run.excluded = [1];
  await writeFile(file, JSON.stringify(run));
  const approved = await f.proposal(p);
  await applyCurator(f.work, approved.seal);
  await f.pair('next');
  await f.event('authorize-next', '$knownex-checkpoint');
  const raw = await readFile(f.feed),
    next = await f.prepare(),
    approval = await f.proposal(next);
  await applyCurator(f.work, approval.seal);
  assert.deepEqual(
    JSON.parse(await readFile(f.checkpoint, 'utf8')).excluded,
    [1],
  );
  assert.deepEqual(await readFile(f.feed), raw);
});
test('legacy frozen run exclusions can complete without native history', async (t) => {
  const f = await fixture(t);
  await f.pair('first');
  await f.event('authorize', '$knownex-checkpoint');
  const p = await f.prepare(),
    file = join(p.run!, 'run.json');
  const run = JSON.parse(await readFile(file, 'utf8'));
  run.excluded = [1];
  run.nativeHistory = true;
  await writeFile(file, JSON.stringify(run));
  const approval = await f.proposal(p);
  await applyCurator(f.work, approval.seal);
  assert.deepEqual(
    JSON.parse(await readFile(f.checkpoint, 'utf8')).excluded,
    [1],
  );
});
for (const kind of ['corrupt', 'truncate'] as const)
  test(
    'feed ' +
      kind +
      ' after prepare rejects publication without changing memory',
    async (t) => {
      const f = await fixture(t);
      await f.pair('first');
      await f.event('authorize', '$knownex-checkpoint');
      const p = await f.prepare(),
        approval = await f.proposal(p);
      const cp = await readFile(f.checkpoint),
        state = await readFile(join(f.work, 'memory/STATE.md')),
        raw = await readFile(f.feed, 'utf8');
      await writeFile(
        f.feed,
        kind === 'corrupt'
          ? raw.replace('Persist first', 'Changed first')
          : raw.slice(0, raw.indexOf('\n') + 1),
      );
      await assert.rejects(applyCurator(f.work, approval.seal));
      assert.deepEqual(await readFile(f.checkpoint), cp);
      assert.deepEqual(await readFile(join(f.work, 'memory/STATE.md')), state);
    },
  );
test('pending selection depends on recorded feed, not external native edits', async (t) => {
  const f = await fixture(t);
  await f.pair('first');
  await f.pair('second');
  const first = await readPendingEvents(f.work, f.feed, { limit: 1 });
  assert.ok(first.nextCursor);
  const next = await readPendingEvents(f.work, f.feed, {
    cursor: first.nextCursor!,
  });
  assert.ok(next.events.length);
  assert.equal(
    (await readPendingEvents(f.work, f.feed, { includeAdministrative: true }))
      .discardedExcluded,
    0,
  );
});

test('feed is rechecked at the final apply boundary after staging sync', async (t) => {
  const f = await fixture(t);
  await f.pair('first');
  await f.event('authorize', '$knownex-checkpoint');
  const p = await f.prepare(),
    approval = await f.proposal(p);
  const cp = await readFile(f.checkpoint),
    state = await readFile(join(f.work, 'memory/STATE.md'));
  const module = pathToFileURL(join(process.cwd(), 'src/curator.ts')).href;
  const code = `const fs=await import('node:fs/promises'),open=fs.default.open;
fs.default.open=async(...args)=>{const h=await open(...args);
if(String(args[0]).replaceAll('\\\\','/').endsWith('/runs/'+${JSON.stringify(p.run!.split(/[\\/]/).at(-1))}+'/run.json')){
 const sync=h.sync.bind(h);h.sync=async()=>{await sync();await fs.default.writeFile(${JSON.stringify(f.feed)},'corrupt\\n');};}
return h;};
(await import('node:module')).syncBuiltinESMExports();
try{await (await import(${JSON.stringify(module)})).applyCurator(${JSON.stringify(f.work)},${JSON.stringify(approval.seal)});process.exitCode=2;}
catch(e){console.log(e.code);process.exitCode=e.code==='CURATOR_FEED_CORRUPT'?0:3;}`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /CURATOR_FEED_CORRUPT/);
  assert.deepEqual(await readFile(f.checkpoint), cp);
  assert.deepEqual(await readFile(join(f.work, 'memory/STATE.md')), state);
});
