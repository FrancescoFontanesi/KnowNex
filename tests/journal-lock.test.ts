import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { acquireJournalLock } from '../src/journal-lock.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-lock-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, lock: join(root, 'capture.jsonl.lock') };
}

test('un lock pubblicato contiene sempre il proprietario completo e blocca altri scrittori', async (t) => {
  const { root, lock } = await fixture(t);
  const release = await acquireJournalLock(lock);
  try {
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
    await assert.rejects(acquireJournalLock(lock), {
      code: 'DESTINATION_BUSY',
    });
    assert.deepEqual(await readdir(root), ['capture.jsonl.lock']);
  } finally {
    await release();
  }
  assert.deepEqual(await readdir(root), []);
});

test('la CLI in un altro processo rispetta il lock e non modifica il registro occupato', async (t) => {
  const { root, lock } = await fixture(t);
  const source = join(root, 'source.jsonl'),
    destination = join(root, 'capture.jsonl');
  await writeFile(source, '{"id":1}\n');
  await writeFile(destination, '');
  const release = await acquireJournalLock(lock);
  const args = [
    resolve('src/index.ts'),
    'sync',
    '--source',
    source,
    '--destination',
    destination,
  ];
  try {
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'DESTINATION_BUSY');
    assert.equal(await readFile(destination, 'utf8'), '');
  } finally {
    await release();
  }
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).appended, 1);
});

test(
  'lock lasciato da un processo interrotto viene recuperato; una recovery occupata resta conservativa',
  { timeout: 10000 },
  async (t) => {
    const { root, lock } = await fixture(t);
    const moduleUrl = pathToFileURL(resolve('src/journal-lock.ts')).href;
    const script = `import {acquireJournalLock} from ${JSON.stringify(moduleUrl)}; await acquireJournalLock(${JSON.stringify(lock)}); console.log('ready'); setInterval(()=>{},1000);`;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      { windowsHide: true },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    const closed = once(child, 'close');
    await once(child.stdout, 'data');
    const previous = JSON.parse(await readFile(lock, 'utf8'));
    assert.equal(previous.pid, child.pid);
    child.kill();
    await closed;
    const gate = `${lock}.reap-${previous.token}`;
    await writeFile(gate, 'synthetic interrupted recovery', { flag: 'wx' });
    await assert.rejects(acquireJournalLock(lock), {
      code: 'DESTINATION_BUSY',
    });
    assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), previous);
    await unlink(gate);
    const release = await acquireJournalLock(lock);
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
    await release();
    assert.deepEqual(await readdir(root), []);
  },
);

test('lock malformati o modificati non vengono eliminati silenziosamente', async (t) => {
  const { root, lock } = await fixture(t);
  await writeFile(lock, '{broken');
  await assert.rejects(acquireJournalLock(lock), { code: 'LOCK_CORRUPT' });
  assert.equal(await readFile(lock, 'utf8'), '{broken');
  await unlink(lock);
  const release = await acquireJournalLock(lock);
  const changed = {
    pid: process.pid,
    token: '00000000-0000-0000-0000-000000000000',
  };
  await writeFile(lock, JSON.stringify(changed));
  await assert.rejects(release(), { code: 'LOCK_CHANGED' });
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), changed);
  assert.deepEqual(await readdir(root), ['capture.jsonl.lock']);
});
