import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  rm,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import {
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  rebuildTaxonomy,
} from '../src/curator.ts';
import {
  memoryState,
  memoryRead,
  memoryFind,
  memoryCategory,
} from '../src/navigator.ts';
import { archivePath } from '../src/knowledge-revisions.ts';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const ids = [
  'kn-00000000-0000-4000-8000-000000000001',
  'kn-00000000-0000-4000-8000-000000000002',
];
test('canonical memory has one physical copy per revision, linked STATE/HISTORY, noop and replay recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-layout-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const memory = join(root, '.knownex/memory'),
    work = join(root, '.knownex/internal/curator'),
    directory = join(root, '.knownex/internal/feed');
  await mkdir(join(memory, 'knowledge'), { recursive: true });
  const { emptyMemory } = await import('../src/curator.ts');
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  await writeFile(
    join(memory, 'taxonomy.json'),
    JSON.stringify({ spec: 'Specifications' }),
  );
  for (let n = 1; n <= 4; n++)
    await appendFeedEvent(directory, {
      type: 'user_message',
      sessionId: 's',
      turnId: String(n),
      text: 'Input ' + n,
      hook: 'UserPromptSubmit',
    });
  const feed = join(directory, hash('s') + '.jsonl');
  await initCurator(work, memory, feed, 0);
  const cp = async () =>
    JSON.parse(await readFile(join(work, 'checkpoint.json'), 'utf8'));
  const note = (id: string, body: string, feed: string, n: number) =>
    '---\nid: ' +
    id +
    '\ntype: knowledge\n---\n# Detail\n\n' +
    body +
    ' [E' +
    String(n).padStart(3, '0') +
    '](../' +
    feed +
    ')\n';
  async function commit(n: number, mode: 'new' | 'update' | 'noop') {
    const p = await prepareCurator(work, undefined, {
      through: n,
      context: mode === 'update' ? ['knowledge/a.md'] : [],
    });
    const packet = JSON.parse(
      await readFile(join(p.run!, 'packet.json'), 'utf8'),
    );
    if (mode === 'update')
      assert.match(packet.context['STATE.md'], /memory|knowledge/);
    const proposal =
      mode === 'noop'
        ? { action: 'noop' }
        : {
            action: 'update',
            state:
              mode === 'update'
                ? packet.context['STATE.md']
                    .replace(/\[A\]\([^)]+\)/, '[A](knowledge/a.md)')
                    .replace('# Project', '# Updated project')
                : '# Project\n\n[A](knowledge/a.md) [B](knowledge/b.md) [E' +
                  String(n).padStart(3, '0') +
                  '](' +
                  packet.feed +
                  ')\n',
            history: {
              summary: 'Change',
              topics: ['Design'],
              transition: 'Updated detail.',
            },
            knowledge:
              mode === 'new'
                ? {
                    'knowledge/a.md':
                      note(ids[0]!, 'Original caffe unicode.', packet.feed, n) +
                      '\n[Related](b.md)\n',
                    'knowledge/b.md': note(
                      ids[1]!,
                      'Unchanged detail.',
                      packet.feed,
                      n,
                    ),
                  }
                : {
                    'knowledge/a.md':
                      packet.context['knowledge/a.md'].replace(
                        'Original',
                        'Revised',
                      ) +
                      '\n[E002](../' +
                      packet.feed +
                      ')\n',
                  },
            categories: mode === 'new' ? { 'knowledge/a.md': 'spec' } : {},
          };
    await writeFile(p.proposal!, JSON.stringify(proposal));
    const v = await validateCurator(work);
    await applyCurator(work, v.seal);
    return cp();
  }
  const first = await commit(1, 'new'),
    old = first.knowledgeVersions.heads['knowledge/a.md'];
  assert.equal((await readdir(join(memory, 'knowledge'))).length, 1);
  assert.deepEqual(await readdir(join(memory, 'knowledge')), [
    'checkpoint-0001',
  ]);
  assert.match(await memoryState(memory), /knowledge\/checkpoint-0001\/spec\//);
  const unchanged = first.knowledgeVersions.heads['knowledge/b.md'];
  const oldBytes = await readFile(archivePath(work, old.file));
  const second = await commit(2, 'update');
  assert.deepEqual(second.knowledgeVersions.heads['knowledge/b.md'], unchanged);
  const intent = JSON.parse(
    await readFile(join(work, 'apply.json'), 'utf8'),
  ).record;
  await writeFile(join(work, 'checkpoint.json'), JSON.stringify(intent.before));
  await writeFile(join(memory, 'STATE.md'), intent.previous['STATE.md']);
  await unlink(
    archivePath(work, second.knowledgeVersions.heads['knowledge/a.md'].file),
  );
  assert.match(await memoryState(memory), /Updated project/);
  assert.deepEqual(await cp(), second);
  assert.deepEqual(
    await readdir(join(memory, 'knowledge', 'checkpoint-0002')),
    [
      second.knowledgeVersions.heads['knowledge/a.md'].id +
        '--' +
        second.knowledgeVersions.heads['knowledge/a.md'].revision +
        '.md',
    ],
  );
  assert.match((await memoryRead(memory, ids[0]!)).content, /Revised/);
  assert.match((await memoryRead(memory, 'knowledge/a.md')).content, /Revised/);
  const direct = (await memoryFind(memory, 'Revised'))[0]!.reference;
  assert.match((await memoryRead(memory, direct)).content, /Revised/);
  assert.match(
    (await memoryRead(memory, ids[0]!, { at: 1 })).content,
    /Original/,
  );
  assert.match(
    (await memoryRead(memory, 'H000002')).content,
    /checkpoint-0001/,
  );
  assert.equal(
    (await memoryFind(memory, 'Revised'))[0]?.path.startsWith(
      'knowledge/checkpoint-0002/',
    ),
    true,
  );
  assert.equal((await memoryFind(memory, 'Original')).length, 0);
  const no = await commit(3, 'noop');
  assert.deepEqual(no.knowledgeVersions.heads, second.knowledgeVersions.heads);
  assert.match(
    (await memoryRead(memory, ids[0]!, { at: 3 })).content,
    /Revised/,
  );
  assert.deepEqual(await readFile(archivePath(work, old.file)), oldBytes);
  assert.equal(
    (await readdir(join(work, 'revisions'))).every((f) => f.endsWith('.json')),
    true,
  );
  await assert.rejects(readdir(join(work, 'memory')), { code: 'ENOENT' });
  // Replay the durable authorization from a mixed visible prefix; no new proposal or grant.
  const journal = JSON.parse(await readFile(join(work, 'apply.json'), 'utf8'));
  await writeFile(
    join(work, 'checkpoint.json'),
    JSON.stringify(journal.record.before),
  );
  assert.match(await memoryState(memory), /Updated project/);
  assert.equal((await cp()).sequence, 3);
  const history = await readFile(join(memory, 'HISTORY.md'), 'utf8');
  assert.equal((history.match(/:begin -->/g) || []).length, 2);
  await rebuildTaxonomy(work);
  assert.match(
    await readFile(join(memory, 'topics/category-spec.md'), 'utf8'),
    /knowledge|checkpoint-0001/,
  );
  assert.ok((await memoryCategory(memory, 'spec')).results.length >= 1);
  assert.equal((await cp()).sequence, 3);
  // A Markdown reader needs real paths, not logical aliases resolved by the CLI.
  async function checkLinks(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) await checkLinks(file);
      else if (entry.name.endsWith('.md')) {
        const text = await readFile(file, 'utf8');
        for (const link of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          const destination = decodeURIComponent(link[1]!.split('#')[0]!);
          assert.ok(
            (await stat(resolve(dirname(file), destination))).isFile(),
            file + ': ' + destination,
          );
        }
      }
    }
  }
  await checkLinks(memory);
  // Corrupt confirmed storage cannot be accepted or repaired without matching evidence.
  await writeFile(join(memory, 'STATE.md'), '# Unauthorised corruption\n');
  await assert.rejects(memoryState(memory), {
    code: 'CURATOR_RECOVERY_INVALID',
  });
  await assert.rejects(prepareCurator(work, undefined, { through: 4 }), {
    code: 'CURATOR_RECOVERY_INVALID',
  });
  assert.equal((await cp()).sequence, 3);
});
