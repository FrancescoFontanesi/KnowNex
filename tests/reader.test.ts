import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { readJsonl, ReaderError } from '../src/reader.ts';
import type { ReadCursor } from '../src/reader.ts';

async function fixture(t: TestContext, data: string | Uint8Array = '') {
  const directory = await mkdtemp(join(tmpdir(), 'knownex-reader-'));
  t.after(async () => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'session.jsonl');
  await writeFile(path, data);
  return path;
}

function readerError(code: ReaderError['code'], offset?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof ReaderError);
    assert.equal(error.code, code);
    if (offset !== undefined) assert.equal(error.offset, offset);
    return true;
  };
}

test('prima lettura conserva ogni valore JSON e le righe originali, inclusi CRLF e numeri grandi', async (t) => {
  const lines = [
    ' {"n":9007199254740993,"text":"città 🧠"} \r',
    'null',
    '[1,true]',
  ];
  const source = lines.join('\n') + '\n';
  const path = await fixture(t, source);
  const before = await stat(path, { bigint: true });
  const result = await readJsonl(path);
  assert.deepEqual(
    result.records.map((r) => r.raw),
    lines,
  );
  assert.deepEqual(
    result.records.map((r) => r.value),
    lines.map((line) => JSON.parse(line)),
  );
  assert.equal(result.cursor.offset, Buffer.byteLength(source));
  assert.deepEqual(await readFile(path), Buffer.from(source));
  const after = await stat(path, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.size, before.size);
});

test('append e riavvio con cursore serializzato restituiscono solo nuovi record senza mutare il cursore', async (t) => {
  const path = await fixture(t, '{"id":1}\n');
  const first = await readJsonl(path);
  const cursor = Object.freeze(
    JSON.parse(JSON.stringify(first.cursor)) as ReadCursor,
  );
  assert.deepEqual((await readJsonl(path, cursor)).records, []);
  await appendFile(path, '{"id":2}\n{"id":3}\n');
  const second = await readJsonl(path, cursor);
  assert.deepEqual(
    second.records.map((r) => r.value),
    [{ id: 2 }, { id: 3 }],
  );
  assert.equal(cursor.offset, Buffer.byteLength('{"id":1}\n'));
  const restarted = JSON.parse(JSON.stringify(second.cursor)) as ReadCursor;
  const unchanged = await readJsonl(path, restarted);
  assert.deepEqual(unchanged.records, []);
  assert.deepEqual(unchanged.cursor, restarted);
});

test('file vuoto e JSON valido senza LF non avanzano; LF completa il record', async (t) => {
  const path = await fixture(t);
  const empty = await readJsonl(path);
  assert.equal(empty.cursor.offset, 0);
  assert.deepEqual(empty.records, []);
  await appendFile(path, '{"id":1}');
  const partial = await readJsonl(path, empty.cursor);
  assert.deepEqual(partial.cursor, empty.cursor);
  assert.deepEqual(partial.records, []);
  await appendFile(path, '\n');
  assert.deepEqual(
    (await readJsonl(path, partial.cursor)).records.map((r) => r.value),
    [{ id: 1 }],
  );
});

test('coda incompleta con carattere UTF-8 spezzato viene riletta dal confine corretto', async (t) => {
  const first = Buffer.from('{"id":1}\n');
  const next = Buffer.from('{"text":"🧠è"}\n');
  const split = next.indexOf(Buffer.from('🧠')) + 2;
  const path = await fixture(
    t,
    Buffer.concat([first, next.subarray(0, split)]),
  );
  const result = await readJsonl(path);
  assert.equal(result.records.length, 1);
  assert.equal(result.cursor.offset, first.length);
  await appendFile(path, next.subarray(split));
  const completed = await readJsonl(path, result.cursor);
  assert.deepEqual(
    completed.records.map((r) => r.value),
    [{ text: '🧠è' }],
  );
  assert.equal(completed.cursor.offset, first.length + next.length);
});

test('troncamento segnala FILE_CHANGED e non riparte silenziosamente', async (t) => {
  const path = await fixture(t, '{"id":1}\n{"id":2}\n');
  const { cursor } = await readJsonl(path);
  await truncate(path, 0);
  await assert.rejects(
    readJsonl(path, cursor),
    readerError('FILE_CHANGED', cursor.offset),
  );
});

