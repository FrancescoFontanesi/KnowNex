import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFile,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function invoke(args: string[], cwd?: string) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    cwd,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'knownex cli '));
  t.after(async () => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const source = join(directory, 'session è.jsonl');
  const destination = join(directory, 'capture log.jsonl');
  await writeFile(source, '{"id":1,"private":"CONTENUTO_RISERVATO"}\nnull\n');
  return { directory, source, destination };
}

const syncArgs = (source: string, destination: string) => [
  'sync',
  '--source',
  source,
  '--destination',
  destination,
];

function success(
  result: ReturnType<typeof invoke>,
  appended: number,
  recoveredBytes = 0,
) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'ok',
    appended,
    recoveredBytes,
  });
}

function failure(
  result: ReturnType<typeof invoke>,
  exit: number,
  code: string,
) {
  assert.equal(result.status, exit);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.status, 'error');
  assert.equal(output.code, code);
  assert.ok(!result.stderr.includes('CONTENUTO_RISERVATO'));
  assert.ok(!result.stderr.includes('Error:'));
}

test('CLI mostra la sintassi senza effetti collaterali, anche tramite --help', () => {
  for (const args of [[], ['--help'], ['-h'], ['sync', '--help']]) {
    const result = invoke(args);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.ok(
      result.stdout.startsWith(
        'Usage: knownex sync --source <jsonl> --destination <file>',
      ),
    );
    assert.equal(
      result.stdout.includes('knownex memory state'),
      args[0] !== 'sync',
    );
  }
});

test('CLI sincronizza incrementi e recovery in processi separati usando percorsi relativi con spazi', async (t) => {
  const { directory, source, destination } = await fixture(t);
  const args = syncArgs('session è.jsonl', 'capture log.jsonl');
  const original = await readFile(source);
  const before = await stat(source, { bigint: true });
  success(invoke(args, directory), 2);
  const prefix = await readFile(destination);
  success(invoke(args, directory), 0);
  assert.deepEqual(await readFile(destination), prefix);
  assert.deepEqual(await readFile(source), original);
  assert.equal((await stat(source, { bigint: true })).mtimeNs, before.mtimeNs);

  await appendFile(source, '{"id":2}\n{"id":3');
  success(invoke(args, directory), 1);
  const committed = await readFile(destination);
  assert.deepEqual(committed.subarray(0, prefix.length), prefix);
  await appendFile(destination, '{"partial":');
  await appendFile(source, '}\n');
  success(invoke(args, directory), 1, Buffer.byteLength('{"partial":'));
  success(invoke(args, directory), 0);
  const journal = await readFile(destination, 'utf8');
  const raw = journal
    .trimEnd()
    .split('\n')
    .flatMap((line) => JSON.parse(line).block.records);
  assert.deepEqual(
    Buffer.from(raw.map((line: string) => line + '\n').join('')),
    await readFile(source),
  );
});

test('CLI rifiuta comando, opzioni, duplicati e valori mancanti con exit 2', () => {
  const invalid = [
    ['unknown'],
    ['watch'],
    ['watch', '--help'],
    ['sync'],
    ['sync', '--source'],
    ['sync', '--source', 'a'],
    ['sync', '--source', '', '--destination', 'b'],
    ['sync', '--source', 'a', '--destination', '  '],
    ['sync', '--source', 'a', '--destination', 'b', '--unknown'],
    ['sync', '--source', 'a', '--source', 'b', '--destination', 'c'],
    ['sync', '--source', 'a', '--destination', 'b', 'extra'],
    ['--help', 'extra'],
  ];
  for (const args of invalid) failure(invoke(args), 2, 'INVALID_ARGUMENTS');
});

test('CLI valida file sorgente, destinazione e directory padre', async (t) => {
  const { directory, source, destination } = await fixture(t);
  failure(invoke(syncArgs(source + '.missing', destination)), 1, 'ENOENT');
  failure(invoke(syncArgs(directory, destination)), 1, 'SOURCE_NOT_FILE');
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
  failure(invoke(syncArgs(source, directory)), 1, 'DESTINATION_NOT_FILE');
  failure(
    invoke(syncArgs(source, join(directory, 'missing', 'log.jsonl'))),
    1,
    'ENOENT',
  );
});

test('CLI rifiuta sorgente e destinazione coincidenti, anche tramite hard link', async (t) => {
  const { source, destination } = await fixture(t);
  const before = await readFile(source);
  failure(invoke(syncArgs(source, source)), 1, 'DESTINATION_IS_SOURCE');
  await link(source, destination);
  failure(invoke(syncArgs(source, destination)), 1, 'DESTINATION_IS_SOURCE');
  assert.deepEqual(await readFile(source), before);
});

test('CLI propaga JSON malformato, alterazioni e corruzioni senza divulgare il contenuto', async (t) => {
  const { source, destination } = await fixture(t);
  await writeFile(source, '{"private":"CONTENUTO_RISERVATO",}\n');
  failure(invoke(syncArgs(source, destination)), 1, 'JSONL_MALFORMED');
  await writeFile(source, '{"id":1}\n');
  success(invoke(syncArgs(source, destination)), 1);
  const committed = await readFile(destination);
  await writeFile(source, '{"id":9}\n');
  failure(invoke(syncArgs(source, destination)), 1, 'FILE_CHANGED');
  assert.deepEqual(await readFile(destination), committed);
  await writeFile(source, '{"id":1}\n');
  await appendFile(destination, 'CONTENUTO_RISERVATO\n');
  const damaged = await readFile(destination);
  failure(invoke(syncArgs(source, destination)), 1, 'LOG_CORRUPT');
  assert.deepEqual(await readFile(destination), damaged);
});

test('CLI rifiuta watch con argomenti validi senza creare un registro', async (t) => {
  const { source, destination } = await fixture(t);
  const result = spawnSync(
    process.execPath,
    [entry, 'watch', '--source', source, '--destination', destination],
    {
      encoding: 'utf8',
      timeout: 2000,
    },
  );
  assert.ifError(result.error);
  failure(result, 2, 'INVALID_ARGUMENTS');
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
});
