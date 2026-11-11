import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import {
  emptyMemory,
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  curatorStatus,
  abandonCurator,
} from '../src/curator.ts';
import { preparedCheckpoint } from '../src/native-checkpoint.ts';
import { readCurationInput } from '../src/curation-io.ts';
import { sha256 } from '../src/artifact-io.ts';

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'knownex-portable-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory'),
    feed = join(root, '.knownex/internal/feed'),
    work = join(root, '.knownex/internal/curator');
  await mkdir(memory, { recursive: true });
  await mkdir(feed, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  await writeFile(join(feed, 'project.jsonl'), '');
  await initCurator(work, memory, join(feed, 'project.jsonl'), 0);
  let n = 0;
  const append = (text: string) =>
    appendFeedEvent(
      feed,
      {
        type: 'user_message',
        sessionId: 'portable-source',
        turnId: String(++n),
        text,
        hook: 'source-acquisition',
      },
      true,
    );
  return {
    root,
    memory,
    feed,
    work,
    append,
    prepare: () => prepareCurator(work),
  };
}
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
async function applyNoop(work: string, run: string) {
  await writeFile(join(run, 'proposal.json'), '{"action":"noop"}\n');
  const v = await validateCurator(work);
  return applyCurator(work, v.seal);
}

test('an explicit prepare freezes provider-neutral input without a command or assistant final', async (t) => {
  const f = await fixture(t);
  await f.append('First decision.');
  await f.append('Later correction before prepare.');
  const p = await f.prepare();
  assert.equal(p.status, 'prepared');
  assert.equal(p.through, 2);
  assert.equal((await json(join(p.run!, 'packet.json'))).events.length, 2);
  const manifest = await json(join(p.run!, 'inputs.json'));
  assert.equal(manifest.through, 2);
  for (const [name, expected] of Object.entries(manifest.files) as [
    string,
    { bytes: number; sha256: string },
  ][]) {
    const bytes = await readFile(join(p.run!, name));
    assert.equal(bytes.length, expected.bytes);
    assert.equal(sha256(bytes), expected.sha256);
  }
  assert.equal((await json(join(p.run!, 'run.json'))).authorization, undefined);
});

test('events appended while staging and during curation never enter the frozen inputs', async (t) => {
  const f = await fixture(t);
  await f.append('Frozen fact.');
  const original = fs.promises.readFile;
  let injected = false;
  const mock = t.mock.method(
    fs.promises,
    'readFile',
    async (...args: Parameters<typeof original>) => {
      if (!injected && String(args[0]).includes('knownex-curator/SKILL.md')) {
        injected = true;
        await f.append('Arrived while prepare was staging.');
      }
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  let p;
  try {
    p = await f.prepare();
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(p.through, 1);
  const packet = await readFile(join(p.run!, 'packet.json'));
  const manifest = await readFile(join(p.run!, 'inputs.json'));
  await f.append('Arrived during curation.');
  const again = await f.prepare();
  assert.equal(again.run, p.run);
  assert.equal(again.through, 1);
  assert.deepEqual(await readFile(join(p.run!, 'packet.json')), packet);
  assert.deepEqual(await readFile(join(p.run!, 'inputs.json')), manifest);
  assert.deepEqual(
    JSON.parse(packet.toString()).events.map(
      (e: { sequence: number }) => e.sequence,
    ),
    [1],
  );
  const record = await json(join(p.run!, 'run.json'));
  await assert.rejects(
    readCurationInput(p.run!, JSON.parse(packet.toString()).feed),
    { code: 'CURATOR_IO_INPUT_NOT_AUTHORIZED' },
  );
  assert.equal(record.last.event.sequence, 1);
  await applyNoop(f.work, p.run!);
  const status = await curatorStatus(f.work, join(f.feed, 'project.jsonl'));
  assert.equal(status.through, 1);
  assert.equal(status.pending, 2);
  const next = await f.prepare();
  assert.equal(next.from, 2);
  assert.equal(next.through, 3);
  assert.ok(!(await readdir(p.run!)).some((n) => n.endsWith('.jsonl')));
});

test('native prepare without an authorization argument is idempotent and returns a portable assignment', async (t) => {
  const f = await fixture(t);
  await f.append('A fact.');
  const p = await preparedCheckpoint(f.work, { stage: 'prepare' });
  assert.equal(p.status, 'READY', JSON.stringify(p));
  if (p.status !== 'READY') return;
  await f.append('Later fact.');
  const repeated = await preparedCheckpoint(f.work, { stage: 'prepare' });
  assert.equal(repeated.status, 'READY');
  if (repeated.status === 'READY') {
    assert.equal(repeated.runId, p.runId);
    assert.equal(repeated.through, 1);
  }
  const request = JSON.parse(
    (await readFile(p.requestFile, 'utf8')).split(
      'INPUT_REFERENCES_JSON\n',
    )[1]!,
  );
  assert.equal(request.packet.path, join(p.run, 'packet.json'));
  assert.equal(request.manifest.path, join(p.run, 'inputs.json'));
});

test('a frozen prefix edit blocks publication even if a suffix was appended', async (t) => {
  const f = await fixture(t);
  await f.append('Frozen.');
  const p = await f.prepare();
  await f.append('New.');
  const file = join(f.feed, 'project.jsonl'),
    rows = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  rows[0].block.event.text = 'Tampered';
  let previous = null;
  for (const r of rows) {
    r.block.previous = previous;
    r.checksum = sha256(JSON.stringify(r.block));
    previous = r.checksum;
  }
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await assert.rejects(applyNoop(f.work, p.run!), {
    code: 'CURATOR_STALE_BATCH',
  });
  assert.equal((await json(join(f.work, 'checkpoint.json'))).sequence, 0);
});

test('changing run metadata cannot extend the frozen cutoff to a later valid event', async (t) => {
  const f = await fixture(t);
  await f.append('Frozen.');
  const p = await f.prepare();
  await f.append('Must remain pending.');
  const bytes = await readFile(join(f.feed, 'project.jsonl'));
  const from = bytes.indexOf(10) + 1;
  const frame = JSON.parse(bytes.subarray(from).toString('utf8'));
  const record = await json(join(p.run!, 'run.json'));
  record.last = {
    event: frame.block.event,
    checksum: frame.checksum,
    from,
    end: bytes.length,
  };
  await writeFile(join(p.run!, 'run.json'), JSON.stringify(record));
  await assert.rejects(readCurationInput(p.run!, 'inputs.json'), {
    code: 'CURATOR_INPUTS_CHANGED',
  });
  await assert.rejects(applyNoop(f.work, p.run!), {
    code: 'CURATOR_INPUTS_CHANGED',
  });
  assert.equal((await json(join(f.work, 'checkpoint.json'))).sequence, 0);
});

test('all portable input snapshots are checked even without autonomous review', async (t) => {
  for (const name of ['packet.json', 'inputs.json', 'base/STATE.md']) {
    const f = await fixture(t);
    await f.append('Fact.');
    const p = await f.prepare();
    await writeFile(join(p.run!, name), 'changed');
    await assert.rejects(applyNoop(f.work, p.run!), {
      code: 'CURATOR_INPUTS_CHANGED',
    });
  }
  const f = await fixture(t);
  await f.append('Fact.');
  const p = await f.prepare();
  const record = await json(join(p.run!, 'run.json'));
  delete record.inputManifestSha256;
  await writeFile(join(p.run!, 'run.json'), JSON.stringify(record));
  await assert.rejects(readCurationInput(p.run!, 'packet.json'), {
    code: 'CURATOR_INPUTS_CHANGED',
  });
});

test('empty prepare is a no-op and failed preparation does not consume a feed permission', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.prepare()).status, 'noop');
  await f.append('Pending.');
  const bytes = await readFile(join(f.feed, 'project.jsonl'));
  await assert.rejects(prepareCurator(f.work, join(f.root, 'missing.md')), {
    code: 'ENOENT',
  });
  const p = await f.prepare();
  assert.ok(p.run);
  await abandonCurator(f.work, p.run!.split(/[\\/]/).at(-1)!);
  assert.notEqual((await f.prepare()).run, p.run);
  assert.deepEqual(await readFile(join(f.feed, 'project.jsonl')), bytes);
});

