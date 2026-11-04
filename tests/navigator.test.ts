import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { memoryState, memoryFind, memoryRead } from '../src/navigator.ts';
import { historyAppendix } from '../src/history.ts';

const note = (n: number, title: string, body: string) =>
  `---\nid: kn-00000000-0000-4000-8000-${String(n).padStart(12, '0')}\ntype: knowledge\n---\n\n# ${title}\n\n${body}\n`;
const entry = resolve('src/index.ts');
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex navigator '));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const memory = join(root, 'memory');
  await mkdir(join(memory, 'knowledge'), { recursive: true });
  const state =
    '# Current state\n\nCurrent objective only. \u00e8 \ud83e\udde0\n';
  await writeFile(join(memory, 'STATE.md'), state);
  let history = '# History\n';
  const segments: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const archived = `# Old state ${i}\n\nShared body. ${i === 1 ? 'ancestral-decision' : ''}\n`;
    const suffix = historyAppendix(
      history,
      archived,
      i,
      i,
      '2026-11-03T12:00:00.000Z',
      '../feed.jsonl',
      {
        summary:
          i === 2 ? 'targetdecision explained' : 'Shared history outcome',
        topics: [i === 2 ? 'targetdecision' : 'Shared topic'],
        transition: 'Confirmed transition',
      },
    );
    history += suffix;
    segments.push(suffix.slice(suffix.indexOf('<!--')));
  }
  await writeFile(join(memory, 'HISTORY.md'), history);
  await writeFile(
    join(memory, 'knowledge/a.md'),
    note(
      1,
      'Targetdecision and Shared',
      'Unique technicalvalue. [External](../../absent.txt)',
    ),
  );
  await writeFile(
    join(memory, 'knowledge/b.md'),
    note(
      2,
      'Body matches',
      'targetdecision shared '.repeat(100) +
        '\n## Headingdetail\nA separate detail.',
    ),
  );
  return { root, memory, state, history, segments };
}
function invoke(memory: string, args: string[], cwd?: string) {
  const r = spawnSync(
    process.execPath,
    [entry, 'memory', ...args, '--memory', memory],
    { cwd, encoding: 'utf8' },
  );
  assert.ifError(r.error);
  assert.equal(r.signal, null);
  return r;
}

test('state reads only STATE even with absent history and invalid Knowledge', async (t) => {
  const f = await fixture(t);
  await rm(join(f.memory, 'HISTORY.md'));
  await writeFile(join(f.memory, 'knowledge/a.md'), 'invalid metadata');
  assert.equal(await memoryState(f.memory), f.state);
  const r = invoke(f.memory, ['state']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { status: 'ok', content: f.state });
});

test('find is capped, deterministic and ranks title/metadata above body frequency with type filters', async (t) => {
  const f = await fixture(t);
  const matches = await memoryFind(f.memory, 'TARGETDÉCISION');
  assert.equal(matches[0]!.id, 'H000002');
  assert.equal(matches[1]!.id, 'kn-00000000-0000-4000-8000-000000000001');
  assert.equal(matches.at(-1)!.id, 'kn-00000000-0000-4000-8000-000000000002');
  const shared = await memoryFind(f.memory, 'shared');
  assert.equal(shared.length, 5);
  assert.deepEqual(await memoryFind(f.memory, 'shared'), shared);
  assert.ok(
    (await memoryFind(f.memory, 'shared', 'history')).every(
      (r) => r.type === 'history',
    ),
  );
  assert.ok(
    (await memoryFind(f.memory, 'shared', 'knowledge')).every(
      (r) => r.type === 'knowledge',
    ),
  );
  assert.equal((await memoryFind(f.memory, 'shared', 'knowledge')).length, 2);
  const historyMatch = await memoryFind(f.memory, 'targetdecision', 'history');
  assert.deepEqual(historyMatch[0]!.events, { from: 2, through: 2 });
  assert.equal(historyMatch[0]!.date, '2026-11-03T12:00:00.000Z');
  assert.equal(historyMatch[0]!.reference, 'HISTORY.md#h000002');
  assert.ok(
    shared.every(
      (r) => [...r.excerpt].length <= 240 && [...r.title].length <= 160,
    ),
  );
  assert.deepEqual(
    await memoryFind(f.memory, 'technicalvalue headingdetail'),
    [],
  ); // AND, not an implicit semantic search.
});

test('read resolves stable IDs, returns exact single content and never follows Markdown links', async (t) => {
  const f = await fixture(t);
  const historic = await memoryRead(f.memory, 'H000001');
  assert.equal(historic.content, f.segments[0]);
  assert.ok(!historic.content.includes('H000002'));
  const knowledge = await memoryRead(
    f.memory,
    'kn-00000000-0000-4000-8000-000000000001',
  );
  assert.equal(
    knowledge.content,
    await readFile(join(f.memory, 'knowledge/a.md'), 'utf8'),
  );
  assert.ok(knowledge.content.includes('../../absent.txt'));
  await rm(join(f.memory, 'HISTORY.md'));
  assert.equal(
    (await memoryRead(f.memory, knowledge.id)).content,
    knowledge.content,
  );
});

