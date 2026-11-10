import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import {
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  prepareTaxonomy,
  validateTaxonomy,
  applyTaxonomy,
  rebuildTaxonomy,
} from '../src/curator.ts';
import {
  memoryFind,
  memoryRead,
  memoryState,
  memoryCategory,
} from '../src/navigator.ts';
import { historyAppendix } from '../src/history.ts';

const id = 'kn-00000000-0000-4000-8000-000000000001';
const secondId = 'kn-00000000-0000-4000-8000-000000000002';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const digest = (tree: Record<string, string>) =>
  hash(
    JSON.stringify(
      Object.entries(tree).sort(([a], [b]) => a.localeCompare(b, 'en')),
    ),
  );
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-versions-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const work = join(root, 'work'),
    seed = join(root, 'seed'),
    feedDir = join(root, 'feed');
  for (let n = 1; n <= 9; n++)
    await appendFeedEvent(feedDir, {
      type: 'user_message',
      sessionId: 's',
      turnId: String(n),
      text: 'Synthetic input ' + n,
      hook: 'UserPromptSubmit',
    });
  const feed = join(feedDir, hash('s') + '.jsonl');
  await mkdir(join(seed, 'knowledge'), { recursive: true });
  await writeFile(join(seed, 'HISTORY.md'), '# History\n');
  await writeFile(
    join(seed, 'STATE.md'),
    '# Project\n\n[Topic](knowledge/topic.md) [E001](../feed/' +
      basename(feed) +
      ')\n',
  );
  await writeFile(
    join(seed, 'knowledge/topic.md'),
    '---\nid: ' +
      id +
      '\ntype: knowledge\n---\n\n# Topic\n\nOriginal caffè 日本語 🧠 e\u0301. [E001](../../feed/' +
      basename(feed) +
      ')\n',
  );
  await initCurator(work, seed, feed, 1);
  const memory = join(work, 'memory');
  const checkpoint = async () =>
    JSON.parse(await readFile(join(work, 'checkpoint.json'), 'utf8'));
  async function proposal(
    through: number,
    body?: string,
    extra?: string,
    noop = false,
  ) {
    const p = await prepareCurator(work, undefined, {
      through,
      context: ['knowledge/topic.md'],
    });
    const packet = JSON.parse(
      await readFile(join(p.run!, 'packet.json'), 'utf8'),
    );
    const knowledge: Record<string, string> = {};
    if (body !== undefined)
      knowledge['knowledge/topic.md'] = packet.context[
        'knowledge/topic.md'
      ].replace(
        /^# Topic[\s\S]*/m,
        '# Topic\n\n' + body + ` [E00${through}](../${packet.feed})\n`,
      );
    if (extra !== undefined)
      knowledge['knowledge/second.md'] =
        '---\nid: ' +
        secondId +
        '\ntype: knowledge\n---\n\n# Second\n' +
        extra +
        ` [E00${through}](../${packet.feed})\n`;
    await writeFile(
      p.proposal!,
      JSON.stringify(
        noop
          ? { action: 'noop' }
          : {
              action: 'update',
              state: `# Project\n\n[Topic](knowledge/topic.md) [Current](knowledge/topic.md)<!-- knownex:current --> [E00${through}](${packet.feed})\n`,
              history: {
                summary: 'Update',
                topics: ['Topic'],
                transition: 'New revision; [Topic](knowledge/topic.md).',
              },
              knowledge,
            },
      ),
    );
    return { ...p, packet };
  }
  async function commit(
    through: number,
    body?: string,
    extra?: string,
    noop = false,
  ) {
    const p = await proposal(through, body, extra, noop),
      v = await validateCurator(work);
    await applyCurator(work, v.seal);
    return { p, v, cp: await checkpoint() };
  }
  return { root, work, memory, feed, proposal, commit, checkpoint };
}

