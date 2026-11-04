import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { CaptureError, syncSession } from '../src/capture.ts';

async function fixture(t: TestContext, contents = '{"id":1}\n') {
  const directory = await mkdtemp(join(tmpdir(), 'knownex-capture-'));
  t.after(async () => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const source = join(directory, 'source.jsonl');
  const destination = join(directory, 'capture.jsonl');
  await writeFile(source, contents);
  return { source, destination };
}

// Test oracle reconstructs the source without invoking the reader or capture code.
function restored(bytes: Buffer): Buffer {
  const lines = bytes.toString('utf8').split('\n');
  assert.equal(lines.pop(), '');
  const raw: string[] = [];
  for (const line of lines) {
    const frame = JSON.parse(line);
    assert.equal(
      frame.checksum,
      createHash('sha256').update(JSON.stringify(frame.block)).digest('hex'),
    );
    raw.push(...frame.block.records);
  }
  return Buffer.from(raw.map((line) => line + '\n').join(''));
}

function captureError(code: CaptureError['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof CaptureError);
    assert.equal(error.code, code);
    return true;
  };
}

test('prima sync conserva byte originali, ordine, sorgente e cursore senza modificare il JSONL', async (t) => {
  const text = ' {"n":9007199254740993,"text":"è 🧠"} \r\nnull\n[1,2]\n';
  const { source, destination } = await fixture(t, text);
  const before = await stat(source, { bigint: true });
  const result = await syncSession(source, destination);
  const bytes = await readFile(destination);
  assert.deepEqual(restored(bytes), Buffer.from(text));
  assert.equal(result.appended, 3);
  assert.equal(result.recoveredBytes, 0);
  assert.equal(result.cursor.offset, Buffer.byteLength(text));
  const frame = JSON.parse(bytes.toString('utf8'));
  assert.equal(frame.block.source, await realpath(source));
  assert.equal(frame.block.from, 0);
  assert.equal(frame.block.previous, null);
  assert.deepEqual(frame.block.cursor, result.cursor);
  assert.deepEqual(await readFile(source), Buffer.from(text));
  assert.equal((await stat(source, { bigint: true })).mtimeNs, before.mtimeNs);
});

test('sync ripetute non duplicano e append successive preservano esattamente i byte confermati', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  const prefix = await readFile(destination);
  assert.equal((await syncSession(source, destination)).appended, 0);
  assert.deepEqual(await readFile(destination), prefix);
  await appendFile(source, '{"id":2}\n{"id":3}\n');
  const next = await syncSession(source, destination);
  assert.equal(next.appended, 2);
  const bytes = await readFile(destination);
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
  assert.deepEqual(restored(bytes), await readFile(source));
  assert.equal((await syncSession(source, destination)).appended, 0);
  assert.deepEqual(await readFile(destination), bytes);
});

test('il cursore persistito viene recuperato da un nuovo processo Node', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  await appendFile(source, '{"id":2}\n');
  const moduleUrl = pathToFileURL(resolve('src/capture.ts')).href;
  const script = `import { syncSession } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await syncSession(process.argv[1], process.argv[2])));`;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script, source, destination],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(result.appended, 1);
  assert.deepEqual(
    restored(await readFile(destination)),
    await readFile(source),
  );
  assert.equal((await syncSession(source, destination)).appended, 0);
});

test('record sorgente incompleti vengono confermati solo dopo LF, anche con UTF-8 spezzato', async (t) => {
  const { source, destination } = await fixture(t);
  const next = Buffer.from('{"text":"🧠"}\n');
  const split = next.indexOf(Buffer.from('🧠')) + 2;
  await appendFile(source, next.subarray(0, split));
  assert.equal((await syncSession(source, destination)).appended, 1);
  assert.deepEqual(
    restored(await readFile(destination)),
    Buffer.from('{"id":1}\n'),
  );
  await appendFile(source, next.subarray(split));
  assert.equal((await syncSession(source, destination)).appended, 1);
  assert.deepEqual(
    restored(await readFile(destination)),
    await readFile(source),
  );
});