test('ambiguous identities and broken History fail explicitly rather than returning an arbitrary document', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.memory, 'knowledge/duplicate.md'),
    note(1, 'Duplicate', 'PRIVATE_AMBIGUOUS_BODY'),
  );
  await assert.rejects(
    memoryRead(f.memory, 'kn-00000000-0000-4000-8000-000000000001'),
    { code: 'MEMORY_AMBIGUOUS_ID' },
  );
  await assert.rejects(memoryFind(f.memory, 'shared', 'knowledge'), {
    code: 'MEMORY_AMBIGUOUS_ID',
  });
  assert.equal((await memoryFind(f.memory, 'shared', 'history')).length, 5); // Filter does not load the other collection.
  await writeFile(join(f.memory, 'HISTORY.md'), f.history + f.segments[0]);
  await assert.rejects(memoryRead(f.memory, 'H000001'), {
    code: 'MEMORY_AMBIGUOUS_ID',
  });
  await writeFile(
    join(f.memory, 'HISTORY.md'),
    f.history.replace(
      'knownex-history:H000001:end',
      'knownex-history:H000001:broken',
    ),
  );
  await assert.rejects(memoryRead(f.memory, 'H000001'), {
    code: 'MEMORY_INVALID',
  });
});

test('missing information, path-like IDs and invalid options have compact explicit CLI outcomes', async (t) => {
  const f = await fixture(t);
  const empty = invoke(f.memory, ['find', 'nonexistentquantumrecord']);
  assert.equal(empty.status, 0);
  assert.deepEqual(JSON.parse(empty.stdout), {
    status: 'not_found',
    results: [],
  });
  const missing = invoke(f.memory, ['read', 'H999999']);
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stderr), {
    status: 'error',
    code: 'MEMORY_NOT_FOUND',
  });
  for (const args of [
    ['read', '../../STATE.md'],
    ['read', 'H000001/../secret'],
    ['state', 'extra'],
    ['find'],
    ['find', 'x', 'extra'],
    ['find', ''],
    ['find', '!!!'],
    ['find', 'x', '--type', 'other'],
    ['state', '--type', 'history'],
    ['state', '--memory', f.memory],
    ['read'],
    ['find', 'x', '--unknown'],
    ['find', 'x', '--type', 'history', '--type', 'history'],
  ]) {
    const r = invoke(f.memory, args);
    assert.equal(r.status, 2, JSON.stringify(args) + r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(!r.stderr.includes('Error:') && !r.stderr.includes('PRIVATE_'));
  }
  const byDefault = spawnSync(process.execPath, [entry, 'memory', 'state'], {
    cwd: f.root,
    encoding: 'utf8',
  });
  assert.equal(byDefault.status, 0);
  assert.equal(JSON.parse(byDefault.stdout).content, f.state);
});

test('junction escape and invalid UTF-8 are refused without reading outside the authorized memory', async (t) => {
  const f = await fixture(t),
    external = join(f.root, 'external');
  await mkdir(external);
  await writeFile(
    join(external, 'private.md'),
    note(3, 'Private', 'PRIVATE_OUTSIDE_ROOT'),
  );
  // Directory junctions work on Windows without requiring a file-symlink privilege.
  const other = join(f.root, 'other');
  await mkdir(other);
  await symlink(
    external,
    join(other, 'knowledge'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(memoryFind(other, 'private', 'knowledge'), {
    code: 'MEMORY_UNSAFE_PATH',
  });
  await writeFile(join(f.memory, 'STATE.md'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(memoryState(f.memory), { code: 'MEMORY_INVALID' });
  assert.match(
    await readFile(join(external, 'private.md'), 'utf8'),
    /PRIVATE_OUTSIDE_ROOT/,
  );
});

test('navigation creates no files and leaves memory, checkpoint bytes and mtimes untouched', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.memory, 'checkpoint.json'), '{"sequence":7}\n');
  const paths = [
    'STATE.md',
    'HISTORY.md',
    'checkpoint.json',
    'knowledge/a.md',
    'knowledge/b.md',
  ];
  const before = await Promise.all(
    paths.map(async (n) => ({
      n,
      bytes: await readFile(join(f.memory, n)),
      mtime: (await stat(join(f.memory, n), { bigint: true })).mtimeNs,
    })),
  );
  const listing = await readdir(f.memory);
  await memoryState(f.memory);
  await memoryFind(f.memory, 'shared');
  await memoryRead(f.memory, 'H000003');
  for (const old of before) {
    assert.deepEqual(await readFile(join(f.memory, old.n)), old.bytes);
    assert.equal(
      (await stat(join(f.memory, old.n), { bigint: true })).mtimeNs,
      old.mtime,
    );
  }
  assert.deepEqual(await readdir(f.memory), listing);
});