test('immutable full revisions, baseline, noop checkpoints and historical STATE resolve without duplicating unchanged notes', async (t) => {
  const f = await fixture(t),
    first = await f.commit(2, 'Revision two.');
  const r2 = first.cp.knowledgeVersions.heads['knowledge/topic.md'].revision;
  const exact2 = await memoryRead(f.memory, id + '@' + r2);
  assert.match(exact2.content, /Revision two/);
  assert.equal(
    (await memoryRead(f.memory, id, { at: 1 })).content.includes(
      'Original caffè 日本語 🧠 e\u0301',
    ),
    true,
  );
  await assert.rejects(memoryRead(f.memory, id, { at: 0 }), {
    code: 'KNOWLEDGE_LEGACY_HISTORY',
  });
  const oldHistory = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  const oldVersion = await readFile(resolve(f.memory, exact2.path));
  const middle = await f.commit(4, undefined, undefined, true);
  assert.deepEqual(
    middle.cp.knowledgeVersions.heads,
    first.cp.knowledgeVersions.heads,
  );
  assert.equal(
    await readFile(join(f.memory, 'HISTORY.md'), 'utf8'),
    oldHistory,
  );
  assert.equal(
    (await memoryRead(f.memory, id, { at: 4 })).content,
    exact2.content,
  );
  await assert.rejects(memoryRead(f.memory, id, { at: 3 }), {
    code: 'KNOWLEDGE_CHECKPOINT_NOT_FOUND',
  });
  const final = await f.commit(6, 'Revision six.', 'Independent result');
  assert.equal(final.cp.sequence, 6);
  assert.equal((await memoryRead(f.memory, id)).id, id);
  assert.match((await memoryRead(f.memory, id)).content, /Revision six/);
  assert.equal(
    (await memoryRead(f.memory, id + '@' + r2)).content,
    exact2.content,
  );
  assert.equal(
    (await memoryRead(f.memory, id, { at: 'H000002' })).content,
    exact2.content,
  );
  await assert.rejects(memoryRead(f.memory, secondId, { at: 4 }), {
    code: 'KNOWLEDGE_NOT_AT_CHECKPOINT',
  });
  assert.deepEqual(await readFile(resolve(f.memory, exact2.path)), oldVersion);
  const history = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  assert.ok(history.startsWith(oldHistory));
  assert.ok(history.includes(exact2.path));
  const current = await memoryState(f.memory);
  assert.match(current, /\[Topic\]\(\.\.\/revisions\//);
  assert.match(
    current,
    /\[Current\]\(knowledge\/topic\.md\)<!-- knownex:current -->/,
  );
  const archive = await readdir(join(f.work, 'revisions'), { recursive: true });
  assert.equal(archive.filter((n) => n.endsWith('.md')).length, 4); // baseline, two changed versions, new independent note
  assert.equal(archive.filter((n) => n.endsWith('.json')).length, 4); // baseline and all three confirmed checkpoints, including noop
  const cli = spawnSync(
    process.execPath,
    [
      resolve('src/index.ts'),
      'memory',
      'read',
      id,
      '--at',
      '4',
      '--memory',
      f.memory,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).content, exact2.content);
});

test('direct links and section reads retain temporal identity across similar notes and repeated corrections', async (t) => {
  const f = await fixture(t);
  await f.commit(
    2,
    '## Policy\n\nTimeout 30 s; policy precedente.\n\n## Limiti\n\nRete non verificata.',
    '## Policy\n\nTimeout indipendente: 60 s.',
  );
  const early = await memoryRead(f.memory, id);
  assert.ok('versionReference' in early);
  const earlyReference = early.versionReference! + '#policy';
  const frozen = await memoryRead(f.memory, earlyReference);
  assert.ok(frozen.content.includes('30 s'));
  assert.ok(!frozen.content.includes('Limiti'));
  await f.commit(
    4,
    '## Policy\n\nTimeout corretto: 45 s, solo locale.\n\n## Limiti\n\nRete non verificata.',
  );
  await f.commit(
    6,
    '## Policy\n\nTimeout corretto: 50 s, solo locale.\n\n## Limiti\n\nRete non verificata.',
  );
  const current = await memoryRead(f.memory, 'knowledge/topic.md#policy');
  assert.ok(current.content.includes('50 s'));
  assert.ok(!current.content.includes('30 s'));
  assert.equal(
    (await memoryRead(f.memory, earlyReference)).content,
    frozen.content,
  );
  assert.equal(
    (await memoryRead(f.memory, id + '#policy', { at: 2 })).content,
    frozen.content,
  );
  assert.equal(
    (await memoryRead(f.memory, id + '#policy', { at: 'H000002' })).content,
    frozen.content,
  );
  const results = await memoryFind(f.memory, 'timeout', 'knowledge');
  assert.equal(results.length, 2); // Current logical notes, not their archived versions.
  assert.equal(new Set(results.map((r) => r.id)).size, 2);
  assert.deepEqual(await memoryFind(f.memory, 'timeout', 'knowledge'), results);
  assert.deepEqual(await memoryFind(f.memory, 'precedente', 'knowledge'), []);
  assert.ok(
    (
      await memoryRead(
        f.memory,
        results.find((r) => r.id === secondId)!.reference,
      )
    ).content.includes('60 s'),
  );
  const state = await memoryState(f.memory);
  const destination = /\[Topic\]\(([^)]+)\)/.exec(state)![1]!;
  assert.ok(
    (await memoryRead(f.memory, destination + '#policy')).content.includes(
      '50 s',
    ),
  );
  await assert.rejects(memoryRead(f.memory, earlyReference, { at: 6 }), {
    code: 'MEMORY_INVALID_ID',
  });
});

test('checkpoint folders publish only changed notes with optional approved categories and a frozen taxonomy', async (t) => {
  const f = await fixture(t);
  const taxonomy = {
    architecture: 'Decisioni e vincoli architetturali',
    experiments: 'Risultati e limiti delle prove',
  };
  await writeFile(join(f.work, 'taxonomy.json'), JSON.stringify(taxonomy));
  const p = await f.proposal(
    2,
    '## Design\n\nArchitecture detail. [Experiment](second.md#result)',
    '## Result\n\nIndependent experiment.',
  );
  assert.deepEqual(p.packet.taxonomy, taxonomy);
  const proposal = JSON.parse(await readFile(p.proposal!, 'utf8'));
  const cpBefore = await readFile(join(f.work, 'checkpoint.json'));
  await writeFile(
    p.proposal!,
    JSON.stringify({ ...proposal, categories: null }),
  );
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_PROPOSAL_INVALID',
  });
  for (const categories of [
    { 'knowledge/topic.md': 'invented' },
    { '../outside.md': 'architecture' },
    { 'knowledge/topic.md': '../architecture' },
  ]) {
    await writeFile(p.proposal!, JSON.stringify({ ...proposal, categories }));
    await assert.rejects(validateCurator(f.work), {
      code: 'CURATOR_CATEGORY_INVALID',
    });
    assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), cpBefore);
  }
  await writeFile(
    p.proposal!,
    JSON.stringify({
      ...proposal,
      categories: {
        'knowledge/topic.md': 'architecture',
        'knowledge/second.md': 'experiments',
      },
    }),
  );
  // Registry edits cannot reinterpret a frozen authorized batch.
  await writeFile(
    join(f.work, 'taxonomy.json'),
    JSON.stringify({ experiments: taxonomy.experiments }),
  );
  const v = await validateCurator(f.work);
  await applyCurator(f.work, v.seal);
  const first = await f.checkpoint();
  const topic = await memoryRead(f.memory, id);
  assert.ok('versionReference' in topic);
  assert.equal(topic.category, 'architecture');
  assert.equal(topic.checkpoint, 2);
  assert.match(topic.versionReference!, /checkpoint-0002\/architecture\//);
  assert.equal(
    (await memoryRead(f.memory, topic.versionReference!)).content.includes(
      'Architecture detail.',
    ),
    true,
  );
  const immutable = await memoryRead(f.memory, topic.versionReference!);
  const linked = /\[Experiment\]\(([^)]+)\)/.exec(immutable.content)![1]!;
  assert.ok(
    (
      await readFile(
        resolve(
          dirname(resolve(f.memory, immutable.path)),
          linked.split('#')[0]!,
        ),
        'utf8',
      )
    ).includes('Independent experiment.'),
  );
  assert.equal(
    (await memoryRead(f.memory, topic.versionReference! + '#design')).selection!
      .anchor,
    'design',
  );
  for (const entry of [
    resolve('src/index.ts'),
    ...(process.env.KNOWNEX_TEST_COMPILED_CLI === '1'
      ? [resolve('dist/index.js')]
      : []),
  ]) {
    const cli: SpawnSyncReturns<string> = spawnSync(
      process.execPath,
      [
        entry,
        'memory',
        'read',
        topic.versionReference! + '#design',
        '--memory',
        f.memory,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).category, 'architecture');
    assert.ok(JSON.parse(cli.stdout).content.includes('Architecture detail.'));
  }
  await assert.rejects(
    memoryRead(
      f.memory,
      topic.versionReference!.replace('checkpoint-0002', 'checkpoint-0999'),
    ),
    { code: 'MEMORY_NOT_FOUND' },
  );
  assert.deepEqual(
    (await memoryFind(f.memory, 'architecture', 'knowledge')).map((r) => r.id),
    [id],
  );
  assert.equal(
    (await memoryFind(f.memory, 'checkpoint-0002', 'knowledge')).length,
    2,
  );
  const state = await memoryState(f.memory);
  for (const match of state.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g))
    assert.ok(await readFile(resolve(f.memory, decodeURIComponent(match[1]!))));
  const versions = await readdir(join(f.work, 'revisions'), {
    recursive: true,
  });
  const markdown = versions.filter((n) => n.endsWith('.md'));
  assert.equal(markdown.length, 3); // one adopted baseline plus the two changed/new notes
  await f.commit(4, undefined, undefined, true);
  assert.deepEqual(
    (await f.checkpoint()).knowledgeVersions.heads,
    first.knowledgeVersions.heads,
  );
  await assert.rejects(readdir(join(f.work, 'revisions/checkpoint-0004')), {
    code: 'ENOENT',
  });
  assert.deepEqual(
    (await readdir(join(f.work, 'revisions'), { recursive: true })).filter(
      (n) => n.endsWith('.md'),
    ),
    markdown,
  );
  const later = await f.commit(6, 'Uncategorized update.');
  assert.match(
    later.cp.knowledgeVersions.heads['knowledge/topic.md'].file,
    /^checkpoint-0006\/kn-/,
  );
  assert.deepEqual(
    later.cp.knowledgeVersions.heads['knowledge/second.md'],
    first.knowledgeVersions.heads['knowledge/second.md'],
  );
  assert.equal((await memoryRead(f.memory, id)).category, undefined);
  assert.equal(
    (await memoryRead(f.memory, topic.versionReference!)).category,
    'architecture',
  );
  const unchanged = await f.proposal(8);
  const raw = JSON.parse(await readFile(unchanged.proposal!, 'utf8'));
  await writeFile(
    unchanged.proposal!,
    JSON.stringify({
      ...raw,
      knowledge: {
        'knowledge/topic.md': unchanged.packet.context['knowledge/topic.md'],
      },
      categories: { 'knowledge/topic.md': 'experiments' },
    }),
  );
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_CATEGORY_INVALID',
  });
});