test('interruzione simulata a OGNI byte del blocco finale recupera senza perdite né duplicati', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  const prefix = await readFile(destination);
  await appendFile(source, '{"id":2,"text":"è 🧠"}\n');
  await syncSession(source, destination);
  const complete = await readFile(destination);
  const lastFrame = complete.subarray(prefix.length);
  const expected = await readFile(source);
  for (let cut = 0; cut <= lastFrame.length; cut++) {
    await writeFile(
      destination,
      Buffer.concat([prefix, lastFrame.subarray(0, cut)]),
    );
    const result = await syncSession(source, destination);
    assert.equal(
      result.appended,
      cut === lastFrame.length ? 0 : 1,
      `cut ${cut}`,
    );
    assert.equal(
      result.recoveredBytes,
      cut === lastFrame.length ? 0 : cut,
      `cut ${cut}`,
    );
    const recovered = await readFile(destination);
    assert.deepEqual(
      recovered.subarray(0, prefix.length),
      prefix,
      `cut ${cut}`,
    );
    assert.deepEqual(restored(recovered), expected, `cut ${cut}`);
  }
  assert.equal((await syncSession(source, destination)).appended, 0);
});

test('primo blocco interrotto e coda abbandonata senza nuovi eventi sono recuperabili', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  const complete = await readFile(destination);
  await writeFile(destination, complete.subarray(0, complete.length - 1));
  const first = await syncSession(source, destination);
  assert.equal(first.appended, 1);
  assert.equal(first.recoveredBytes, complete.length - 1);
  const committed = await readFile(destination);
  await appendFile(destination, '{"block":');
  const tail = await syncSession(source, destination);
  assert.equal(tail.appended, 0);
  assert.equal(tail.recoveredBytes, Buffer.byteLength('{"block":'));
  assert.deepEqual(await readFile(destination), committed);
});

test('registro vuoto e sorgente vuota mantengono un checkpoint di identità', async (t) => {
  const { source, destination } = await fixture(t, '');
  assert.equal((await syncSession(source, destination)).appended, 0);
  const bytes = await readFile(destination);
  assert.deepEqual(restored(bytes), Buffer.alloc(0));
  assert.equal(JSON.parse(bytes.toString('utf8')).block.cursor.offset, 0);
  await syncSession(source, destination);
  assert.deepEqual(await readFile(destination), bytes);
  await appendFile(source, 'true\n');
  assert.equal((await syncSession(source, destination)).appended, 1);
  assert.deepEqual(
    restored(await readFile(destination)),
    Buffer.from('true\n'),
  );
});

test('corruzioni complete, checksum errati e UTF-8 invalido sono errori senza modifiche al registro', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  const valid = await readFile(destination);
  const damaged = Buffer.from(valid);
  damaged[damaged.indexOf(Buffer.from('id'))] = 'x'.charCodeAt(0);
  for (const bytes of [
    damaged,
    Buffer.from('not json\n'),
    Buffer.from([0xff, 10]),
    Buffer.concat([valid, Buffer.from('{}\n')]),
  ]) {
    await writeFile(destination, bytes);
    await assert.rejects(
      syncSession(source, destination),
      captureError('LOG_CORRUPT'),
    );
    assert.deepEqual(await readFile(destination), bytes);
  }
});

test('cursore incoerente e riordino dei blocchi sono rilevati anche con checksum ricalcolato', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  await appendFile(source, '{"id":2}\n');
  await syncSession(source, destination);
  const lines = (await readFile(destination, 'utf8')).trimEnd().split('\n');
  const frame = JSON.parse(lines[1]);
  frame.block.cursor.offset++;
  frame.checksum = createHash('sha256')
    .update(JSON.stringify(frame.block))
    .digest('hex');
  for (const text of [
    lines[0] + '\n' + JSON.stringify(frame) + '\n',
    lines.reverse().join('\n') + '\n',
  ]) {
    await writeFile(destination, text);
    await assert.rejects(
      syncSession(source, destination),
      captureError('LOG_CORRUPT'),
    );
    assert.equal(await readFile(destination, 'utf8'), text);
  }
});

