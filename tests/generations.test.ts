import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { syncSession } from '../src/capture.ts';

const sessionId = 'synthetic-session';
const jsonl = (records: unknown[]) =>
  records.map((x) => JSON.stringify(x) + '\n').join('');
const meta = (id = sessionId) => ({
  type: 'session_meta',
  payload: { id, history_mode: 'legacy' },
});
const legacy = Array.from({ length: 36 }, (_, i) =>
  i === 0 || i === 28
    ? meta()
    : i === 19
      ? {
          type: 'response_item',
          payload: {
            type: 'reasoning',
            id: 'reasoning-fixture',
            encrypted_content: 'synthetic',
          },
        }
      : {
          timestamp: `synthetic-${i}`,
          type: 'event_msg',
          payload: {
            type: i % 2 ? 'agent_message' : 'user_message',
            message: `fixture ${i} è 🧠`,
          },
        },
);
// Observed rewrite: four converted events, null reasoning content, omitted metadata,
// ordinals and 17 additional records: 36 legacy records become 52 source records.
const rewritten = legacy.flatMap((r, i) =>
  i === 28
    ? []
    : [
        {
          ...r,
          payload:
            i === 0
              ? { ...r.payload, history_mode: 'paginated' }
              : i === 19
                ? { ...r.payload, content: null }
                : [17, 20, 30, 32].includes(i)
                  ? { type: 'item_completed', item: r.payload }
                  : r.payload,
        },
      ],
);
const paginated = [
  ...rewritten,
  ...Array.from({ length: 17 }, (_, i) => ({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: `new-${i}` },
  })),
].map((r, ordinal) => ({ ...r, ordinal }));

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'knownex-generations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.jsonl'),
    destination = join(dir, 'capture.jsonl');
  await writeFile(source, jsonl(legacy));
  return { source, destination };
}

async function replace(source: string, text: string) {
  await writeFile(source + '.new', text);
  await rename(source + '.new', source);
}

// Independent oracle: validate chain, raw bytes and per-generation byte offsets.
function inspect(bytes: Buffer) {
  let previous = null;
  const generations = new Map<number, string[]>();
  const frames = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const { block, checksum } of frames) {
    assert.equal(
      checksum,
      createHash('sha256').update(JSON.stringify(block)).digest('hex'),
    );
    assert.equal(block.previous, previous);
    previous = checksum;
    const id = block.generation ?? 1;
    const records = generations.get(id) ?? [];
    assert.equal(
      block.from,
      Buffer.byteLength(records.map((r) => r + '\n').join('')),
    );
    records.push(...block.records);
    const text = records.map((r) => r + '\n').join('');
    assert.equal(block.cursor.offset, Buffer.byteLength(text));
    assert.equal(
      block.cursor.prefixHash,
      createHash('sha256').update(text).digest('hex'),
    );
    generations.set(id, records);
  }
  return { frames, generations };
}

test('36 legacy + 52 paginated, no-op, append e riavvio mantengono generazioni separate', async (t) => {
  const { source, destination } = await fixture(t);
  assert.equal((await syncSession(source, destination)).appended, 36);
  const before = await readFile(destination);
  assert.equal(inspect(before).frames[0].block.version, 1);
  await replace(source, jsonl(paginated));
  assert.equal((await syncSession(source, destination)).appended, 52);
  const after = await readFile(destination);
  assert.ok(after.subarray(0, before.length).equals(before));
  const { frames, generations } = inspect(after);
  assert.deepEqual([...generations.keys()], [1, 2]);
  assert.equal(
    generations
      .get(1)!
      .map((r) => r + '\n')
      .join(''),
    jsonl(legacy),
  );
  assert.equal(
    generations
      .get(2)!
      .map((r) => r + '\n')
      .join(''),
    jsonl(paginated),
  );
  assert.equal(frames[1].block.version, 2);
  assert.equal(frames[1].block.sessionId, sessionId);
  assert.equal(frames[1].block.transition, 'FILE_CHANGED');
  assert.equal((await syncSession(source, destination)).appended, 0);
  assert.deepEqual(await readFile(destination), after);
  const cli = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const restarted = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, 'sync', '--source', source, '--destination', destination],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(restarted.appended, 0);
  assert.deepEqual(await readFile(destination), after);
  const extra = jsonl([
    {
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'append' },
    },
  ]);
  await appendFile(source, extra);
  assert.equal((await syncSession(source, destination)).appended, 1);
  const final = inspect(await readFile(destination));
  assert.equal(final.generations.size, 2);
  assert.equal(final.generations.get(2)!.length, 53);
  assert.equal(final.frames[2].block.transition, undefined);
  assert.equal(await readFile(source, 'utf8'), jsonl(paginated) + extra);
});