test('concurrent prepare requests cannot publish two active batches', async (t) => {
  const f = await fixture(t);
  await f.append('Pending.');
  const results = await Promise.allSettled([f.prepare(), f.prepare()]);
  const runs = results.flatMap((r) =>
    r.status === 'fulfilled' && r.value.run ? [r.value.run] : [],
  );
  assert.ok(runs.length > 0);
  assert.equal(new Set(runs).size, 1);
  assert.equal((await f.prepare()).run, runs[0]);
});

test('removing the feed binding cannot authorize publication or re-preparation', async (t) => {
  const f = await fixture(t);
  await f.append('Pending.');
  const p = await f.prepare();
  await writeFile(join(p.run!, 'proposal.json'), '{"action":"noop"}');
  const v = await validateCurator(f.work);
  await rm(join(f.feed, 'project.jsonl.curator.json'));
  await assert.rejects(applyCurator(f.work, v.seal), {
    code: 'CURATOR_WORKSPACE_CONFLICT',
  });
  await assert.rejects(f.prepare(), { code: 'CURATOR_WORKSPACE_CONFLICT' });
  assert.equal((await json(join(f.work, 'checkpoint.json'))).sequence, 0);
});

test('checkpoint administration is recognized without a Codex hook while mixed content stays material', async (t) => {
  const f = await fixture(t);
  await f.append('Project fact.');
  await f.append('$knownex-checkpoint');
  await f.append('$knownex-checkpoint Keep this project decision.');
  const p = await f.prepare();
  const packet = await json(join(p.run!, 'packet.json'));
  assert.equal(p.through, 3);
  assert.deepEqual(
    packet.events.map((e: { sequence: number }) => e.sequence),
    [1, 3],
  );
  assert.deepEqual((await json(join(p.run!, 'run.json'))).excluded, [2]);
  await applyNoop(f.work, p.run!);
  assert.equal((await json(join(f.work, 'checkpoint.json'))).sequence, 3);
});

test('an explicit cutoff including trailing administration leaves subsequent empty prepare as a no-op', async (t) => {
  const f = await fixture(t);
  await f.append('Fact.');
  await f.append('$knownex-checkpoint');
  const p = await prepareCurator(f.work, undefined, { through: 2 });
  await applyNoop(f.work, p.run!);
  assert.equal((await f.prepare()).status, 'noop');
  assert.equal(
    (await curatorStatus(f.work, join(f.feed, 'project.jsonl'))).readyThrough,
    2,
  );
});