test('alterazioni e sostituzioni della sorgente non modificano il backup, neppure la coda incompleta', async (t) => {
  for (const change of ['truncate', 'rewrite', 'replace']) {
    const { source, destination } = await fixture(t);
    await syncSession(source, destination);
    await appendFile(destination, '{"incomplete":');
    const before = await readFile(destination);
    if (change === 'truncate') await truncate(source, 0);
    if (change === 'rewrite') await writeFile(source, '{"id":9}\n');
    if (change === 'replace') {
      await rename(source, source + '.old');
      await writeFile(source, '{"id":1}\n');
    }
    await assert.rejects(syncSession(source, destination), {
      code: 'FILE_CHANGED',
    });
    assert.deepEqual(await readFile(destination), before);
  }
});

test('sorgente diversa e destinazione coincidente o hard link sono rifiutate', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  const before = await readFile(destination);
  const other = source + '.other';
  await writeFile(other, '{"id":1}\n');
  await assert.rejects(
    syncSession(other, destination),
    captureError('SOURCE_MISMATCH'),
  );
  assert.deepEqual(await readFile(destination), before);
  await assert.rejects(
    syncSession(source, source),
    captureError('DESTINATION_IS_SOURCE'),
  );
  const alias = source + '.alias';
  await link(source, alias);
  await assert.rejects(
    syncSession(source, alias),
    captureError('DESTINATION_IS_SOURCE'),
  );
  assert.equal(await readFile(source, 'utf8'), '{"id":1}\n');
});

test('la copia originale è recuperabile dal solo registro dopo rimozione della sorgente', async (t) => {
  const text = '{"nested":{"value":"è 🧠"}}\nfalse\n';
  const { source, destination } = await fixture(t, text);
  await syncSession(source, destination);
  await rm(source);
  assert.deepEqual(restored(await readFile(destination)), Buffer.from(text));
  const before = await readFile(destination);
  await assert.rejects(syncSession(source, destination), { code: 'ENOENT' });
  assert.deepEqual(await readFile(destination), before);
});

test('checksum ricalcolati non nascondono contenuti o collegamenti incoerenti', async (t) => {
  const { source, destination } = await fixture(t);
  await syncSession(source, destination);
  await appendFile(source, '{"id":2}\n');
  await syncSession(source, destination);
  const [first, second] = (await readFile(destination, 'utf8'))
    .trimEnd()
    .split('\n');
  const mutations = [
    { records: ['{"id":9}'] },
    { records: ['not-json'] },
    { previous: '0'.repeat(64) },
    { from: 0 },
    { version: 2 },
  ];
  for (const mutation of mutations) {
    const frame = JSON.parse(second);
    Object.assign(frame.block, mutation);
    frame.checksum = createHash('sha256')
      .update(JSON.stringify(frame.block))
      .digest('hex');
    const bytes = Buffer.from(first + '\n' + JSON.stringify(frame) + '\n');
    await writeFile(destination, bytes);
    await assert.rejects(
      syncSession(source, destination),
      captureError('LOG_CORRUPT'),
    );
    assert.deepEqual(await readFile(destination), bytes);
  }
});

test('sync concorrenti nello stesso processo non duplicano il blocco né perdono il lock attivo', async (t) => {
  const { source, destination } = await fixture(t);
  const results = await Promise.allSettled([
    syncSession(source, destination),
    syncSession(source, destination),
    syncSession(source, destination),
  ]);
  let appended = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') appended += result.value.appended;
    else
      assert.ok(
        result.reason instanceof CaptureError &&
          result.reason.code === 'DESTINATION_BUSY',
      );
  }
  assert.equal(appended, 1);
  assert.deepEqual(
    restored(await readFile(destination)),
    await readFile(source),
  );
  assert.equal((await syncSession(source, destination)).appended, 0);
});
