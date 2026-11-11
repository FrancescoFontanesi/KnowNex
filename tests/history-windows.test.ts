import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { historySegments, historyWindow } from '../src/history.ts';
import { historyAppendix } from './legacy-history.ts';
import { memoryFind, memoryHistory, memoryRead } from '../src/navigator.ts';
import { initCurator } from '../src/curator.ts';
import { appendFeedEvent } from '../src/feed.ts';
import { createHash } from 'node:crypto';

const date = '2026-11-03T12:00:00.000Z';
const details = (topic: string) => ({
  summary: topic + ' outcome',
  topics: [topic],
  transition: 'Confirmed ' + topic,
});

/** Standalone memory whose HISTORY mixes two inline segments and two later windows. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-history-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, 'memory');
  await mkdir(join(memory, 'history'), { recursive: true });
  await mkdir(join(memory, 'knowledge'), { recursive: true });
  await writeFile(join(memory, 'STATE.md'), '# State\n\nNow. [E004]\n');
  let history = '# History\n';
  history += historyAppendix(history, '# Old\n', 1, 1, date, details('inline'));
  history += historyAppendix(history, '# Old\n', 2, 2, date, details('inline'));
  const windows: Record<string, string> = {};
  for (const n of [3, 4]) {
    const entry = historyWindow(
      history,
      n,
      n,
      date,
      details(n === 3 ? 'windowtopic' : 'latest'),
      [],
      `# State ${n}\n\nThen. [E00${n}]\n`,
    );
    history += entry.index;
    windows[entry.name] = entry.text;
    await writeFile(join(memory, entry.name), entry.text);
  }
  await writeFile(join(memory, 'HISTORY.md'), history);
  return { memory, history, windows };
}

test('inline segments and windows share one numbering and are read through the same references', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    historySegments(f.history, 4).map((s) => [s.id, s.window]),
    [
      ['H000001', undefined],
      ['H000002', undefined],
      ['H000003', 'history/H000003.md'],
      ['H000004', 'history/H000004.md'],
    ],
  );
  const window = f.windows['history/H000003.md']!;
  for (const id of ['H000003', 'history/H000003.md', 'HISTORY.md#h000003']) {
    const read = await memoryRead(f.memory, id);
    assert.equal(read.content, window, id);
    assert.equal(read.path, 'history/H000003.md', id);
  }
  const inline = await memoryRead(f.memory, 'H000002');
  assert.equal(inline.path, 'HISTORY.md');
  assert.match(inline.content, /### STATE precedente/);
  const [found] = await memoryFind(f.memory, 'windowtopic', 'history');
  assert.equal(found!.id, 'H000003');
  assert.equal(found!.reference, 'history/H000003.md');
});

test('memory history lists newest first, pages with --before and returns no bodies', async (t) => {
  const f = await fixture(t);
  const latest = await memoryHistory(f.memory, { last: 3 });
  assert.deepEqual(
    latest.map((e) => [e.id, e.path]),
    [
      ['H000004', 'history/H000004.md'],
      ['H000003', 'history/H000003.md'],
      ['H000002', 'HISTORY.md'],
    ],
  );
  assert.equal(latest[0]!.description, 'latest outcome');
  assert.ok(latest.every((e) => !('content' in e)));
  assert.deepEqual(
    (await memoryHistory(f.memory, { before: 'H000003' })).map((e) => e.id),
    ['H000002', 'H000001'],
  );
  await assert.rejects(memoryHistory(f.memory, { before: 'H000009' }), {
    code: 'MEMORY_NOT_FOUND',
  });
  for (const last of [0, 51, 1.5])
    await assert.rejects(memoryHistory(f.memory, { last }), {
      code: 'MEMORY_INVALID_ID',
    });
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['src/index.ts', 'memory', 'history', ...args, '--memory', f.memory],
      { encoding: 'utf8', windowsHide: true },
    );
  const one = cli('--last', '1');
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(
    JSON.parse(one.stdout).results.map((e: { id: string }) => e.id),
    ['H000004'],
  );
  for (const bad of [['--last', '0'], ['--last', 'x'], ['extra']])
    assert.notEqual(cli(...bad).status, 0, bad.join(' '));
});

test('index lines must be sequential, canonical and within the cutoff', (t) => {
  const base = '# History\n';
  const line = (id: string, from: string, to: string) =>
    `- [${id}](history/${id}.md) · \`${date}\` · \`${from}..${to}\` · T — D\n`;
  assert.equal(
    historySegments(base + line('H000001', 'E001', 'E002'), 2).length,
    1,
  );
  for (const [name, text, cutoff] of [
    ['wrong id', line('H000002', 'E001', 'E002'), 2],
    [
      'label id differs from its window',
      line('H000001', 'E001', 'E002').replace('[H000001]', '[H000002]'),
      2,
    ],
    ['zero-padded label', line('H000001', 'E0001', 'E002'), 2],
    [
      'window of another id',
      line('H000001', 'E001', 'E002').replace(
        'history/H000001',
        'history/H000009',
      ),
      2,
    ],
    ['non-canonical label', line('H000001', 'E01', 'E002'), 2],
    ['reversed range', line('H000001', 'E002', 'E001'), 2],
    ['beyond cutoff', line('H000001', 'E001', 'E003'), 2],
    [
      'overlapping ranges',
      line('H000001', 'E001', 'E002') + line('H000002', 'E002', 'E003'),
      3,
    ],
    ['invalid date', line('H000001', 'E001', 'E002').replace(date, 'ieri'), 2],
  ] as const)
    assert.throws(
      () => historySegments(base + text, cutoff),
      {
        code: 'CURATOR_HISTORY_INVALID',
      },
      name,
    );
});

test('an imported memory must index every window, and every indexed window must exist', async (t) => {
  const index = historyWindow(
    '# History\n',
    1,
    2,
    date,
    details('t'),
    [],
    '# S\n\nOra. [E001]\n',
  );
  const cases: [string, Record<string, string>, string | undefined][] = [
    [
      'missing window',
      { 'HISTORY.md': '# History\n' + index.index },
      'CURATOR_HISTORY_INVALID',
    ],
    [
      'orphan window',
      { 'HISTORY.md': '# History\n', [index.name]: index.text },
      'CURATOR_HISTORY_INVALID',
    ],
    [
      'window stored under another id',
      {
        'HISTORY.md': '# History\n' + index.index,
        'history/H000002.md': index.text,
      },
      'CURATOR_HISTORY_INVALID',
    ],
    [
      'indexed window',
      { 'HISTORY.md': '# History\n' + index.index, [index.name]: index.text },
      undefined,
    ],
  ];
  for (const [name, files, code] of cases) {
    const root = await mkdtemp(join(tmpdir(), 'knownex-history-import-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const memory = join(root, 'memory'),
      feed = join(root, 'feed');
    await mkdir(join(memory, 'history'), { recursive: true });
    await writeFile(join(memory, 'STATE.md'), '# State\n\nOra. [E001]\n');
    for (const [file, text] of Object.entries(files))
      await writeFile(join(memory, file), text);
    for (const turn of ['1', '2'])
      await appendFeedEvent(feed, {
        type: 'user_message',
        sessionId: 's',
        turnId: turn,
        text: 'evento ' + turn,
        hook: 'UserPromptSubmit',
      });
    const init = initCurator(
      join(root, 'work'),
      memory,
      join(feed, createHash('sha256').update('s').digest('hex') + '.jsonl'),
      2,
    );
    if (code) await assert.rejects(init, { code }, name);
    else await init;
  }
});