test('flat legacy revisions and pending validations keep their paths and coexist with new chronological publications', async (t) => {
  const f = await fixture(t),
    p = await f.proposal(2, 'Legacy flat version.');
  // Reproduce a pre-layout frozen run. Its proposal and validation retain the old format.
  const file = join(p.run!, 'run.json');
  const run = JSON.parse(await readFile(file, 'utf8'));
  delete run.revisionLayout;
  delete run.taxonomy;
  await writeFile(file, JSON.stringify(run));
  const v = await validateCurator(f.work);
  interrupt(f.work, v.seal, 'memory/STATE.md');
  assert.match(await memoryState(f.memory), /Topic/);
  const legacy = await memoryRead(f.memory, id);
  assert.ok('versionReference' in legacy);
  assert.ok(!legacy.versionReference!.includes('checkpoint-'));
  const bytes = await readFile(resolve(f.memory, legacy.versionReference!));
  const history = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  await applyCurator(f.work, v.seal);
  const next = await f.commit(4, 'New hierarchical version.');
  assert.match(
    next.cp.knowledgeVersions.heads['knowledge/topic.md'].file,
    /^checkpoint-0004\//,
  );
  assert.deepEqual(
    await readFile(resolve(f.memory, legacy.versionReference!)),
    bytes,
  );
  assert.ok(
    (await readFile(join(f.memory, 'HISTORY.md'), 'utf8')).startsWith(history),
  );
  assert.ok(
    (await memoryRead(f.memory, legacy.versionReference!)).content.includes(
      'Legacy flat version.',
    ),
  );
  assert.ok(
    (await memoryRead(f.memory, id, { at: 2 })).content.includes(
      'Legacy flat version.',
    ),
  );
});