test('transizione interrotta: recupero da tagli prima e dopo il commit preserva i blocchi precedenti', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  const before = await readFile(destination);
  await replace(source, jsonl(paginated));
  await syncSession(source, destination);
  const committed = await readFile(destination);
  const frame = committed.subarray(before.length);
  for (const cut of [
    0,
    1,
    Math.floor(frame.length / 2),
    frame.length - 1,
    frame.length,
  ]) {
    await writeFile(
      destination,
      Buffer.concat([before, frame.subarray(0, cut)]),
    );
    const result = await syncSession(source, destination);
    assert.equal(result.appended, cut === frame.length ? 0 : 52);
    assert.equal(result.recoveredBytes, cut === frame.length ? 0 : cut);
    const recovered = await readFile(destination);
    assert.ok(recovered.subarray(0, before.length).equals(before));
    assert.deepEqual(recovered, committed);
    assert.equal(inspect(recovered).generations.get(2)!.length, 52);
  }
});

test('sorgente sostitutiva estranea, incerta o malformata non modifica il registro', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  const before = await readFile(destination);
  for (const [text, code] of [
    [jsonl([meta('other-session')]), 'SOURCE_MISMATCH'],
    [jsonl([{ value: 'no identity' }]), 'SOURCE_MISMATCH'],
    ['', 'SOURCE_MISMATCH'],
    [jsonl([meta()]) + '{broken}\n', 'JSONL_MALFORMED'],
    [jsonl([meta(), meta('other-session')]), 'SOURCE_MISMATCH'],
  ]) {
    await replace(source, text);
    await assert.rejects(syncSession(source, destination), { code });
    assert.deepEqual(await readFile(destination), before);
  }
});

test('generazioni successive e metadati contraddittori non aggirano i controlli di recovery', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  await replace(source, jsonl(paginated));
  await syncSession(source, destination);
  const second = await readFile(destination);
  await appendFile(source, jsonl([meta('other-session')]));
  await assert.rejects(syncSession(source, destination), {
    code: 'SOURCE_MISMATCH',
  });
  assert.deepEqual(await readFile(destination), second);
  await replace(
    source,
    jsonl([meta(), { type: 'event_msg', payload: { type: 'task_complete' } }]),
  );
  assert.equal((await syncSession(source, destination)).appended, 2);
  const third = await readFile(destination);
  assert.deepEqual([...inspect(third).generations.keys()], [1, 2, 3]);
  for (const change of [
    { generation: 5 },
    { generation: 2 },
    { sessionId: 'other-session' },
    { transition: undefined },
  ]) {
    const frames = third
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    const last = frames.at(-1);
    Object.assign(last.block, change);
    last.checksum = createHash('sha256')
      .update(JSON.stringify(last.block))
      .digest('hex');
    const corrupt = Buffer.from(
      frames.map((frame) => JSON.stringify(frame) + '\n').join(''),
    );
    await writeFile(destination, corrupt);
    await assert.rejects(syncSession(source, destination), {
      code: 'LOG_CORRUPT',
    });
    assert.deepEqual(await readFile(destination), corrupt);
  }
});
