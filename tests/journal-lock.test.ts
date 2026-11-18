import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

test('a published lock always holds the full owner and blocks other writers', async (t) => {
  const { root, lock } = await fixture(t);
  const release = await acquireJournalLock(lock);
  try {
    const published = JSON.parse(await readFile(lock, 'utf8'));
    assert.equal(published.pid, process.pid);
    assert.equal(
      new Date(published.acquiredAt).toISOString(),
      published.acquiredAt,
    );
    await assert.rejects(acquireJournalLock(lock), {
      code: 'DESTINATION_BUSY',
    });
    assert.deepEqual(await readdir(root), ['capture.jsonl.lock']);
  } finally {
    await release();
  }
  assert.deepEqual(await readdir(root), []);
});

test(
  'a lock left by an interrupted process is recovered; a busy recovery stays conservative',
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

test('malformed or modified locks are not deleted silently', async (t) => {
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
