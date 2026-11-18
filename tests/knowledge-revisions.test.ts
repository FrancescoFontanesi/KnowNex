import assert from 'node:assert/strict';
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
import { appendFeedEvent } from '../src/feed/feed.ts';
import {
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  prepareTaxonomy,
  validateTaxonomy,
  applyTaxonomy,
  rebuildTaxonomy,
  emptyMemory,
} from '../src/curation/curator.ts';
import {
  memoryFind,
  memoryRead,
  memoryState,
  memoryCategory,
} from '../src/memory/navigator.ts';

const id = 'kn-00000000-0000-4000-8000-000000000001';
const secondId = 'kn-00000000-0000-4000-8000-000000000002';
const noteId = (through: number) =>
  'kn-00000000-0000-4000-8000-' + String(100 + through).padStart(12, '0');
/** E0 is the empty memory; a first real checkpoint at E1 writes STATE and the topic note. */
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
  const feed = join(feedDir, 'project.jsonl');
  await mkdir(seed, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(seed, name), text);
  await initCurator(work, seed, feed, 0);
  const first = await prepareCurator(work, undefined, { through: 1 });
  await writeFile(
    first.proposal!,
    JSON.stringify({
      action: 'update',
      state: '# Project\n\n[Topic](knowledge/topic.md) [E001]\n',
      history: {
        summary: 'Seed',
        topics: ['Topic'],
        transition: 'Initial state.',
      },
      knowledge: {
        'knowledge/topic.md':
          '---\nid: ' +
          id +
          '\ntype: knowledge\n---\n\n# Topic\n\nOriginal caffè 日本語 🧠 e\u0301. [E001]\n',
      },
    }),
  );
  await applyCurator(work, (await validateCurator(work)).seal);
  const memory = join(work, 'memory');
  const checkpoint = async () =>
    JSON.parse(await readFile(join(work, 'checkpoint.json'), 'utf8'));
  async function proposal(
    through: number,
    body?: string,
    extra?: string,
    noop = false,
    stateLink = '',
  ) {
    const p = await prepareCurator(work, undefined, {
      through,
      context: ['knowledge/H000001/topic.md'],
    });
    const packet = JSON.parse(
      await readFile(join(p.run!, 'packet.json'), 'utf8'),
    );
    const knowledge: Record<string, string> = {};
    // Knowledge is a log: a curation only adds notes, so `body` becomes a new note per checkpoint.
    if (body !== undefined)
      knowledge[`knowledge/note-${through}.md`] =
        '---\nid: ' +
        noteId(through) +
        '\ntype: knowledge\n---\n\n# Note ' +
        through +
        '\n\n' +
        body +
        ` [E00${through}]\n`;
    if (extra !== undefined)
      knowledge['knowledge/second.md'] =
        '---\nid: ' +
        secondId +
        '\ntype: knowledge\n---\n\n# Second\n' +
        extra +
        ` [E00${through}]\n`;
    await writeFile(
      p.proposal!,
      JSON.stringify(
        noop
          ? { action: 'noop' }
          : {
              action: 'update',
              state: `# Project\n\n[Topic](knowledge/H000001/topic.md) [Current](knowledge/H000001/topic.md)<!-- knownex:current --> [E00${through}]\n`,
              history: {
                summary: 'Update',
                topics: ['Topic'],
                transition:
                  'New revision; [Topic](knowledge/H000001/topic.md).',
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
    stateLink = '',
  ) {
    const p = await proposal(through, body, extra, noop, stateLink),
      v = await validateCurator(work);
    await applyCurator(work, v.seal);
    return { p, v, cp: await checkpoint() };
  }
  return { root, work, memory, feed, proposal, commit, checkpoint };
}

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
  // The Curator reads approved categories from WINDOW.md, not from packet.json.
  const window = await readFile(join(p.proposal!, '..', 'WINDOW.md'), 'utf8');
  for (const [key, description] of Object.entries(taxonomy))
    assert.ok(window.includes(`- \`${key}\`: ${description}`), key);
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
    { 'knowledge/note-2.md': 'invented' },
    { '../outside.md': 'architecture' },
    { 'knowledge/note-2.md': '../architecture' },
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
        'knowledge/note-2.md': 'architecture',
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
  const topic = await memoryRead(f.memory, noteId(2));
  assert.ok('versionReference' in topic);
  assert.equal(topic.category, 'architecture');
  assert.equal(topic.history, 'H000002');
  assert.match(topic.versionReference!, /H000002\/architecture\//);
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
    memoryRead(f.memory, topic.versionReference!.replace('H000002', 'H000999')),
    { code: 'MEMORY_NOT_FOUND' },
  );
  assert.deepEqual(
    (await memoryFind(f.memory, 'architecture', 'knowledge')).map((r) => r.id),
    [noteId(2)],
  );
  assert.equal((await memoryFind(f.memory, 'H000002', 'knowledge')).length, 2);
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
  await assert.rejects(readdir(join(f.work, 'revisions/H000003')), {
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
    later.cp.knowledgeVersions.heads['knowledge/H000003/note-6.md'].file,
    /^H000003\/note-6--kn-/,
  );
  // The name prefix is for people browsing the vault; the reader still authenticates the path.
  const physical =
    'knowledge/' +
    later.cp.knowledgeVersions.heads['knowledge/H000003/note-6.md'].file;
  assert.ok(
    (await memoryRead(f.memory, physical)).path.endsWith(
      later.cp.knowledgeVersions.heads['knowledge/H000003/note-6.md'].file,
    ),
  );
  await assert.rejects(
    memoryRead(f.memory, physical.replace('/note-6--', '/other--')),
    { code: 'MEMORY_NOT_FOUND' },
  );
  await assert.rejects(
    memoryRead(f.memory, physical.replace('/note-6--', '/')),
    { code: 'MEMORY_NOT_FOUND' },
  );
  assert.deepEqual(
    later.cp.knowledgeVersions.heads['knowledge/H000002/second.md'],
    first.knowledgeVersions.heads['knowledge/H000002/second.md'],
  );
  assert.equal((await memoryRead(f.memory, noteId(6))).category, undefined);
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
        'knowledge/topic.md':
          unchanged.packet.context['knowledge/H000001/topic.md'],
      },
      categories: { 'knowledge/topic.md': 'experiments' },
    }),
  );
  // An existing note is never rewritten, not even to recategorize it.
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_NOTE_ID_DUPLICATE',
  });
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
  await symlink(
    outside,
    join(f.work, 'revisions/H000002'),
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
  const source = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const mkdir=fs.mkdir;fs.mkdir=async function(...args){const result=await mkdir.apply(this,args);if(String(args[0]).replaceAll('\\\\','/').endsWith('/H000002'))process.exit(73);return result;};syncBuiltinESMExports();const {applyCurator}=await import(${JSON.stringify(pathToFileURL(resolve('src/curation/curator.ts')).href)});await applyCurator(${JSON.stringify(f.work)},${JSON.stringify(v.seal)});`;
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
    (await memoryRead(f.memory, noteId(2))).content.includes(
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
  return (
    await appendFeedEvent(dirname(f.feed), {
      type,
      sessionId: 's',
      turnId: turn,
      text,
      hook: type === 'user_message' ? 'UserPromptSubmit' : 'Stop',
    })
  ).sequence;
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
  // Revisions at two checkpoints: the topic note (E1) and a later note (E6).
  await f.commit(6, 'Measured in 50 s.');
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
    (r: { through: number }) => r.through === 1 || r.through === 6,
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
        'Tema ricorrente nei checkpoint 1 e 6; nessuna sovrapposizione nota.',
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
  assert.equal(last.results[0]!.through, 6);
  assert.equal(last.results[0]!.classification, 'retroactive');
  assert.ok(
    (await memoryRead(f.memory, last.results[0]!.reference)).content.includes(
      '50 s',
    ),
  );
  assert.deepEqual(
    (await memoryFind(f.memory, 'methods', 'knowledge'))
      .map((r) => r.id)
      .sort(),
    [id, noteId(6)],
  );
  const index = await readFile(
    join(f.work, 'topics/category-methods.md'),
    'utf8',
  );
  assert.ok(index.indexOf('Checkpoint 1') < index.indexOf('Checkpoint 6'));
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
  await f.commit(8, 'Normal curator still works.');
  assert.equal((await f.checkpoint()).sequence, 8);
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
  const { sequence: wrong } = await appendFeedEvent(dirname(f.feed), {
    type: 'user_message',
    sessionId: 'other',
    turnId: 'wrong-session',
    text: 'Approvo',
    hook: 'UserPromptSubmit',
  });
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
  const script = `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const original=fs.rename;fs.rename=async function(a,b){await original.call(this,a,b);if(String(b).replaceAll('\\\\','/').endsWith('/taxonomy.json'))process.exit(73)};syncBuiltinESMExports();const{applyTaxonomy}=await import(${JSON.stringify(pathToFileURL(resolve('src/curation/curator.ts')).href)});await applyTaxonomy(${JSON.stringify(f.work)},${JSON.stringify(p.id)},${JSON.stringify(v.seal)},${approval});`;
  const crashed = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  assert.equal(crashed.status, 73, crashed.stderr);
  await assert.rejects(
    (await import('../src/curation/curator.ts')).readPendingEvents(
      f.work,
      f.feed,
    ),
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
  const f = await fixture(t);
  await f.commit(2, 'Detail kept locale.');
  const unrelated =
    'H000002/stray--kn-00000000-0000-4000-8000-000000000099--r-9-9-00000000-0000-4000-8000-000000000099.md';
  await writeFile(
    join(f.work, 'revisions', unrelated),
    'unrelated malformed archive entry',
  );
  assert.equal((await memoryFind(f.memory, 'locale', 'knowledge')).length, 1);
  await assert.rejects(memoryRead(f.memory, '../revisions/' + unrelated), {
    code: 'MEMORY_NOT_FOUND',
  });
  const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
  // The exact revision reference resolves to the archived file, not the memory copy.
  const archived = async (noteId: string) => {
    const current = await memoryRead(f.memory, noteId);
    return {
      revision: current.revision,
      path: resolve(
        f.memory,
        (await memoryRead(f.memory, noteId + '@' + current.revision)).path,
      ),
    };
  };
  const head = (await archived(id)).path,
    bytes = await readFile(head);
  await appendFile(head, 'corruption');
  await assert.rejects(memoryRead(f.memory, id), {
    code: 'KNOWLEDGE_REVISION_CHANGED',
  });
  await writeFile(head, bytes);
  const note = await archived(noteId(2));
  await rm(note.path);
  await assert.rejects(memoryRead(f.memory, noteId(2) + '@' + note.revision), {
    code: 'KNOWLEDGE_REVISION_MISSING',
  });
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), checkpoint);
});

test('archive collisions and symlink boundaries are rejected before confirmation', async (t) => {
  const f = await fixture(t),
    p = await f.proposal(2, 'Changed.');
  const archive = join(f.work, 'revisions');
  await mkdir(join(archive, 'H000002'), { recursive: true });
  const file = join(
    archive,
    'H000002',
    'note-2--' + noteId(2) + '--r-' + basename(p.run!) + '.md',
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
    JSON.stringify({ ...raw, categories: { 'knowledge/note-2.md': 'design' } }),
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
        const script = `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const rename=fs.rename;fs.rename=async function(a,b){await rename.call(this,a,b);if(String(b).replaceAll('\\\\','/').includes(${JSON.stringify(target)}))process.exit(73)};syncBuiltinESMExports();const{applyTaxonomy}=await import(${JSON.stringify(pathToFileURL(resolve('src/curation/curator.ts')).href)});await applyTaxonomy(${JSON.stringify(f.work)},${JSON.stringify(run.id)},${JSON.stringify(v.seal)},${approval});`;
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
  const source = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.rename; fs.rename=async function(a,b){await original.call(this,a,b); if(String(b).replaceAll('\\\\','/').includes(${JSON.stringify(boundary)})){${io ? "throw Object.assign(new Error('injected'),{code:'EIO'});" : 'process.exit(73);'}}}; syncBuiltinESMExports(); const {applyCurator}=await import(${JSON.stringify(pathToFileURL(resolve('src/curation/curator.ts')).href)});try{await applyCurator(${JSON.stringify(work)},${JSON.stringify(seal)});}catch(e){if(e.code==='EIO')process.exit(74);throw e;}`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', source],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, io ? 74 : 73, child.stderr);
}
test('interrupted revision publication and interrupted recovery remain authorized, complete and idempotent without staging', async (t) => {
  for (const boundary of [
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
      const state = await memoryState(f.memory);
      assert.equal(state, record.next['STATE.md']);
      assert.match(
        (await memoryRead(f.memory, noteId(2))).content,
        /Recovered/,
      );
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

test('I/O failure after a revision rename preserves the old checkpoint and pending until recovery', async (t) => {
  const f = await fixture(t),
    p = await f.proposal(2, 'I/O recovery.'),
    v = await validateCurator(f.work);
  interrupt(f.work, v.seal, '--r-', true);
  assert.equal((await f.checkpoint()).sequence, 1);
  assert.ok(await readFile(join(f.work, 'pending.json')));
  await memoryState(f.memory);
  assert.equal((await f.checkpoint()).sequence, 2);
  assert.match(
    (await memoryRead(f.memory, noteId(2))).content,
    /I\/O recovery/,
  );
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
      '[Evidence](note-2.md) [Navigate](H000001/topic.md)<!-- knownex:current -->',
    );
  const second = await memoryRead(
    f.memory,
    secondId +
      '@' +
      one.cp.knowledgeVersions.heads['knowledge/H000002/second.md'].revision,
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
    join(f.memory, 'knowledge/H000001/topic.md'),
  );
  const evidenceBytes = await readFile(evidenceFile);
  await f.commit(4, 'Later.');
  assert.deepEqual(await readFile(evidenceFile), evidenceBytes);
  assert.match(
    await readFile(
      resolve(dirname(resolve(f.memory, second.path)), navigate),
      'utf8',
    ),
    /Original/,
  );
  const cp = await f.checkpoint();
  cp.knowledgeVersions.heads['knowledge/H000001/topic.md'].id = secondId;
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
  assert.match((await memoryRead(f.memory, noteId(2))).content, /Revalidated/);
});

test('new checkpoint folders are named after the HISTORY entry of the same checkpoint, noops included', async (t) => {
  const f = await fixture(t);
  await f.commit(2, 'Revision two.');
  await f.commit(4, undefined, undefined, true);
  const last = await f.commit(6, 'Revision six.', 'Independent result');
  const history = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  const entries = [...history.matchAll(/^- \[(H\d{6})\]/gm)].map((m) => m[1]);
  assert.deepEqual(entries, ['H000001', 'H000002', 'H000003']);
  const heads = last.cp.knowledgeVersions.heads;
  for (const name of [
    'knowledge/H000003/note-6.md',
    'knowledge/H000003/second.md',
  ])
    assert.equal(heads[name].file.split('/')[0], entries.at(-1), name);
  // The window of that HISTORY entry links the notes published in the same-named folder.
  const window = await readFile(
    join(f.memory, 'history', entries.at(-1) + '.md'),
    'utf8',
  );
  for (const name of [
    'knowledge/H000003/note-6.md',
    'knowledge/H000003/second.md',
  ])
    assert.ok(window.includes(heads[name].file), name);
});

test('read reports newer notes linking an old note (linkedByNewer) without touching memory', async (t) => {
  const f = await fixture(t);
  // The same-checkpoint link (second -> note-2) and the STATE link never count as successors.
  await f.commit(2, 'Prima decisione.', '[Evidenza](note-2.md)');
  const first = await memoryRead(f.memory, 'knowledge/H000002/note-2.md');
  assert.equal(first.linkedByNewer, undefined);
  await f.commit(
    4,
    'Seconda decisione, supera [la prima](H000002/note-2.md).',
    undefined,
    false,
    ' [Nota](knowledge/H000002/note-2.md)',
  );
  await f.commit(6, 'Terza, non linka nulla.');
  const stateBefore = await memoryState(f.memory);
  const old = await memoryRead(f.memory, 'knowledge/H000002/note-2.md');
  assert.deepEqual(
    (old.linkedByNewer as { id: string; history: string }[]).map((n) => [
      n.id,
      n.history,
    ]),
    [[noteId(4), 'H000003']],
  );
  assert.equal(old.content, first.content);
  // The pinned reference of the old revision gets the same field; newer notes have none.
  const exact = (await memoryRead(f.memory, noteId(2))) as {
    versionReference: string;
  };
  assert.deepEqual(
    (await memoryRead(f.memory, exact.versionReference)).linkedByNewer,
    old.linkedByNewer,
  );
  assert.equal(
    (await memoryRead(f.memory, 'knowledge/H000003/note-4.md')).linkedByNewer,
    undefined,
  );
  assert.equal(await memoryState(f.memory), stateBefore);
});