test('sostituzione con contenuto identico segnala FILE_CHANGED', async (t) => {
  const source = '{"id":1}\n';
  const path = await fixture(t, source);
  const { cursor } = await readJsonl(path);
  await rename(path, path + '.previous');
  await writeFile(path, source);
  await assert.rejects(
    readJsonl(path, cursor),
    readerError('FILE_CHANGED', cursor.offset),
  );
});

test('riscritture sullo stesso file, anche ricresciuto, invalidano il prefisso consumato', async (t) => {
  for (const replacement of ['{"id":9}\n', '{"id":9}\n{"id":2}\n']) {
    const path = await fixture(t, '{"id":1}\n');
    const { cursor } = await readJsonl(path);
    await writeFile(path, replacement);
    await assert.rejects(
      readJsonl(path, cursor),
      readerError('FILE_CHANGED', cursor.offset),
    );
  }
});

test('JSON completo malformato segnala offset byte esatto e non modifica dati o cursore', async (t) => {
  const first = '{"text":"è"}\n';
  const path = await fixture(t, first);
  const { cursor } = await readJsonl(path);
  const saved = { ...cursor };
  const source = first + '{"secret":invalid}\n{"id":2}\n';
  await appendFile(path, source.slice(first.length));
  await assert.rejects(
    readJsonl(path, cursor),
    readerError('JSONL_MALFORMED', Buffer.byteLength(first)),
  );
  assert.deepEqual(cursor, saved);
  assert.deepEqual(await readFile(path), Buffer.from(source));
});

test('riga vuota, BOM e UTF-8 non valido non vengono ignorati o sostituiti', async (t) => {
  for (const data of [
    Buffer.from('\n'),
    Buffer.from('\uFEFF{}\n'),
    Buffer.from([0x22, 0xff, 0x22, 10]),
  ]) {
    const path = await fixture(t, data);
    await assert.rejects(readJsonl(path), readerError('JSONL_MALFORMED', 0));
  }
});

test('coda malformata senza LF resta sospesa fino alla terminazione della riga', async (t) => {
  const path = await fixture(t, '{}\ninvalid');
  const { cursor, records } = await readJsonl(path);
  assert.equal(records.length, 1);
  assert.equal(cursor.offset, 3);
  await appendFile(path, '\n');
  await assert.rejects(
    readJsonl(path, cursor),
    readerError('JSONL_MALFORMED', 3),
  );
});

test('cursori invalidi e file mancanti sono errori espliciti', async (t) => {
  const path = await fixture(t, '{}\n');
  const { cursor } = await readJsonl(path);
  for (const changed of [
    { offset: -1 },
    { offset: 1.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { prefixHash: 'bad' },
  ]) {
    await assert.rejects(
      readJsonl(path, { ...cursor, ...changed }),
      readerError('CURSOR_INVALID'),
    );
  }
  await assert.rejects(readJsonl(path + '.missing'), { code: 'ENOENT' });
});

test('il cursore non può essere riutilizzato su un altro file identico', async (t) => {
  const path = await fixture(t, '{}\n');
  const other = await fixture(t, '{}\n');
  const { cursor } = await readJsonl(path);
  await assert.rejects(readJsonl(other, cursor), readerError('FILE_CHANGED'));
});

test('prefissi oltre 64 KiB restano verificabili dopo append e una modifica lontana dal cursore è rilevata', async (t) => {
  const source = JSON.stringify({ text: 'a'.repeat(70000) }) + '\n';
  const path = await fixture(t, source);
  const first = await readJsonl(path);
  assert.equal(first.records[0].raw, source.slice(0, -1));
  await appendFile(path, '{"next":true}\n');
  const second = await readJsonl(path, first.cursor);
  assert.deepEqual(
    second.records.map((r) => r.value),
    [{ next: true }],
  );
  assert.deepEqual((await readJsonl(path, second.cursor)).records, []);
  await writeFile(path, source.replace('aaa', 'baa') + '{"next":true}\n');
  await assert.rejects(
    readJsonl(path, second.cursor),
    readerError('FILE_CHANGED'),
  );
});
