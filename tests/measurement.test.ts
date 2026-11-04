import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { measureContext, measureRuntime } from '../scripts/measure.ts';

test('runtime counts unique responses, not cumulative mirrors; scopes turns and exposes incomplete evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-measure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'runtime.jsonl');
  const u = (input: number, output: number) => ({
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  });
  const event = (type: string) => ({
    type: 'event_msg',
    payload: { type, turn_id: 'turn' },
  });
  const record = (id: string, input: number, cumulative: number) => ({
    type: 'token_usage_record',
    payload: {
      response_id: id,
      turn_id: 'turn',
      thread_id: 'thread',
      usage: u(input, 2),
      turn_token_usage: u(cumulative, id === 'a' ? 2 : 4),
    },
  });
  const rows = [
    event('task_started'),
    record('a', 10, 10),
    record('a', 10, 10),
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: u(999, 999) },
      },
    },
    {
      ...record('foreign', 100, 100),
      payload: { ...record('foreign', 100, 100).payload, turn_id: 'other' },
    },
    record('b', 20, 30),
    event('task_complete'),
  ];
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(source, text);
  const result = await measureRuntime(source, 'turn');
  assert.equal(result.coverage, 'complete');
  assert.equal(result.modelResponses, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.totals?.input_tokens, 30);
  assert.equal(result.totals?.output_tokens, 4);
  assert.equal(result.totals?.cached_input_tokens, null);
  assert.equal(result.monetaryCost, null);
  assert.equal((await measureRuntime(source, 'absent')).modelResponses, null);
  await writeFile(source, text + '{"partial":');
  assert.equal((await measureRuntime(source, 'turn')).coverage, 'partial');
  await writeFile(
    source,
    [record('a', 10, 10), record('a', 11, 11)]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  await assert.rejects(
    measureRuntime(source, 'turn'),
    /MEASUREMENT_USAGE_CONFLICT/,
  );
  await writeFile(
    source,
    [record('a', 10, 10), record('a', 10, 11)]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  await assert.rejects(
    measureRuntime(source, 'turn'),
    /MEASUREMENT_USAGE_CONFLICT/,
  );
  await writeFile(
    source,
    [event('task_started'), record('b', 20, 30), event('task_complete')]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  assert.equal((await measureRuntime(source, 'turn')).coverage, 'partial');
  await writeFile(source, Buffer.from([0xff, 10]));
  await assert.rejects(measureRuntime(source, 'turn'));
});

test('context measures UTF-8 and fingerprints complete offered files without claiming delivery or leaking content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-measure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sample = 'Caff\u00e8 \u6f22\u5b57 \ud83d\ude00 e\u0301';
  const packet = {
    from: 2,
    through: 2,
    directive: 'preserve',
    events: [{ text: sample }],
    context: { 'STATE.md': sample, 'knowledge/topic.md': sample + sample },
  };
  await writeFile(join(root, 'packet.json'), JSON.stringify(packet));
  for (const name of ['WINDOW.md', 'SKILL.md', 'MEMORY-CONTRACT.md'])
    await writeFile(join(root, name), sample);
  const before = await readFile(join(root, 'packet.json'));
  const result = await measureContext(root);
  assert.equal(result.pendingTextBytes, Buffer.byteLength(sample));
  assert.equal(result.knowledgeTextBytes, 2 * Buffer.byteLength(sample));
  assert.equal(result.contextTextBytes, 3 * Buffer.byteLength(sample));
  assert.equal(result.files['packet.json']!.bytes, before.length);
  assert.ok(result.delivery.startsWith('prepared'));
  assert.ok(!JSON.stringify(result).includes(sample));
  assert.deepEqual(await readFile(join(root, 'packet.json')), before);
});

test('command wrapper preserves raw bytes, logs repeated calls and errors, and propagates exit status', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-measure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, 'calls.jsonl');
  const script = resolve('scripts/measure.ts');
  const source =
    "process.stdout.write(Buffer.from([0xc3,0xa9,0,255]));process.stderr.write('err');process.exitCode=7";
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [
      script,
      'tool',
      '--log',
      log,
      '--',
      process.execPath,
      '-e',
      source,
    ]);
    assert.equal(result.status, 7);
    assert.deepEqual(result.stdout, Buffer.from([0xc3, 0xa9, 0, 255]));
    assert.equal(result.stderr.toString(), 'err');
  }
  const failed = spawnSync(process.execPath, [
    script,
    'tool',
    '--log',
    log,
    '--',
    join(root, 'missing-executable'),
  ]);
  assert.equal(failed.status, 1);
  const rows = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
  assert.equal(rows[0].stdout.bytes, 4);
  assert.equal(rows[0].stderr.bytes, 3);
  assert.equal(rows[0].complete, true);
  assert.equal(rows[2].complete, false);
  assert.equal(rows[2].spawnError, 'ENOENT');
});

test('report output never overwrites an earlier measurement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-measure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'runtime.jsonl'),
    output = join(root, 'report.json');
  await writeFile(source, '');
  await writeFile(output, 'earlier evidence');
  const result = spawnSync(process.execPath, [
    resolve('scripts/measure.ts'),
    'runtime',
    '--source',
    source,
    '--turn',
    't',
    '--output',
    output,
  ]);
  assert.equal(result.status, 1);
  assert.equal(await readFile(output, 'utf8'), 'earlier evidence');
});