test('taxonomy validation and nested archive junctions reject unsafe input without creating categories', async (t) => {
  for (const value of [
    [],
    { '../escape': 'bad' },
    { con: 'reserved' },
    { architecture: '' },
    { architecture: 42 },
  ]) {
    const f = await fixture(t);
    await writeFile(join(f.work, 'taxonomy.json'), JSON.stringify(value));
    await assert.rejects(f.proposal(2, 'Never applied.'), {
      code: 'CURATOR_TAXONOMY_INVALID',
    });
    assert.equal((await f.checkpoint()).sequence, 1);
  }
  const f = await fixture(t);
  await f.proposal(2, 'Unsafe target.');
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await mkdir(join(f.work, 'revisions'));
  await symlink(
    outside,
    join(f.work, 'revisions/checkpoint-0002'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(validateCurator(f.work), {
    code: 'KNOWLEDGE_ARCHIVE_UNSAFE',
  });
  assert.deepEqual(await readdir(outside), []);
});

test('crash after checkpoint directory creation and interrupted recovery preserve one immutable generation', async (t) => {
  const f = await fixture(t),
    p = await f.proposal(2, 'Recovered nested publication.'),
    v = await validateCurator(f.work);
  const source = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const mkdir=fs.mkdir;fs.mkdir=async function(...args){const result=await mkdir.apply(this,args);if(String(args[0]).replaceAll('\\\\','/').endsWith('/checkpoint-0002'))process.exit(73);return result;};syncBuiltinESMExports();const {applyCurator}=await import(${JSON.stringify(pathToFileURL(resolve('src/curator.ts')).href)});await applyCurator(${JSON.stringify(f.work)},${JSON.stringify(v.seal)});`;
  const interrupted = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', source],
    { encoding: 'utf8' },
  );
  assert.equal(interrupted.status, 73, interrupted.stderr);
  const record = JSON.parse(
    await readFile(join(f.work, 'apply.json'), 'utf8'),
  ).record;
  assert.equal((await f.checkpoint()).sequence, 1);
  interrupt(f.work, v.seal, '--r-');
  await rm(p.proposal!);
  await rm(v.candidate, { recursive: true });
  assert.equal(await memoryState(f.memory), record.next['STATE.md']);
  assert.ok(
    (await memoryRead(f.memory, id)).content.includes(
      'Recovered nested publication.',
    ),
  );
  const history = await readFile(join(f.memory, 'HISTORY.md'));
  const revisions = await readdir(join(f.work, 'revisions'), {
    recursive: true,
  });
  await applyCurator(f.work, v.seal);
  assert.deepEqual(await readFile(join(f.memory, 'HISTORY.md')), history);
  assert.deepEqual(
    await readdir(join(f.work, 'revisions'), { recursive: true }),
    revisions,
  );
});

async function taxonomyEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  type: 'user_message' | 'assistant_final',
  text: string,
  turn: string,
) {
  await appendFeedEvent(dirname(f.feed), {
    type,
    sessionId: 's',
    turnId: turn,
    text,
    hook: type === 'user_message' ? 'UserPromptSubmit' : 'Stop',
  });
  const rows = (await readFile(f.feed, 'utf8')).trim().split('\n');
  return JSON.parse(rows.at(-1)!).block.event.sequence as number;
}
async function taxonomyStart(
  f: Awaited<ReturnType<typeof fixture>>,
  turn: string,
) {
  await taxonomyEvent(f, 'user_message', '$knownex-taxonomy', turn);
  return prepareTaxonomy(f.work);
}
async function taxonomyApprove(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  seal: string,
  turn: string,
  reply = 'Proceed with the proposed thematic organization.',
) {
  await taxonomyEvent(
    f,
    'assistant_final',
    `Proposta ${id}; sigillo ${seal}. Categorie, motivazioni e revisioni presentate.`,
    turn,
  );
  return taxonomyEvent(f, 'user_message', reply, turn + '-reply');
}
test('explicit taxonomy workflow preserves historical bytes, exposes chronological retroactive categories and rebuilds Markdown views', async (t) => {
  const f = await fixture(t);
  await f.commit(2, 'First research detail.');
  await f.commit(4, 'Current research detail.');
  const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
  const history = await readFile(join(f.memory, 'HISTORY.md'));
  const state = await memoryState(f.memory);
  const existing = await readdir(join(f.work, 'revisions'), {
    recursive: true,
  });
  const bytes = new Map(
    await Promise.all(
      existing
        .filter((p) => p.endsWith('.md'))
        .map(
          async (p) =>
            [p, await readFile(join(f.work, 'revisions', p))] as const,
        ),
    ),
  );
  await assert.rejects(prepareTaxonomy(f.work), {
    code: 'TAXONOMY_INVOCATION_REQUIRED',
  });
  const p = await taxonomyStart(f, 'taxonomy-one');
  const packet = JSON.parse(await readFile(join(p.run, 'packet.json'), 'utf8'));
  const chosen = packet.revisions.filter(
    (r: { through: number }) => r.through === 1 || r.through === 4,
  );
  const assignments = Object.fromEntries(
    chosen.map((r: { id: string; revision: string }) => [
      r.id + '@' + r.revision,
      ['methods'],
    ]),
  );
  await writeFile(
    p.proposal,
    JSON.stringify({
      categories: { methods: 'Metodi e limiti della ricerca' },
      assignments,
      explanations:
        'Tema ricorrente nei checkpoint 1 e 4; nessuna sovrapposizione nota.',
    }),
  );
  const v = await validateTaxonomy(f.work, p.id);
  assert.equal(v.status, 'validated');
  await assert.rejects(readFile(join(f.work, 'taxonomy.json')), {
    code: 'ENOENT',
  });
  await assert.rejects(applyTaxonomy(f.work, p.id, v.seal!, 12345), {
    code: 'TAXONOMY_APPROVAL_REQUIRED',
  });
  const approval = await taxonomyApprove(f, p.id, v.seal!, 'proposal-one');
  await applyTaxonomy(f.work, p.id, v.seal!, approval);
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), checkpoint);
  assert.deepEqual(await readFile(join(f.memory, 'HISTORY.md')), history);
  assert.equal(await memoryState(f.memory), state);
  for (const [path, before] of bytes)
    assert.deepEqual(await readFile(join(f.work, 'revisions', path)), before);
  assert.deepEqual(
    await readdir(join(f.work, 'revisions'), { recursive: true }),
    existing,
  );
  const page = await memoryCategory(f.memory, 'methods', { limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.results[0]!.through, 1);
  assert.ok(page.nextCursor);
  const last = await memoryCategory(f.memory, 'methods', {
    cursor: page.nextCursor!,
  });
  assert.equal(last.results[0]!.through, 4);
  assert.equal(last.results[0]!.classification, 'retroactive');
  assert.ok(
    (await memoryRead(f.memory, last.results[0]!.reference)).content.includes(
      'Current research detail.',
    ),
  );
  assert.deepEqual(
    (await memoryFind(f.memory, 'methods', 'knowledge')).map((r) => r.id),
    [id],
  );
  const index = await readFile(
    join(f.work, 'topics/category-methods.md'),
    'utf8',
  );
  assert.ok(index.indexOf('Checkpoint 1') < index.indexOf('Checkpoint 4'));
  for (const match of index.matchAll(/\]\(([^)]+)\)/g))
    assert.ok(
      await readFile(resolve(f.work, 'topics', decodeURIComponent(match[1]!))),
    );
  const receipt = await readFile(
    join(f.work, 'taxonomy-changes', p.id + '.json'),
  );
  assert.equal(
    (await applyTaxonomy(f.work, p.id, v.seal!, approval)).status,
    'already_applied',
  );
  await rm(join(f.work, 'topics/category-methods.md'));
  await rebuildTaxonomy(f.work);
  assert.equal(
    await readFile(join(f.work, 'topics/category-methods.md'), 'utf8'),
    index,
  );
  const second = await taxonomyStart(f, 'taxonomy-two');
  await writeFile(
    second.proposal,
    JSON.stringify({
      categories: { methods: 'Metodi, evidenze e limiti verificabili' },
      assignments: {},
    }),
  );
  const next = await validateTaxonomy(f.work, second.id);
  const nextApproval = await taxonomyApprove(
    f,
    second.id,
    next.seal!,
    'proposal-two',
    'Approvo la descrizione aggiornata.',
  );
  await applyTaxonomy(f.work, second.id, next.seal!, nextApproval);
  await assert.rejects(
    memoryCategory(f.memory, 'methods', { cursor: page.nextCursor! }),
    { code: 'TAXONOMY_CURSOR_INVALID' },
  );
  assert.deepEqual(
    await readFile(join(f.work, 'taxonomy-changes', p.id + '.json')),
    receipt,
  );
  assert.equal(
    (await applyTaxonomy(f.work, p.id, v.seal!, approval)).status,
    'already_applied',
  );
  await f.commit(6, 'Normal curator still works.');
  assert.equal((await f.checkpoint()).sequence, 6);
});
test('taxonomy noop, revisions by user, stale proposals and unrelated approval events cannot apply silently', async (t) => {
  const f = await fixture(t);
  await f.commit(2, 'Existing subject.');
  const p = await taxonomyStart(f, 'analysis');
  await writeFile(
    p.proposal,
    JSON.stringify({ categories: {}, assignments: {} }),
  );
  assert.equal((await validateTaxonomy(f.work, p.id)).status, 'noop');
  await assert.rejects(readFile(join(f.work, 'taxonomy.json')), {
    code: 'ENOENT',
  });
  await writeFile(
    p.proposal,
    JSON.stringify({
      categories: { first: 'Prima proposta' },
      assignments: {},
    }),
  );
  const old = await validateTaxonomy(f.work, p.id);
  await taxonomyApprove(
    f,
    p.id,
    old.seal!,
    'old-proposal',
    'No, usa una categoria diversa.',
  );
  await writeFile(
    p.proposal,
    JSON.stringify({
      categories: { revised: 'Categoria definita dall’utente' },
      assignments: {},
    }),
  );
  const revised = await validateTaxonomy(f.work, p.id);
  await assert.rejects(applyTaxonomy(f.work, p.id, old.seal!, 12), {
    code: 'TAXONOMY_CONFIRMATION_REQUIRED',
  });
  await assert.rejects(applyTaxonomy(f.work, p.id, revised.seal!, 12), {
    code: 'TAXONOMY_APPROVAL_REQUIRED',
  });
  const approval = await taxonomyApprove(
    f,
    p.id,
    revised.seal!,
    'revised-proposal',
  );
  await applyTaxonomy(f.work, p.id, revised.seal!, approval);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.work, 'taxonomy.json'), 'utf8')),
    { revised: 'Categoria definita dall’utente' },
  );
  const pending = await taxonomyStart(f, 'stale');
  await writeFile(
    pending.proposal,
    JSON.stringify({ categories: { extra: 'Altro tema' }, assignments: {} }),
  );
  await validateTaxonomy(f.work, pending.id);
  await f.commit(4, 'Later checkpoint.');
  await assert.rejects(validateTaxonomy(f.work, pending.id), {
    code: 'TAXONOMY_STALE_PROPOSAL',
  });
});
test('taxonomy approval is session-bound and the same journal recovers interrupted metadata promotion without a checkpoint', async (t) => {
  const f = await fixture(t);
  await f.commit(2, 'Historical subject.');
  const p = await taxonomyStart(f, 'recover-taxonomy');
  await writeFile(
    p.proposal,
    JSON.stringify({
      categories: { research: 'Tema di ricerca' },
      assignments: {},
    }),
  );
  const v = await validateTaxonomy(f.work, p.id);
  await taxonomyEvent(
    f,
    'assistant_final',
    `Proposta ${p.id}; sigillo ${v.seal!}`,
    'display',
  );
  await appendFeedEvent(dirname(f.feed), {
    type: 'user_message',
    sessionId: 'other',
    turnId: 'wrong-session',
    text: 'Approvo',
    hook: 'UserPromptSubmit',
  });
  const wrong = JSON.parse(
    (await readFile(f.feed, 'utf8')).trim().split('\n').at(-1)!,
  ).block.event.sequence;
  await assert.rejects(applyTaxonomy(f.work, p.id, v.seal!, wrong), {
    code: 'TAXONOMY_APPROVAL_REQUIRED',
  });
  const approval = await taxonomyEvent(
    f,
    'user_message',
    'Salva questa organizzazione.',
    'real-approval',
  );
  const cp = await readFile(join(f.work, 'checkpoint.json'));
  const script = `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const original=fs.rename;fs.rename=async function(a,b){await original.call(this,a,b);if(String(b).replaceAll('\\\\','/').endsWith('/taxonomy.json'))process.exit(73)};syncBuiltinESMExports();const{applyTaxonomy}=await import(${JSON.stringify(pathToFileURL(resolve('src/curator.ts')).href)});await applyTaxonomy(${JSON.stringify(f.work)},${JSON.stringify(p.id)},${JSON.stringify(v.seal)},${approval});`;
  const crashed = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  assert.equal(crashed.status, 73, crashed.stderr);
  await assert.rejects(
    (await import('../src/curator.ts')).readPendingEvents(f.work, f.feed),
    { code: 'CURATOR_RECOVERY_REQUIRED' },
  );
  await memoryState(f.memory);
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), cp);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.work, 'taxonomy.json'), 'utf8')),
    { research: 'Tema di ricerca' },
  );
  assert.equal(
    (await applyTaxonomy(f.work, p.id, v.seal!, approval)).status,
    'already_applied',
  );
  await writeFile(join(f.work, 'taxonomy.json'), '{}');
  await assert.rejects(memoryState(f.memory), { code: 'TAXONOMY_COLLISION' });
});

test('current navigation ignores unrelated archive contents; missing historical revisions and corrupt current heads fail explicitly', async (t) => {
  const f = await fixture(t),
    one = await f.commit(2, 'First.'),
    two = await f.commit(4, 'Second.');
  const old = await memoryRead(
    f.memory,
    id + '@' + one.cp.knowledgeVersions.heads['knowledge/topic.md'].revision,
  );
  await writeFile(
    join(
      f.work,
      'revisions',
      'kn-00000000-0000-4000-8000-000000000099--r-9-9-00000000-0000-4000-8000-000000000099.md',
    ),
    'unrelated malformed archive entry',
  );
  assert.equal((await memoryFind(f.memory, 'Second', 'knowledge')).length, 1);
  await assert.rejects(
    memoryRead(
      f.memory,
      '../revisions/kn-00000000-0000-4000-8000-000000000099--r-9-9-00000000-0000-4000-8000-000000000099.md',
    ),
    { code: 'MEMORY_NOT_FOUND' },
  );
  await rm(resolve(f.memory, old.path));
  assert.match((await memoryRead(f.memory, id)).content, /Second/);
  await assert.rejects(
    memoryRead(
      f.memory,
      id + '@' + one.cp.knowledgeVersions.heads['knowledge/topic.md'].revision,
    ),
    { code: 'KNOWLEDGE_REVISION_MISSING' },
  );
  const current = await memoryRead(
    f.memory,
    id + '@' + two.cp.knowledgeVersions.heads['knowledge/topic.md'].revision,
  );
  await appendFile(resolve(f.memory, current.path), 'corruption');
  const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
  await assert.rejects(memoryRead(f.memory, id), {
    code: 'KNOWLEDGE_REVISION_COLLISION',
  });
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), checkpoint);
});

test('archive collisions and symlink boundaries are rejected before confirmation', async (t) => {
  const f = await fixture(t),
    p = await f.proposal(2, 'Changed.');
  const archive = join(f.work, 'revisions');
  await mkdir(join(archive, 'checkpoint-0001'), { recursive: true });
  const file = join(
    archive,
    'checkpoint-0001',
    id + '--b-' + basename(p.run!) + '.md',
  );
  await writeFile(file, 'collision');
  await assert.rejects(validateCurator(f.work), {
    code: 'KNOWLEDGE_REVISION_COLLISION',
  });
  assert.equal((await f.checkpoint()).sequence, 1);
  assert.ok(await readFile(join(f.work, 'pending.json')));
  await rm(file);
  const outside = join(f.root, 'outside.md');
  await writeFile(outside, 'outside');
  try {
    await symlink(outside, file);
  } catch (e) {
    if (['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) {
      t.diagnostic(
        'File symlink creation unavailable; collision case remains exercised.',
      );
      return;
    }
    throw e;
  }
  await assert.rejects(validateCurator(f.work), {
    code: 'KNOWLEDGE_ARCHIVE_UNSAFE',
  });
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('taxonomy accepts registry-only workspaces, preserves original categories and supports explicit unclassification', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.work, 'taxonomy.json'),
    JSON.stringify({ design: 'Scelte progettuali' }),
  );
  const p = await f.proposal(2, 'Design detail.');
  const raw = JSON.parse(await readFile(p.proposal!, 'utf8'));
  await writeFile(
    p.proposal!,
    JSON.stringify({ ...raw, categories: { 'knowledge/topic.md': 'design' } }),
  );
  await applyCurator(f.work, (await validateCurator(f.work)).seal);
  const original = await memoryCategory(f.memory, 'design');
  assert.equal(original.total, 1);
  assert.equal(original.results[0]!.classification, 'original');
  const r = original.results[0]!;
  const before = await memoryRead(f.memory, r.reference);
  const run = await taxonomyStart(f, 'unclassify');
  for (const [assignments, code] of [
    { [r.id + '@' + r.revision]: ['unknown'] },
    { [r.id + '@' + r.revision + 'x']: ['design'] },
  ].map(
    (assignments, i) =>
      [
        assignments,
        i === 0 ? 'TAXONOMY_CATEGORY_UNKNOWN' : 'TAXONOMY_INVALID',
      ] as const,
  )) {
    await writeFile(
      run.proposal,
      JSON.stringify({ categories: {}, assignments }),
    );
    await assert.rejects(validateTaxonomy(f.work, run.id), { code });
  }
  await writeFile(
    run.proposal,
    JSON.stringify({
      categories: {},
      assignments: { [r.id + '@' + r.revision]: [] },
    }),
  );
  const v = await validateTaxonomy(f.work, run.id);
  const approval = await taxonomyApprove(
    f,
    run.id,
    v.seal!,
    'unclassification',
  );
  await applyTaxonomy(f.work, run.id, v.seal!, approval);
  assert.equal((await memoryCategory(f.memory, 'design')).total, 0);
  assert.equal(
    (await memoryRead(f.memory, r.reference)).content,
    before.content,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(f.work, 'taxonomy.json'), 'utf8')),
    { design: 'Scelte progettuali' },
  );
});

test('taxonomy blocks obsolete replies, pending curator batches and independently changed canonical metadata', async (t) => {
  const f = await fixture(t);
  await f.commit(2, 'Existing.');
  const run = await taxonomyStart(f, 'guards');
  await writeFile(
    run.proposal,
    JSON.stringify({
      categories: { design: 'Scelte progettuali' },
      assignments: {},
    }),
  );
  const v = await validateTaxonomy(f.work, run.id);
  const old = await taxonomyApprove(f, run.id, v.seal!, 'old');
  await taxonomyEvent(
    f,
    'user_message',
    'Una nuova richiesta di lavoro.',
    'later',
  );
  await assert.rejects(applyTaxonomy(f.work, run.id, v.seal!, old), {
    code: 'TAXONOMY_APPROVAL_REQUIRED',
  });
  const fresh = await taxonomyApprove(f, run.id, v.seal!, 'new');
  await f.proposal(4, 'Pending materialization.');
  await assert.rejects(applyTaxonomy(f.work, run.id, v.seal!, fresh), {
    code: 'CURATOR_PENDING_EXISTS',
  });
  assert.ok(await readFile(join(f.work, 'pending.json')));
  await writeFile(
    join(f.work, 'taxonomy.json'),
    JSON.stringify({ external: 'Registro modificato' }),
  );
  await assert.rejects(validateTaxonomy(f.work, run.id), {
    code: 'TAXONOMY_STALE_PROPOSAL',
  });
});

test('taxonomy crash boundaries and interrupted recovery complete from the same authorized journal', async (t) => {
  for (const boundary of [
    '/taxonomy-changes/',
    '/topics/category-',
    '/taxonomy-associations.json',
  ])
    await t.test(boundary, async (t) => {
      const f = await fixture(t);
      await f.commit(2, 'Recoverable.');
      const run = await taxonomyStart(f, 'crash');
      await writeFile(
        run.proposal,
        JSON.stringify({
          categories: { design: 'Scelte progettuali' },
          assignments: {},
        }),
      );
      const v = await validateTaxonomy(f.work, run.id),
        approval = await taxonomyApprove(f, run.id, v.seal!, 'show');
      const before = await readFile(join(f.work, 'checkpoint.json'));
      function crash(target: string, recovery = false) {
        const script = `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const rename=fs.rename;fs.rename=async function(a,b){await rename.call(this,a,b);if(String(b).replaceAll('\\\\','/').includes(${JSON.stringify(target)}))process.exit(73)};syncBuiltinESMExports();const{applyTaxonomy}=await import(${JSON.stringify(pathToFileURL(resolve('src/curator.ts')).href)});await applyTaxonomy(${JSON.stringify(f.work)},${JSON.stringify(run.id)},${JSON.stringify(v.seal)},${approval});`;
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', script],
          { encoding: 'utf8' },
        );
        assert.equal(
          result.status,
          73,
          `${recovery ? 'recovery' : 'apply'}: ${result.stderr}`,
        );
      }
      crash(boundary);
      if (boundary === '/taxonomy-changes/') {
        await assert.rejects(prepareTaxonomy(f.work), {
          code: 'CURATOR_RECOVERY_REQUIRED',
        });
        await assert.rejects(validateTaxonomy(f.work, run.id), {
          code: 'CURATOR_RECOVERY_REQUIRED',
        });
        crash('/topics/category-', true);
      }
      await rm(run.proposal);
      await memoryState(f.memory);
      assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), before);
      assert.equal(
        (await applyTaxonomy(f.work, run.id, v.seal!, approval)).status,
        'already_applied',
      );
      assert.match(
        await readFile(join(f.work, 'topics/category-design.md'), 'utf8'),
        /Scelte progettuali/,
      );
    });
});

test('taxonomy CLI lifecycle and category navigation run through source and optional compiled entrypoints', async (t) => {
  for (const entry of [
    resolve('src/index.ts'),
    ...(process.env.KNOWNEX_TEST_COMPILED_CLI === '1'
      ? [resolve('dist/index.js')]
      : []),
  ])
    await t.test(entry, async (t) => {
      const f = await fixture(t);
      await f.commit(2, 'CLI subject.');
      const cp = await readFile(join(f.work, 'checkpoint.json'));
      await taxonomyEvent(f, 'user_message', '$knownex-taxonomy', 'cli');
      function cli(args: string[]) {
        const out = spawnSync(process.execPath, [entry, ...args], {
          encoding: 'utf8',
        });
        assert.equal(out.status, 0, out.stderr);
        return JSON.parse(out.stdout);
      }
      const p = cli(['taxonomy', 'prepare', '--work', f.work]);
      const packet = JSON.parse(
        await readFile(join(p.run, 'packet.json'), 'utf8'),
      );
      const r = packet.revisions[0];
      await writeFile(
        p.proposal,
        JSON.stringify({
          categories: { design: 'Scelte progettuali' },
          assignments: { [r.id + '@' + r.revision]: ['design'] },
        }),
      );
      const v = cli(['taxonomy', 'validate', '--work', f.work, '--run', p.id]);
      const approval = await taxonomyApprove(f, p.id, v.seal, 'cli-display');
      const feedBefore = await readFile(f.feed);
      assert.equal(
        cli([
          'taxonomy',
          'apply',
          '--work',
          f.work,
          '--run',
          p.id,
          '--confirm',
          v.seal,
          '--approval-event',
          String(approval),
        ]).status,
        'applied',
      );
      assert.equal(
        cli([
          'memory',
          'category',
          'design',
          '--memory',
          f.memory,
          '--limit',
          '1',
        ]).results[0].revision,
        r.revision,
      );
      assert.equal(
        cli(['taxonomy', 'rebuild', '--work', f.work]).status,
        'noop',
      );
      assert.deepEqual(await readFile(f.feed), feedBefore);
      assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), cp);
    });
});

function interrupt(work: string, seal: string, boundary: string, io = false) {
  const source = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.rename; fs.rename=async function(a,b){await original.call(this,a,b); if(String(b).replaceAll('\\\\','/').includes(${JSON.stringify(boundary)})){${io ? "throw Object.assign(new Error('injected'),{code:'EIO'});" : 'process.exit(73);'}}}; syncBuiltinESMExports(); const {applyCurator}=await import(${JSON.stringify(pathToFileURL(resolve('src/curator.ts')).href)});try{await applyCurator(${JSON.stringify(work)},${JSON.stringify(seal)});}catch(e){if(e.code==='EIO')process.exit(74);throw e;}`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', source],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, io ? 74 : 73, child.stderr);
}
test('interrupted revision publication and interrupted recovery remain authorized, complete and idempotent without staging', async (t) => {
  for (const boundary of [
    '--b-',
    '--r-',
    '/revisions/c-2.json',
    'memory/HISTORY.md',
    'checkpoint.json',
  ])
    await t.test(boundary, async (t) => {
      const f = await fixture(t),
        p = await f.proposal(2, 'Recovered.'),
        v = await validateCurator(f.work);
      interrupt(f.work, v.seal, boundary);
      const record = JSON.parse(
        await readFile(join(f.work, 'apply.json'), 'utf8'),
      ).record;
      await rm(p.proposal!);
      await rm(v.candidate, { recursive: true });
      if (boundary === '--b-') interrupt(f.work, v.seal, '--r-');
      const state = await memoryState(f.memory);
      assert.equal(state, record.next['STATE.md']);
      assert.match((await memoryRead(f.memory, id)).content, /Recovered/);
      assert.equal(
        (await memoryRead(f.memory, id, { at: 1 })).content.includes(
          'Original',
        ),
        true,
      );
      const history = await readFile(join(f.memory, 'HISTORY.md'));
      const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
      await applyCurator(f.work, v.seal);
      assert.deepEqual(await readFile(join(f.memory, 'HISTORY.md')), history);
      assert.deepEqual(
        await readFile(join(f.work, 'checkpoint.json')),
        checkpoint,
      );
      await assert.rejects(readFile(join(f.work, 'pending.json')), {
        code: 'ENOENT',
      });
    });
});

test('legacy v1 apply recovery completes before v3 baseline adoption; confirmed HISTORY remains an exact prefix', async (t) => {
  const f = await fixture(t),
    p = await f.proposal(2, 'Ignored proposal.');
  const before = await f.checkpoint();
  const previous: Record<string, string> = {};
  for (const n of ['STATE.md', 'HISTORY.md', 'knowledge/topic.md'])
    previous[n] = await readFile(join(f.memory, n), 'utf8');
  const run = JSON.parse(await readFile(join(p.run!, 'run.json'), 'utf8'));
  const next: Record<string, string> = {
    ...previous,
    'STATE.md': previous['STATE.md']!.replace(
      '# Project',
      '# Legacy recovered',
    ),
  };
  next['HISTORY.md'] += historyAppendix(
    previous['HISTORY.md']!,
    previous['STATE.md']!,
    2,
    2,
    run.last.event.capturedAt,
    '../unused.jsonl',
    { summary: 'Legacy', topics: ['Legacy'], transition: 'Legacy recovery' },
  );
  next['HISTORY.md'] = next['HISTORY.md']!.replace(
    '../unused.jsonl',
    '../../feed/' + basename(f.feed),
  );
  const after = {
    ...before,
    sequence: 2,
    checksum: run.last.checksum,
    memoryHash: digest(next),
  };
  const record = {
    version: 1,
    runId: run.id,
    seal: 'a'.repeat(64),
    action: 'update',
    before,
    after,
    previous,
    next,
  };
  await writeFile(
    join(f.work, 'apply.json'),
    JSON.stringify({ record, checksum: hash(JSON.stringify(record)) }),
  );
  await writeFile(join(f.memory, 'STATE.md'), next['STATE.md']!);
  assert.match(await memoryState(f.memory), /Legacy recovered/);
  assert.equal((await f.checkpoint()).version, 2);
  const legacyHistory = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  await f.commit(4, 'Versioned after legacy recovery.');
  assert.equal((await f.checkpoint()).version, 3);
  assert.ok(
    (await readFile(join(f.memory, 'HISTORY.md'), 'utf8')).startsWith(
      legacyHistory,
    ),
  );
  assert.match((await memoryRead(f.memory, id, { at: 2 })).content, /Original/);
  await assert.rejects(memoryRead(f.memory, id, { at: 1 }), {
    code: 'KNOWLEDGE_LEGACY_HISTORY',
  });
});

test('I/O failure after a revision rename preserves the old checkpoint and pending until recovery', async (t) => {
  const f = await fixture(t),
    p = await f.proposal(2, 'I/O recovery.'),
    v = await validateCurator(f.work);
  interrupt(f.work, v.seal, '--r-', true);
  assert.equal((await f.checkpoint()).sequence, 1);
  assert.ok(await readFile(join(f.work, 'pending.json')));
  await memoryState(f.memory);
  assert.equal((await f.checkpoint()).sequence, 2);
  assert.match((await memoryRead(f.memory, id)).content, /I\/O recovery/);
  assert.deepEqual(await applyCurator(f.work, v.seal), {
    status: 'applied',
    through: 2,
    action: 'update',
  });
  assert.ok(p.run);
});

test('publication pins cross-Knowledge links and rejects invalid head references without changing confirmed memory', async (t) => {
  const f = await fixture(t),
    one = await f.commit(
      2,
      'First.',
      '[Evidence](topic.md) [Navigate](topic.md)<!-- knownex:current -->',
    );
  const second = await memoryRead(
    f.memory,
    secondId +
      '@' +
      one.cp.knowledgeVersions.heads['knowledge/second.md'].revision,
  );
  const evidence = second.content.match(/\[Evidence\]\(([^)]+)\)/)![1]!;
  const navigate = second.content.match(/\[Navigate\]\(([^)]+)\)/)![1]!;
  const evidenceFile = resolve(
    dirname(resolve(f.memory, second.path)),
    evidence,
  );
  assert.match(await readFile(evidenceFile, 'utf8'), /First/);
  assert.equal(
    resolve(dirname(resolve(f.memory, second.path)), navigate),
    join(f.memory, 'knowledge/topic.md'),
  );
  const evidenceBytes = await readFile(evidenceFile);
  await f.commit(4, 'Later.');
  assert.deepEqual(await readFile(evidenceFile), evidenceBytes);
  assert.match(
    await readFile(
      resolve(dirname(resolve(f.memory, second.path)), navigate),
      'utf8',
    ),
    /Later/,
  );
  const cp = await f.checkpoint();
  cp.knowledgeVersions.heads['knowledge/topic.md'].id = secondId;
  await writeFile(join(f.work, 'checkpoint.json'), JSON.stringify(cp));
  await assert.rejects(memoryRead(f.memory, id), {
    code: 'CURATOR_RECOVERY_INVALID',
  });
});

test('old pending validation requires revalidation, not a new batch, consent or LLM proposal', async (t) => {
  const f = await fixture(t),
    p = await f.proposal(2, 'Revalidated.'),
    v = await validateCurator(f.work);
  const file = join(p.run!, 'validated.json');
  const old = JSON.parse(await readFile(file, 'utf8'));
  delete old.versioning;
  await writeFile(file, JSON.stringify(old));
  await assert.rejects(applyCurator(f.work, v.seal), {
    code: 'CURATOR_REVALIDATION_REQUIRED',
  });
  assert.equal((await f.checkpoint()).sequence, 1);
  const again = await validateCurator(f.work);
  assert.equal(again.seal, v.seal);
  await applyCurator(f.work, again.seal);
  assert.match((await memoryRead(f.memory, id)).content, /Revalidated/);
});
