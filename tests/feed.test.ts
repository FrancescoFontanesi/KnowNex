import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import type { FeedInput } from '../src/feed.ts';
import { acquireJournalLock } from '../src/journal-lock.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const input: FeedInput = {
  type: 'user_message',
  sessionId: 'session one',
  turnId: 'turn one',
  hook: 'UserPromptSubmit',
  text: '  Originale è 🧠\r\nseconda riga\t  ',
};
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'knownex-feed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, sha(input.sessionId) + '.jsonl') };
}

function verified(bytes: Buffer) {
  assert.equal(bytes.at(-1), 10);
  let previous: string | null = null;
  const events = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((raw, i) => {
      const frame = JSON.parse(raw);
      assert.equal(frame.checksum, sha(JSON.stringify(frame.block)));
      assert.equal(frame.block.previous, previous);
      assert.equal(frame.block.version, 1);
      previous = frame.checksum;
      assert.equal(frame.block.event.sequence, i + 1);
      assert.equal(
        new Date(frame.block.event.capturedAt).toISOString(),
        frame.block.event.capturedAt,
      );
      return frame.block.event;
    });
  return events;
}

test('contenuto esatto, ordine di acquisizione e quattro eventi distinti per due turni', async (t) => {
  const { directory, file } = await fixture(t);
  const values: FeedInput[] = [
    input,
    { ...input, type: 'assistant_final', hook: 'Stop', text: 'Risposta 1' },
    { ...input, turnId: 'turn two' },
    {
      ...input,
      turnId: 'turn two',
      type: 'assistant_final',
      hook: 'Stop',
      text: '',
    },
  ];
  let before = Buffer.alloc(0);
  for (const [i, value] of values.entries()) {
    assert.deepEqual(await appendFeedEvent(directory, value), {
      appended: 1,
      sequence: i + 1,
      recoveredBytes: 0,
    });
    const current = await readFile(file);
    assert.deepEqual(current.subarray(0, before.length), before);
    before = current;
  }
  const events = verified(before);
  assert.deepEqual(
    events.map(({ sequence, capturedAt, ...event }) => event),
    values,
  );
  assert.deepEqual(
    events.map((e) => e.turnId),
    ['turn one', 'turn one', 'turn two', 'turn two'],
  );
});

test('ripetizioni sono no-op, conflitti preservano il registro e sessioni diverse restano separate', async (t) => {
  const { directory, file } = await fixture(t);
  await appendFeedEvent(directory, input);
  const before = await readFile(file);
  assert.equal((await appendFeedEvent(directory, input)).appended, 0);
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(
    appendFeedEvent(directory, { ...input, text: 'diverso' }),
    { code: 'FEED_CONFLICT' },
  );
  assert.deepEqual(await readFile(file), before);
  await appendFeedEvent(directory, {
    ...input,
    sessionId: '../../other-session',
  });
  assert.equal((await readdir(directory)).length, 2);
  const other = join(directory, sha('../../other-session') + '.jsonl');
  assert.equal(verified(await readFile(other))[0].text, input.text);
});

test('recovery da transazione interrotta o commit con esito incerto preserva gli eventi confermati', async (t) => {
  const { directory, file } = await fixture(t);
  await appendFeedEvent(directory, input);
  const before = await readFile(file);
  const next: FeedInput = { ...input, type: 'assistant_final', hook: 'Stop' };
  await appendFeedEvent(directory, next);
  const committed = await readFile(file),
    tail = committed.subarray(before.length);
  const unicode = tail.indexOf(Buffer.from('🧠'));
  assert.ok(unicode > 0);
  for (const cut of [
    0,
    1,
    Math.floor(tail.length / 2),
    unicode + 1,
    tail.length - 1,
    tail.length,
  ]) {
    await writeFile(file, Buffer.concat([before, tail.subarray(0, cut)]));
    const result = await appendFeedEvent(directory, next);
    assert.equal(result.appended, cut === tail.length ? 0 : 1);
    assert.equal(result.sequence, 2);
    assert.equal(result.recoveredBytes, cut === tail.length ? 0 : cut);
    const recovered = await readFile(file);
    assert.deepEqual(recovered.subarray(0, before.length), before);
    assert.deepEqual(
      verified(recovered).map((e) => e.text),
      [input.text, next.text],
    );
  }
  // Even a replay of an earlier event can safely remove an uncommitted tail.
  await writeFile(file, Buffer.concat([before, tail.subarray(0, unicode + 1)]));
  assert.equal((await appendFeedEvent(directory, input)).appended, 0);
  assert.deepEqual(await readFile(file), before);
});

test('corruzione completa e conflitto con coda incompleta non vengono cancellati', async (t) => {
  const { directory, file } = await fixture(t);
  await appendFeedEvent(directory, input);
  const before = await readFile(file);
  await appendFile(file, '{unfinished');
  const incomplete = await readFile(file);
  await assert.rejects(
    appendFeedEvent(directory, { ...input, text: 'conflict' }),
    { code: 'FEED_CONFLICT' },
  );
  assert.deepEqual(await readFile(file), incomplete);
  const original = JSON.parse(before.toString('utf8'));
  for (const change of [
    (f: typeof original) => {
      f.block.event.text += 'tampered';
    },
    (f: typeof original) => {
      f.block.event.sequence = 8;
      f.checksum = sha(JSON.stringify(f.block));
    },
    (f: typeof original) => {
      f.block.previous = '0'.repeat(64);
      f.checksum = sha(JSON.stringify(f.block));
    },
    (f: typeof original) => {
      f.block.event.sessionId = 'other';
      f.checksum = sha(JSON.stringify(f.block));
    },
  ]) {
    const frame = structuredClone(original);
    change(frame);
    const corrupt = Buffer.from(JSON.stringify(frame) + '\n');
    await writeFile(file, corrupt);
    await assert.rejects(appendFeedEvent(directory, input), {
      code: 'FEED_CORRUPT',
    });
    assert.deepEqual(await readFile(file), corrupt);
  }
});

test('il lock condiviso rifiuta uno scrittore concorrente senza modificare dati', async (t) => {
  const { directory, file } = await fixture(t);
  await appendFeedEvent(directory, input);
  const before = await readFile(file);
  const release = await acquireJournalLock(file + '.lock');
  try {
    await assert.rejects(
      appendFeedEvent(directory, { ...input, turnId: 'next' }),
      { code: 'DESTINATION_BUSY' },
    );
    assert.deepEqual(await readFile(file), before);
  } finally {
    await release();
  }
  assert.equal(
    (await appendFeedEvent(directory, { ...input, turnId: 'next' })).appended,
    1,
  );
});
