import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { appendFeedEvent } from '../src/feed/feed.ts';
import {
  applyCurator,
  emptyMemory,
  initCurator,
  prepareCurator,
  validateCurator,
} from '../src/curation/curator.ts';
import { memoryEvent } from '../src/memory/navigator.ts';

const entry = resolve('src/index.ts');
const unicode = 'Caffè Ελληνικά 日本語 🧠 é "\n';

async function fixture(t: TestContext, events = 25) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knownex-event-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory');
  const work = join(root, '.knownex/internal/curator');
  const directory = join(root, '.knownex/internal/feed');
  await mkdir(memory, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  for (let n = 1; n <= events; n++)
    await appendFeedEvent(directory, {
      type: n % 2 ? 'user_message' : 'assistant_final',
      sessionId: 's',
      turnId: String(n),
      text: n === 1 ? unicode : 'evento ' + n,
      hook: n % 2 ? 'UserPromptSubmit' : 'Stop',
    });
  await initCurator(work, memory, join(directory, 'project.jsonl'), 0);
  const directive = join(root, 'directive.md');
  await writeFile(directive, 'Synthetic protocol test only.');
  const prep = await prepareCurator(work, directive, { through: 2 });
  await writeFile(prep.proposal!, '{"action":"noop"}');
  await applyCurator(work, (await validateCurator(work)).seal);
  return { root, memory };
}
const cli = (memory: string, label: string) =>
  spawnSync(
    process.execPath,
    [entry, 'memory', 'event', label, '--memory', memory],
    {
      encoding: 'utf8',
    },
  );

test('memory event rereads curated events, ranges and enforces bounds', async (t) => {
  const { memory } = await fixture(t);
  const [one] = await memoryEvent(memory, 'E001');
  assert.equal(one!.sequence, 1);
  assert.equal(one!.type, 'user_message');
  assert.equal(one!.sessionId, 's');
  assert.equal(one!.turnId, '1');
  assert.equal(one!.text, unicode);
  for (const label of ['E002..E004', 'E002–E004', 'E002-E004'])
    assert.deepEqual(
      (await memoryEvent(memory, label)).map((e) => e.sequence),
      [2, 3, 4],
    );
  assert.equal((await memoryEvent(memory, 'E001..E020')).length, 20);
  await assert.rejects(memoryEvent(memory, 'E001..E021'), {
    code: 'MEMORY_INVALID_ID',
  });
  await assert.rejects(memoryEvent(memory, 'E025..E026'), {
    code: 'MEMORY_NOT_FOUND',
  });
  await assert.rejects(memoryEvent(memory, 'E999'), {
    code: 'MEMORY_NOT_FOUND',
  });
  for (const bad of [
    'E1',
    'E002..E001',
    'X',
    'E000',
    '',
    'E0001',
    'E001..E0002',
  ])
    await assert.rejects(memoryEvent(memory, bad), {
      code: 'MEMORY_INVALID_ID',
    });
});

test('memory event CLI exit codes and standalone memory without feed', async (t) => {
  const { memory, root } = await fixture(t);
  const ok = cli(memory, 'E001');
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(/^[\x20-\x7e\n]*$/.test(ok.stdout));
  assert.equal(JSON.parse(ok.stdout).events[0].text, unicode);
  const missing = cli(memory, 'E026');
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).code, 'MEMORY_NOT_FOUND');
  for (const bad of ['E1', 'E002..E001', 'X', 'E001..E021'])
    assert.equal(cli(memory, bad).status, 2, bad);
  const standalone = join(root, 'copy/memory');
  await mkdir(standalone, { recursive: true });
  const r = cli(standalone, 'E001');
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).code, 'MEMORY_FEED_UNAVAILABLE');
});
