import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { release as osRelease, tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import {
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  abandonCurator,
  readPendingEvents,
} from '../src/curator.ts';
import { historySegments, historyAppendix } from '../src/history.ts';
import { memoryState, memoryFind, memoryRead } from '../src/navigator.ts';

test('S3 exact empty seed initializes at zero without rewriting the original seed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-s3-seed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, 'seed'),
    work = join(root, 'curator'),
    feed = join(root, 'project.jsonl');
  await mkdir(seed);
  const old =
    '# Stato iniziale\n\nNessun evento e ancora rappresentato da un checkpoint curator.\n';
  await writeFile(join(seed, 'STATE.md'), old);
  await writeFile(join(seed, 'HISTORY.md'), '# History\n');
  await writeFile(feed, '');
  await initCurator(work, seed, feed, 0);
  assert.equal(await readFile(join(seed, 'STATE.md'), 'utf8'), old);
  assert.equal(
    JSON.parse(await readFile(join(work, 'checkpoint.json'), 'utf8')).sequence,
    0,
  );
  assert.match(
    await memoryState(join(work, 'memory')),
    /Nessuna informazione materializzata/,
  );
});

async function fixture(t: TestContext, twoNotes = false) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-r1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const feedDir = join(root, 'feed'),
    memory = join(root, 'initial'),
    work = join(root, 'work');
  async function event(turnId: string) {
    await appendFeedEvent(feedDir, {
      type: 'user_message',
      sessionId: 's',
      turnId,
      text: 'distinct turn',
      hook: 'UserPromptSubmit',
    });
  }
  for (const turn of ['one', 'two', 'three']) await event(turn);
  const feed = join(
    feedDir,
    createHash('sha256').update('s').digest('hex') + '.jsonl',
  );
  const directive = join(root, 'directive.md');
  await writeFile(
    directive,
    'Preserve the open task and explain the transition.',
  );
  await mkdir(join(memory, 'knowledge'), { recursive: true });
  await writeFile(
    join(memory, 'STATE.md'),
    '# State\n\nOpen: preserve task. [E001](../feed/' +
      feed.split(/[\\/]/).at(-1) +
      ')\n\n[Topic](knowledge/topic.md)\n',
  );
  await writeFile(join(memory, 'HISTORY.md'), '# History\n');
  await writeFile(
    join(memory, 'knowledge/topic.md'),
    '---\nid: kn-00000000-0000-4000-8000-000000000001\ntype: knowledge\n---\n\n# Topic\n\nTechnical detail. [E001](../../feed/' +
      feed.split(/[\\/]/).at(-1) +
      ')\n',
  );
  if (twoNotes)
    await writeFile(
      join(memory, 'knowledge/second.md'),
      (await readFile(join(memory, 'knowledge/topic.md'), 'utf8'))
        .replace('000000000001', '000000000002')
        .replace('# Topic', '# Second'),
    );
  await initCurator(work, memory, feed, 1);
  async function propose(through = 2, extra: Record<string, unknown> = {}) {
    const prep = await prepareCurator(work, directive, {
      through,
      context: twoNotes
        ? ['knowledge/topic.md', 'knowledge/second.md']
        : ['knowledge/topic.md'],
    });
    assert.ok(prep.run);
    const packet = JSON.parse(
      await readFile(join(prep.run, 'packet.json'), 'utf8'),
    );
    const proposal = {
      action: 'update',
      state:
        '# State\n\nOpen: preserve task. New advancement. [E00' +
        through +
        '](' +
        packet.feed +
        ')\n\n[Topic](knowledge/topic.md)\n',
      history: {
        summary: 'Advancement',
        topics: ['Memory'],
        transition: 'Work advances; task remains open.',
      },
      knowledge: {},
      ...extra,
    };
    await writeFile(prep.proposal!, JSON.stringify(proposal));
    return { ...prep, proposalFile: prep.proposal, packet, proposal };
  }
  return {
    root,
    work,
    memory: join(work, 'memory'),
    initialMemory: memory,
    feed,
    directive,
    event,
    propose,
  };
}

async function pinnedBaselineState(work: string, state: string) {
  const { record } = JSON.parse(
    await readFile(join(work, 'apply.json'), 'utf8'),
  );
  const file = record.revisionFiles.find((p: { file: string }) =>
    p.file
      .split('/')
      .at(-1)!
      .startsWith('kn-00000000-0000-4000-8000-000000000001--b-'),
  ).file;
  assert.match(
    await readFile(join(work, 'revisions', file), 'utf8'),
    /id: kn-00000000-0000-4000-8000-000000000001/,
  );
  return state.replace('knowledge/topic.md', '../revisions/' + file);
}

test('STATE sizes across the old threshold validate, confirm and noop without losing linked knowledge', async (t) => {
  const f = await fixture(t),
    p = await f.propose();
  assert.equal(p.packet.stateBudget, undefined);
  const first = await validateCurator(f.work);
  const feed = await readFile(f.feed);
  const knowledge = await readFile(join(f.memory, 'knowledge/topic.md'));
  let latest = first;
  for (const size of [6143, 6144, 6145, 24576]) {
    const padding = size - first.stateBytes;
    const state =
      p.proposal.state +
      '🧠'.repeat(Math.floor(padding / 4)) +
      'x'.repeat(padding % 4);
    await writeFile(p.proposalFile!, JSON.stringify({ ...p.proposal, state }));
    latest = await validateCurator(f.work);
    assert.equal(latest.stateBytes, size); // Final pinned text, not the raw proposal.
    assert.equal('stateBudgetBytes' in latest, false);
  }
  // Prepared packets and validations from the former policy remain usable:
  // their obsolete diagnostic metadata imposes no limit and does not change the seal.
  await writeFile(
    join(p.run!, 'packet.json'),
    JSON.stringify({ ...p.packet, stateBudget: { maxBytes: 6144 } }),
  );
  const approvalFile = join(p.run!, 'validated.json');
  const approval = JSON.parse(await readFile(approvalFile, 'utf8'));
  await writeFile(
    approvalFile,
    JSON.stringify({ ...approval, stateBudgetBytes: 6144 }),
  );
  await assert.rejects(applyCurator(f.work, first.seal), {
    code: 'CURATOR_CONFIRMATION_REQUIRED',
  });
  await applyCurator(f.work, latest.seal);
  const confirmed = await memoryState(f.memory);
  assert.equal(Buffer.byteLength(confirmed), 24576);
  const target = /\[Topic\]\(([^)]+)\)/.exec(confirmed)![1]!;
  assert.ok(
    (await memoryRead(f.memory, target)).content.includes('Technical detail.'),
  );
  assert.deepEqual(
    await readFile(join(f.memory, 'knowledge/topic.md')),
    knowledge,
  );
  assert.deepEqual(await readFile(f.feed), feed);
  const next = await f.propose(3);
  await writeFile(next.proposalFile!, JSON.stringify({ action: 'noop' }));
  const noop = await validateCurator(f.work);
  assert.equal(noop.stateBytes, 24576);
  await applyCurator(f.work, noop.seal);
  assert.equal(await memoryState(f.memory), confirmed);
});

test('legacy extended STATE remains readable and authorized noop recovery and replay remain intact', async (t) => {
  const f = await fixture(t);
  const legacyState =
    '# Legacy extended\n\n' +
    'é'.repeat(10000) +
    '\n[E001](../feed/' +
    basename(f.feed) +
    ')\n';
  await writeFile(join(f.initialMemory, 'STATE.md'), legacyState);
  const work = join(f.root, 'legacy');
  await initCurator(work, f.initialMemory, f.feed, 1);
  const memory = join(work, 'memory');
  const confirmed = await memoryState(memory);
  assert.ok(Buffer.byteLength(confirmed) > 6144);
  const prepared = await prepareCurator(work, undefined, { through: 2 });
  await writeFile(prepared.proposal!, JSON.stringify({ action: 'noop' }));
  const validated = await validateCurator(work);
  const crashedPid = crashApply(work, validated.seal, 'apply.json');
  const crashEndedAt = Date.now();
  assert.equal(await memoryState(memory), confirmed);
  assert.equal(
    JSON.parse(await readFile(join(work, 'checkpoint.json'), 'utf8')).sequence,
    2,
  );
  assert.deepEqual(await applyCurator(work, validated.seal), {
    status: 'applied',
    action: 'noop',
    through: 2,
  });
  const next = await prepareCurator(work, undefined, { through: 3 });
  await writeFile(next.proposal!, JSON.stringify({ action: 'noop' }));
  const noop = await validateCurator(work);
  try {
    await applyCurator(work, noop.seal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'DESTINATION_BUSY') {
      const owner = JSON.parse(await readFile(f.feed + '.lock', 'utf8'));
      const processInfo =
        process.platform === 'win32'
          ? spawnSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-Command',
                `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(owner.pid)}" | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress`,
              ],
              { encoding: 'utf8', windowsHide: true },
            ).stdout.trim()
          : '';
      t.diagnostic(
        JSON.stringify({
          crashedPid,
          crashEndedAt,
          owner,
          currentPid: process.pid,
          processInfo,
        }),
      );
    }
    throw error;
  }
  assert.equal(await memoryState(memory), confirmed);
});
test('two materializations freeze the window, preserve active context and append previous STATE with pinned documentary links', async (t) => {
  const f = await fixture(t),
    source = await readFile(f.feed);
  const state0 = await readFile(join(f.memory, 'STATE.md'), 'utf8');
  const knowledge0 = await readFile(join(f.memory, 'knowledge/topic.md'));
  const first = await f.propose();
  assert.deepEqual(
    first.packet.events.map((e: { sequence: number }) => e.sequence),
    [2],
  );
  assert.deepEqual(Object.keys(first.packet.context), [
    'STATE.md',
    'knowledge/topic.md',
  ]);
  assert.ok(!JSON.stringify(first.packet.context).includes('HISTORY.md'));
  await f.event('four'); // Arrival while the proposal is pending stays out of its batch.
  const again = await prepareCurator(f.work, f.directive, {
    context: ['knowledge/topic.md'],
  });
  assert.equal(again.run, first.run);
  const v1 = await validateCurator(f.work);
  await applyCurator(f.work, v1.seal);
  const history1 = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  const pinnedState0 = await pinnedBaselineState(f.work, state0);
  assert.ok(
    history1.includes(
      pinnedState0
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n'),
    ),
    JSON.stringify({ state0, history1 }),
  );
  const state1 = await readFile(join(f.memory, 'STATE.md'), 'utf8');
  const second = await f.propose(4);
  assert.deepEqual(
    second.packet.events.map((e: { sequence: number }) => e.sequence),
    [3, 4],
  );
  const v2 = await validateCurator(f.work);
  // CLI promotion requires a user invocation, even for legacy feed runs.
  const child = spawnSync(
    process.execPath,
    ['src/curator-cli.ts', 'apply', '--work', f.work, '--confirm', v2.seal],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 1, child.stderr);
  assert.equal(JSON.parse(child.stderr).code, 'CURATOR_HANDOFF_REQUIRED');
  // Retain the trusted legacy API's independent-process promotion check.
  const trusted = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import { applyCurator } from './src/curator.ts'; await applyCurator(process.argv[1], process.argv[2]);",
      f.work,
      v2.seal,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(trusted.status, 0, trusted.stderr);
  const history2 = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  assert.ok(history2.startsWith(history1));
  assert.ok(
    history2.includes(
      state1
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n'),
    ),
  );
  assert.deepEqual(
    historySegments(history2, 4).map((s) => [s.id, s.from, s.through]),
    [
      ['H000001', 2, 2],
      ['H000002', 3, 4],
    ],
  );
  assert.match(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    /Open: preserve task/,
  );
  assert.deepEqual(
    await readFile(join(f.memory, 'knowledge/topic.md')),
    knowledge0,
  );
  const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
  assert.deepEqual(await prepareCurator(f.work, f.directive), {
    status: 'noop',
    through: 4,
  });
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), checkpoint);
  assert.ok((await readFile(f.feed)).subarray(0, source.length).equals(source));
});

test('validation failure leaves confirmed files and checkpoint untouched; seal binds proposal and staging', async (t) => {
  const f = await fixture(t),
    cp = await readFile(join(f.work, 'checkpoint.json'));
  const p = await f.propose(2);
  p.proposal.state = '# State\n\nInvented [E999](' + p.packet.feed + ')\n';
  await writeFile(p.proposalFile!, JSON.stringify(p.proposal));
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_PROVENANCE_INVALID',
  });
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), cp);
  p.proposal.state = '# State\n\nValid [E002](' + p.packet.feed + ')\n';
  await writeFile(p.proposalFile!, JSON.stringify(p.proposal));
  const v = await validateCurator(f.work);
  await appendFile(join(v.candidate, 'STATE.md'), '\nTampered\n');
  await assert.rejects(applyCurator(f.work, v.seal), {
    code: 'CURATOR_STAGE_CHANGED',
  });
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), cp);
});

test('ordinary event-like prose and Catalogo E1 titles are not provenance; real references still permit promotion', async (t) => {
  const f = await fixture(t),
    p = await f.propose();
  p.proposal.state =
    '# Catalogo E1\n\nEsperimenti E01, E999 e E0000 sono nomi ordinari.\n' +
    '[Catalogo E1](knowledge/topic.md) [E002](' +
    p.packet.feed +
    ')\n';
  p.proposal.history.topics = ['Catalogo E1'];
  await writeFile(p.proposalFile!, JSON.stringify(p.proposal));
  const v = await validateCurator(f.work);
  await applyCurator(f.work, v.seal);
  assert.equal(
    JSON.parse(await readFile(join(f.work, 'checkpoint.json'), 'utf8'))
      .sequence,
    2,
  );
  assert.match(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    /# Catalogo E1/,
  );
});

test('explicit feed links validate every label, canonical ID and declared range against the frozen cutoff', async (t) => {
  const f = await fixture(t),
    p = await f.propose();
  const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
  for (const label of [
    'E999',
    'E003',
    'E1',
    'E000',
    'E0002',
    'E002–E001',
    'E001..E999',
    'E001..',
    'E001–E',
    'E001..E002..E002',
  ]) {
    await writeFile(
      p.proposalFile!,
      JSON.stringify({
        ...p.proposal,
        state: p.proposal.state + '\n[' + label + '](' + p.packet.feed + ')\n',
      }),
    );
    await assert.rejects(
      validateCurator(f.work),
      { code: 'CURATOR_PROVENANCE_INVALID' },
      label,
    );
    assert.deepEqual(
      await readFile(join(f.work, 'checkpoint.json')),
      checkpoint,
    );
  }
  for (const label of [
    'E002',
    'ripetizione E001',
    'E001–E002',
    'E001..E002',
    'E001-E002',
  ]) {
    await writeFile(
      p.proposalFile!,
      JSON.stringify({
        ...p.proposal,
        state: p.proposal.state + '\n[' + label + '](' + p.packet.feed + ')\n',
      }),
    );
    assert.equal((await validateCurator(f.work)).status, 'validated');
  }
  await writeFile(
    p.proposalFile!,
    JSON.stringify({
      ...p.proposal,
      state: p.proposal.state + '\n[E002](knowledge/topic.md)\n',
    }),
  );
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_PROVENANCE_INVALID',
  });
});

test('dedicated HISTORY event ranges remain structural, canonical and bounded', async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.initialMemory, 'STATE.md'), 'utf8');
  const history =
    '# History\n' +
    historyAppendix(
      '# History\n',
      original,
      1,
      1,
      '2026-11-03T12:00:00.000Z',
      '../feed/' + f.feed.split(/[\\/]/).at(-1),
      {
        summary: 'Catalogo E1',
        topics: ['E1'],
        transition: 'Ordinary prose E999',
      },
    );
  await writeFile(join(f.initialMemory, 'HISTORY.md'), history);
  await initCurator(join(f.root, 'valid-range'), f.initialMemory, f.feed, 1);
  for (const [i, [range, code]] of [
    ['E01..E001', 'CURATOR_PROVENANCE_INVALID'],
    ['E001..E999', 'CURATOR_HISTORY_INVALID'],
    ['E002..E001', 'CURATOR_HISTORY_INVALID'],
  ].entries()) {
    await writeFile(
      join(f.initialMemory, 'HISTORY.md'),
      history.replace('`E001..E001`', '`' + range + '`'),
    );
    await assert.rejects(
      initCurator(
        join(f.root, 'invalid-range-' + i),
        f.initialMemory,
        f.feed,
        1,
      ),
      { code },
    );
  }
});

test('selective packet and two authored updates preserve linked details and unselected notes', async (t) => {
  // Authored expectations exercise transport/integrity, not LLM semantic selection.
  const f = await fixture(t, true);
  const untouched = await readFile(join(f.memory, 'knowledge/second.md'));
  const checkpointBefore = await readFile(join(f.work, 'checkpoint.json'));
  const texts = [
    'Riscrivi il riepilogo in parole semplici, senza nuovi fatti.',
    'Comando digitato male, corretto senza conseguenze.',
    'Il percorso dipendeva dal cwd; applicata la correzione. Build dichiarata verde, collaudo funzionale non eseguito.',
    'Il formato conserva R-31 e e\u0301 senza normalizzazione. Dettagli secondari ma durevoli.',
    'Nessun errore osservato sui file locali; rete non provata. Usare B anziche A solo per export locale.',
  ];
  for (const [index, text] of texts.entries())
    await appendFeedEvent(dirname(f.feed), {
      type: 'user_message',
      sessionId: 's',
      turnId: 'source-' + index,
      text,
      hook: 'UserPromptSubmit',
    });
  const feedBefore = await readFile(f.feed);
  const prepared = await prepareCurator(f.work, undefined, {
    through: 8,
    context: ['knowledge/topic.md', 'knowledge/topic.md'],
  });
  const packet = JSON.parse(
    await readFile(join(prepared.run!, 'packet.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(packet.context), [
    'STATE.md',
    'knowledge/topic.md',
  ]);
  const run = JSON.parse(
    await readFile(join(prepared.run!, 'run.json'), 'utf8'),
  );
  assert.deepEqual(run.context, ['knowledge/topic.md']);
  for (const name of Object.keys(packet.context))
    assert.equal(
      packet.context[name],
      await readFile(join(prepared.run!, 'base', name), 'utf8'),
    );
  assert.deepEqual(
    packet.events.slice(-5).map((e: { text: string }) => e.text),
    texts,
  );
  assert.deepEqual(await readFile(f.feed), feedBefore);
  assert.deepEqual(
    await readFile(join(f.work, 'checkpoint.json')),
    checkpointBefore,
  );

  const details =
    '\n## Diagnosi e limiti\n\nPercorso risolto dal cwd errato, correzione applicata. Build dichiarata verde; collaudo funzionale non eseguito.\n\n' +
    '## Formato\n\nR-31 e e\u0301 senza normalizzazione.\n\n' +
    '## Decisione e qualificazioni\n\nB sostituisce A solo per export locale, su direttiva utente. Nessun errore osservato sui file locali; rete non provata.\n\n' +
    `[E006-E008](../${packet.feed})\n\n[Altro dettaglio](second.md)\n`;
  const proposal = {
    action: 'update',
    state:
      '# Export\n\nObiettivo: completare export. Decisione attiva: B per export locale. Vincolo: preservare il formato.\n\n' +
      'Open: preserve task. Blocker: rete non provata; collaudo funzionale ancora aperto. Prossima azione: verificare export su rete.\n\n' +
      `[Dettagli tecnici](knowledge/topic.md) [E008](${packet.feed})\n`,
    history: {
      summary: 'Export locale',
      topics: ['Export'],
      transition:
        'Correzione del percorso; resta aperta la verifica funzionale.',
    },
    knowledge: {
      'knowledge/topic.md': packet.context['knowledge/topic.md'] + details,
    },
  };
  await writeFile(prepared.proposal!, JSON.stringify(proposal));
  const validated = await validateCurator(f.work);
  await applyCurator(f.work, validated.seal);
  const state = await memoryState(f.memory);
  assert.ok(!state.includes('R-31')); // Detail is reachable without being duplicated in STATE.
  const destination = /\[Dettagli tecnici\]\(([^)]+)\)/.exec(state)![1]!;
  const archived = await readFile(resolve(f.memory, destination), 'utf8');
  const current = await memoryRead(
    f.memory,
    'kn-00000000-0000-4000-8000-000000000001',
  );
  const exact = await memoryRead(f.memory, current.id + '@' + current.revision);
  for (const text of [
    'Technical detail.',
    'R-31',
    'e\u0301',
    'solo per export locale',
    'rete non provata',
  ]) {
    assert.ok(archived.includes(text), text);
    assert.ok(current.content.includes(text), text);
  }
  const related = /\[Altro dettaglio\]\(([^)]+)\)/.exec(current.content)![1]!;
  assert.ok(
    (await readFile(resolve(f.memory, 'knowledge', related), 'utf8')).includes(
      '# Second',
    ),
  );
  assert.deepEqual(
    await readFile(join(f.memory, 'knowledge/second.md')),
    untouched,
  );
  assert.equal((await readdir(join(f.memory, 'knowledge'))).length, 2);
  assert.deepEqual(await readFile(f.feed), feedBefore);

  await appendFeedEvent(dirname(f.feed), {
    type: 'user_message',
    sessionId: 's',
    turnId: 'subsequent-update',
    text: 'Dichiaro verificato solo export locale; rete ancora non provata.',
    hook: 'UserPromptSubmit',
  });
  const next = await prepareCurator(f.work, undefined, {
    through: 9,
    context: ['knowledge/topic.md'],
  });
  const nextPacket = JSON.parse(
    await readFile(join(next.run!, 'packet.json'), 'utf8'),
  );
  await writeFile(
    next.proposal!,
    JSON.stringify({
      ...proposal,
      state:
        nextPacket.context['STATE.md'] +
        `\nProgresso locale: [E009](${nextPacket.feed}).\n`,
      knowledge: {
        'knowledge/topic.md':
          nextPacket.context['knowledge/topic.md'] +
          `\n## Verifica aggiuntiva\n\nL'utente dichiara: solo export locale verificato; rete ancora non provata. [E009](../${nextPacket.feed})\n`,
      },
    }),
  );
  const nextValidated = await validateCurator(f.work);
  await applyCurator(f.work, nextValidated.seal);
  const updated = await memoryRead(f.memory, current.id);
  assert.ok(updated.content.startsWith(current.content));
  assert.ok(updated.content.includes('solo export locale verificato'));
  assert.equal(
    (await memoryRead(f.memory, current.id, { at: 8 })).content,
    exact.content,
  );
  assert.deepEqual(
    await readFile(join(f.memory, 'knowledge/second.md')),
    untouched,
  );
});

test('proposal cannot supply HISTORY, escape memory, edit unprovided Knowledge or change note IDs', async (t) => {
  const f = await fixture(t),
    p = await f.propose();
  const original = JSON.stringify(p.proposal);
  for (const [change, code] of [
    [
      { ...p.proposal, files: { 'HISTORY.md': 'rewrite' } },
      'CURATOR_PROPOSAL_INVALID',
    ],
    [
      { ...p.proposal, knowledge: { '../escape.md': 'bad' } },
      'CURATOR_UNSAFE_PATH',
    ],
    [
      {
        ...p.proposal,
        knowledge: {
          'knowledge/topic.md': p.packet.context['knowledge/topic.md'].replace(
            '000000000001',
            '000000000002',
          ),
        },
      },
      'CURATOR_NOTE_ID_CHANGED',
    ],
    [
      {
        ...p.proposal,
        history: { summary: 'bad\nmetadata', topics: ['x'], transition: 'x' },
      },
      'CURATOR_HISTORY_INVALID',
    ],
  ] as const) {
    await writeFile(p.proposalFile!, JSON.stringify(change));
    await assert.rejects(validateCurator(f.work), { code });
  }
  await writeFile(p.proposalFile!, original);
  // A new workspace without selected Knowledge cannot update that note.
  const work2 = join(f.root, 'second');
  await initCurator(work2, f.memory, f.feed, 1);
  const prep = await prepareCurator(work2, f.directive, { through: 2 });
  await writeFile(
    prep.proposal!,
    JSON.stringify({
      ...p.proposal,
      knowledge: {
        'knowledge/topic.md': p.packet.context['knowledge/topic.md'],
      },
    }),
  );
  await assert.rejects(validateCurator(work2), {
    code: 'CURATOR_CONTEXT_INVALID',
  });
});

test('links require existing targets and real anchors; original artifacts require explicit authorization', async (t) => {
  const f = await fixture(t),
    p = await f.propose();
  for (const link of [
    '[bad](missing.md)',
    '[bad](knowledge/topic.md#absent)',
    '[bad](../../secret.txt)',
  ]) {
    await writeFile(
      p.proposalFile!,
      JSON.stringify({ ...p.proposal, state: p.proposal.state + '\n' + link }),
    );
    await assert.rejects(validateCurator(f.work), {
      code: 'CURATOR_LINK_INVALID',
    });
  }
  await writeFile(
    p.proposalFile!,
    JSON.stringify({
      ...p.proposal,
      state: p.proposal.state + '\n[E999](' + p.packet.feed + ')',
    }),
  );
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_PROVENANCE_INVALID',
  });
});

test('unrecorded edits are rejected without changing checkpoint', async (t) => {
  const f = await fixture(t),
    _p = await f.propose(),
    v = await validateCurator(f.work);
  const checkpoint = await readFile(join(f.work, 'checkpoint.json'));
  await writeFile(join(f.memory, 'STATE.md'), 'unrecorded edit');
  await assert.rejects(applyCurator(f.work, v.seal), {
    code: 'CURATOR_MEMORY_CHANGED',
  });
  assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), checkpoint);
});

// Inject process exit or I/O failure in a child, without production failpoints.
function crashApply(
  work: string,
  seal: string,
  boundary: string,
  before = false,
  fault: 'crash' | 'io' | 'sync' = 'crash',
) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { relative } from 'node:path';
    const [input, seal, boundary, before, fault] = process.argv.slice(1);
    const work = await fs.realpath(input);
    const interrupt = () => {
      if (fault === 'crash') process.exit(73);
      throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' });
    };
    if (fault === 'sync') {
      const originalOpen = fs.open;
      fs.open = async (...args) => {
        const handle = await originalOpen(...args), sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (relative(work, args[0]).replaceAll('\\\\', '/') === boundary) interrupt();
          await sync();
        };
        return handle;
      };
    }
    for (const method of ['rename', 'unlink']) {
      const original = fs[method];
      fs[method] = async (...args) => {
        const path = relative(work, method === 'rename' ? args[1] : args[0]).replaceAll('\\\\', '/');
        if (fault !== 'sync' && path === boundary && before === 'true') interrupt();
        const result = await original(...args);
        if (fault !== 'sync' && path === boundary) interrupt();
        return result;
      };
    }
    syncBuiltinESMExports();
    const { applyCurator } = await import('./src/curator.ts');
    try { await applyCurator(work, seal); }
    catch (error) {
      if (fault === 'crash' || error.code !== 'EIO') throw error;
      process.exit(74);
    }
  `,
      work,
      seal,
      boundary,
      String(before),
      fault,
    ],
    { encoding: 'utf8' },
  );
  assert.ifError(child.error);
  assert.equal(
    child.status,
    fault === 'crash' ? 73 : 74,
    child.stderr || child.stdout,
  );
  return child.pid;
}

async function snapshot(work: string) {
  const tree: Record<string, string> = {};
  for (const name of [
    'STATE.md',
    'HISTORY.md',
    ...(await readdir(join(work, 'memory/knowledge'))).map(
      (n) => 'knowledge/' + n,
    ),
  ])
    tree[name] = await readFile(join(work, 'memory', name), 'utf8');
  return {
    tree,
    checkpoint: await readFile(join(work, 'checkpoint.json'), 'utf8'),
  };
}

test('native file and directory sync probe reports availability, not power-loss durability', async (t) => {
  // Use the workspace volume, not the possibly different system temp volume.
  const root = await mkdtemp(join(resolve('.'), '.knownex-sync-probe-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve('.'));
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, 'probe.txt'),
    handle = await open(file, 'wx');
  try {
    await handle.writeFile('sync probe\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  assert.equal(await readFile(file, 'utf8'), 'sync probe\n');
  const directories: Record<string, string> = {};
  for (const flags of ['r', 'r+']) {
    let directory;
    let phase = 'open';
    try {
      directory = await open(root, flags);
      phase = 'sync';
      await directory.sync();
      directories[flags] = 'ok';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      assert.equal(typeof code, 'string');
      directories[flags] = phase + ':' + code;
    } finally {
      await directory?.close();
    }
  }
  t.diagnostic(
    JSON.stringify({
      platform: process.platform,
      osRelease: osRelease(),
      node: process.version,
      uv: process.versions.uv,
      volume: resolve('.'),
      fileSync: 'ok',
      directorySync: directories,
    }),
  );
});

test('simulated checkpoint rename EIO leaves authorization recoverable and replay idempotent', async (t) => {
  const f = await fixture(t),
    _p = await f.propose(),
    v = await validateCurator(f.work);
  const before = await snapshot(f.work);
  crashApply(f.work, v.seal, 'checkpoint.json', true, 'io');
  const interrupted = await snapshot(f.work);
  assert.equal(interrupted.checkpoint, before.checkpoint);
  assert.notEqual(interrupted.tree['STATE.md'], before.tree['STATE.md']);
  assert.notEqual(interrupted.tree['HISTORY.md'], before.tree['HISTORY.md']);
  await assert.rejects(readFile(join(f.work, 'curator.lock')), {
    code: 'ENOENT',
  });
  const record = JSON.parse(
    await readFile(join(f.work, 'apply.json'), 'utf8'),
  ).record;
  assert.deepEqual(interrupted.tree, record.next);
  assert.equal(await memoryState(f.memory), record.next['STATE.md']);
  const recovered = await snapshot(f.work);
  assert.equal(JSON.parse(recovered.checkpoint).sequence, 2);
  assert.deepEqual(
    historySegments(recovered.tree['HISTORY.md']!, 2).map((s) => s.id),
    ['H000001'],
  );
  await applyCurator(f.work, v.seal);
  assert.deepEqual(await snapshot(f.work), recovered);
});

test('synthetic divergent persistence prefixes are blocked or recovered, never confirmed as mixed', async (t) => {
  const f = await fixture(t),
    _p = await f.propose(),
    v = await validateCurator(f.work);
  const before = await snapshot(f.work),
    pointer = await readFile(join(f.work, 'pending.json'));
  await applyCurator(f.work, v.seal);
  const expected = await snapshot(f.work);
  // Synthetic storage reordering: checkpoint survived, HISTORY contents did not.
  // This constructs a state on real files; it does not reproduce a power failure.
  await writeFile(join(f.memory, 'HISTORY.md'), before.tree['HISTORY.md']!);
  const mixed = await snapshot(f.work);
  for (const operation of [
    () => memoryState(f.memory),
    () => prepareCurator(f.work, f.directive),
    () => applyCurator(f.work, v.seal),
  ])
    await assert.rejects(operation(), { code: 'CURATOR_MEMORY_CHANGED' });
  assert.deepEqual(await snapshot(f.work), mixed);
  // With the old checkpoint and intact pending evidence, that same mix is recoverable.
  await writeFile(join(f.work, 'checkpoint.json'), before.checkpoint);
  await writeFile(join(f.work, 'pending.json'), pointer);
  assert.equal(await memoryState(f.memory), expected.tree['STATE.md']);
  assert.deepEqual(await snapshot(f.work), expected);
  await applyCurator(f.work, v.seal);
  assert.deepEqual(await snapshot(f.work), expected);
});

type StorageEvent =
  | { kind: 'write'; path: string; text: string }
  | { kind: 'file'; path: string; text: string }
  | { kind: 'directory'; path: string; entries: Record<string, string> }
  | { kind: 'rename'; path: string; from: string; text: string }
  | { kind: 'unlink'; path: string };

function tracedApply(work: string, seal: string): StorageEvent[] {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { relative, join } from 'node:path';
    const [input, seal] = process.argv.slice(1), work = await fs.realpath(input), events = [];
    const rel = p => relative(work, p).replaceAll('\\\\', '/');
    const watched = p => /^(?:apply.json|checkpoint.json|pending.json|[^/]+.tmp|memory\\/(?:STATE|HISTORY).md|memory\\/knowledge\\/[^/]+.md)$/.test(p) && !p.startsWith('curator.lock');
    const originalOpen = fs.open, originalRename = fs.rename, originalUnlink = fs.unlink;
    fs.open = async (...args) => {
      const handle = await originalOpen(...args), path = rel(args[0]), sync = handle.sync.bind(handle), write = handle.writeFile.bind(handle);
      handle.writeFile = async text => {
        await write(text);
        // Canonical I/O writes UTF-8 bytes; model the persisted text, not the Buffer object.
        if (watched(path)) events.push({kind:'write', path, text:Buffer.isBuffer(text) ? text.toString('utf8') : text});
      };
      handle.sync = async () => {
        await sync();
        if ((await handle.stat()).isDirectory()) {
          if (!['', 'memory', 'memory/knowledge'].includes(path)) return;
          const entries = {};
          for (const name of await fs.readdir(args[0])) {
            const file = join(args[0], name), key = rel(file);
            if (watched(key)) entries[key] = await fs.readFile(file, 'utf8');
          }
          events.push({kind:'directory', path, entries});
        } else if (watched(path)) events.push({kind:'file', path, text:await fs.readFile(args[0], 'utf8')});
      };
      return handle;
    };
    fs.rename = async (from, to) => {
      await originalRename(from, to);
      if (watched(rel(to))) events.push({kind:'rename', path:rel(to), from:rel(from), text:await fs.readFile(to, 'utf8')});
    };
    fs.unlink = async path => {
      await originalUnlink(path);
      if (rel(path) === 'pending.json') events.push({kind:'unlink', path:'pending.json'});
    };
    syncBuiltinESMExports();
    const { applyCurator } = await import('./src/curator.ts');
    await applyCurator(work, seal);
    console.log(JSON.stringify(events));
  `,
      work,
      seal,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('flush-order model loses unsynced data and name subsets and survives repeated recovery', async (t) => {
  const f = await fixture(t, true),
    p = await f.propose();
  p.proposal.knowledge = Object.fromEntries(
    ['topic', 'second'].map((name) => [
      `knowledge/${name}.md`,
      p.packet.context[`knowledge/${name}.md`] + '\nDurable update.\n',
    ]),
  );
  await writeFile(p.proposalFile!, JSON.stringify(p.proposal));
  const v = await validateCurator(f.work),
    before = await snapshot(f.work);
  const pointer = await readFile(join(f.work, 'pending.json'), 'utf8');
  const events = tracedApply(f.work, v.seal),
    expected = await snapshot(f.work);
  const journal = await readFile(join(f.work, 'apply.json'), 'utf8');
  // Independent model: file flush persists an object's bytes, directory flush
  // persists only immediate names. Rename alone persists neither. Earlier durable
  // objects survive; unflushed writes/names may be lost or persist independently.
  const hash = (text: string) =>
    createHash('sha256').update(text).digest('hex');
  const initial = {
    ...Object.fromEntries(
      Object.entries(before.tree).map(([n, s]) => ['memory/' + n, s]),
    ),
    'checkpoint.json': before.checkpoint,
    'pending.json': pointer,
  };
  const blobs = new Map(Object.values(initial).map((s) => [hash(s), s]));
  const names = new Map(Object.entries(initial).map(([n, s]) => [n, hash(s)]));
  const fileFlushes = new Map<string, string>();
  const projections: Map<string, string>[] = [];
  const parent = (path: string) =>
    path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const content = (path: string) => blobs.get(names.get(path)!);
  for (const event of events) {
    if (event.kind === 'file') {
      blobs.set(hash(event.text), event.text);
      fileFlushes.set(event.path, event.text);
    } else if (event.kind === 'directory') {
      for (const name of names.keys())
        if (parent(name) === event.path) names.delete(name);
      for (const [name, text] of Object.entries(event.entries))
        names.set(name, hash(text));
    } else if (event.kind === 'rename') {
      assert.equal(
        fileFlushes.get(event.from),
        event.text,
        'published contents must already be flushed',
      );
      if (event.path.startsWith('memory/'))
        assert.equal(
          content('apply.json'),
          journal,
          'journal name must be durable before promotion',
        );
      if (event.path === 'checkpoint.json')
        for (const [name, text] of Object.entries(expected.tree))
          assert.equal(
            content('memory/' + name),
            text,
            'all data and names must precede checkpoint publication',
          );
    } else if (event.kind === 'unlink') {
      assert.equal(
        content('checkpoint.json'),
        expected.checkpoint,
        'checkpoint must be durable before evidence cleanup',
      );
    }
    projections.push(
      new Map(
        [...names].map(([name, id]) => {
          assert.ok(
            blobs.has(id),
            'persisted name must never expose unsynced contents',
          );
          return [name, blobs.get(id)!];
        }),
      ),
    );
  }
  const matrix = [
    { path: 'apply.json', mode: 'unflushed' },
    { path: 'apply.json', mode: 'lost' },
    { path: 'apply.json', mode: 'eager' },
    { path: 'memory/HISTORY.md', mode: 'lost' },
    { path: 'memory/HISTORY.md', mode: 'missing' },
    { path: 'checkpoint.json', mode: 'lost' },
    { path: 'checkpoint.json', mode: 'eager' },
    { path: 'checkpoint.json', mode: 'missing' },
    { path: 'pending.json', mode: 'lost' },
  ];
  for (const row of matrix) {
    const cut =
      row.mode === 'unflushed'
        ? events.findIndex((e) => e.kind === 'write' && e.text === journal)
        : events.findIndex(
            (e) =>
              e.path === row.path &&
              e.kind === (row.path === 'pending.json' ? 'unlink' : 'rename'),
          );
    assert.ok(cut >= 0);
    const projection = new Map(projections[cut]!);
    if (row.mode === 'eager') {
      const event = events[cut]!;
      assert.equal(event.kind, 'rename');
      projection.set(
        row.path,
        (event as Extract<StorageEvent, { kind: 'rename' }>).text,
      );
    } else if (row.mode === 'missing') projection.delete(row.path);
    for (const name of [
      'apply.json',
      'checkpoint.json',
      'pending.json',
      ...Object.keys(expected.tree).map((n) => 'memory/' + n),
    ]) {
      const text = projection.get(name),
        path = join(f.work, name);
      if (text === undefined) await rm(path, { force: true });
      else await writeFile(path, text);
    }
    if (!projection.has('apply.json'))
      assert.equal(await memoryState(f.memory), before.tree['STATE.md']);
    else {
      if (row.path === 'memory/HISTORY.md' && row.mode === 'missing') {
        crashApply(f.work, v.seal, 'memory/HISTORY.md');
        // Lose this recovery's not-yet-synced replacement name as well.
        await rm(join(f.memory, 'HISTORY.md'));
      }
      assert.equal(await memoryState(f.memory), expected.tree['STATE.md']);
      assert.deepEqual(await snapshot(f.work), expected);
    }
    await applyCurator(f.work, v.seal);
    assert.deepEqual(await snapshot(f.work), expected, JSON.stringify(row));
    await applyCurator(f.work, v.seal);
    assert.deepEqual(await snapshot(f.work), expected);
    assert.equal(historySegments(expected.tree['HISTORY.md']!, 2).length, 1);
  }
});

test('a failed journal persistence barrier prevents Markdown promotion until recovery flushes it', async (t) => {
  const f = await fixture(t),
    _p = await f.propose(),
    v = await validateCurator(f.work);
  const before = await snapshot(f.work);
  crashApply(f.work, v.seal, 'apply.json', false, 'sync');
  assert.deepEqual(await snapshot(f.work), before);
  const journal = await readFile(join(f.work, 'apply.json'), 'utf8');
  assert.equal(JSON.parse(journal).record.seal, v.seal);
  await memoryState(f.memory);
  const after = await snapshot(f.work);
  assert.equal(JSON.parse(after.checkpoint).sequence, 2);
  assert.equal(historySegments(after.tree['HISTORY.md']!, 2).length, 1);
  await applyCurator(f.work, v.seal);
  assert.deepEqual(await snapshot(f.work), after);
});

test('process crashes across promotion boundaries recover the authorized generation exactly once', async (t) => {
  const f = await fixture(t, true),
    p = await f.propose();
  const sample = 'Città, perché — Ελληνικά 日本語 🧠 e\u0301';
  p.proposal.state += sample + '\n';
  p.proposal.history.transition += ' ' + sample;
  p.proposal.knowledge = Object.fromEntries(
    ['topic', 'second'].map((name) => [
      `knowledge/${name}.md`,
      p.packet.context[`knowledge/${name}.md`] + '\n' + sample + '\n',
    ]),
  );
  // File bytes -> JSON parsing -> validation/materialization -> persisted Markdown.
  await writeFile(p.proposalFile!, JSON.stringify(p.proposal), 'utf8');
  assert.deepEqual(
    JSON.parse(await readFile(p.proposalFile!, 'utf8')),
    p.proposal,
  );
  const v = await validateCurator(f.work);
  const before = await snapshot(f.work),
    pointer = await readFile(join(f.work, 'pending.json'));
  await applyCurator(f.work, v.seal);
  const expected = await snapshot(f.work);
  for (const name of [
    'STATE.md',
    'HISTORY.md',
    'knowledge/topic.md',
    'knowledge/second.md',
  ])
    assert.ok(expected.tree[name]!.includes(sample), name);
  assert.ok(
    expected.tree['HISTORY.md']!.startsWith(before.tree['HISTORY.md']!),
  );
  const pinnedState = await pinnedBaselineState(
    f.work,
    before.tree['STATE.md']!,
  );
  assert.ok(
    expected.tree['HISTORY.md']!.includes(
      pinnedState
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n'),
    ),
  );
  assert.equal(JSON.parse(expected.checkpoint).sequence, 2);

  for (const boundary of [
    'before-intent',
    'apply.json',
    'memory/STATE.md',
    'memory/HISTORY.md',
    'memory/knowledge/second.md',
    'memory/knowledge/topic.md',
    'checkpoint.json',
    'pending.json',
  ]) {
    await t.test(boundary, async () => {
      // Reset only this synthetic workspace to the verified pre-apply generation.
      for (const [name, text] of Object.entries(before.tree))
        await writeFile(join(f.memory, name), text);
      await writeFile(join(f.work, 'checkpoint.json'), before.checkpoint);
      await writeFile(join(f.work, 'pending.json'), pointer);
      await rm(join(f.work, 'apply.json'), { force: true });
      crashApply(
        f.work,
        v.seal,
        boundary === 'before-intent' ? 'apply.json' : boundary,
        boundary === 'before-intent',
      );
      if (boundary !== 'checkpoint.json' && boundary !== 'pending.json')
        assert.equal(
          await readFile(join(f.work, 'checkpoint.json'), 'utf8'),
          before.checkpoint,
        );
      if (boundary === 'before-intent') {
        assert.deepEqual(await snapshot(f.work), before);
        assert.equal(await memoryState(f.memory), before.tree['STATE.md']);
      } else {
        // Recovery itself can crash, then resume without duplicating HISTORY.
        if (boundary === 'memory/HISTORY.md')
          crashApply(f.work, v.seal, 'memory/knowledge/second.md');
        assert.equal(await memoryState(f.memory), expected.tree['STATE.md']);
        assert.deepEqual(await snapshot(f.work), expected);
      }
      assert.deepEqual(await applyCurator(f.work, v.seal), {
        status: 'applied',
        through: 2,
        action: 'update',
      });
      assert.deepEqual(await snapshot(f.work), expected);
      assert.deepEqual(
        historySegments(expected.tree['HISTORY.md']!, 2).map((s) => s.id),
        ['H000001'],
      );
      const receipt = await readFile(join(f.work, 'apply.json'));
      await applyCurator(f.work, v.seal);
      assert.deepEqual(await snapshot(f.work), expected);
      assert.deepEqual(await readFile(join(f.work, 'apply.json')), receipt);
      await assert.rejects(readFile(join(f.work, 'pending.json')), {
        code: 'ENOENT',
      });
    });
  }
});

test('prepare and validate recover first; incomplete recovery evidence blocks all workspace readers', async (t) => {
  for (const operation of [
    'prepare',
    'validate',
    'state',
    'find',
    'read',
    'init',
    'abandon',
  ] as const) {
    await t.test(operation, async () => {
      const f = await fixture(t),
        p = await f.propose(),
        v = await validateCurator(f.work);
      crashApply(f.work, v.seal, 'memory/STATE.md');
      if (operation === 'abandon') {
        const cp = await readFile(join(f.work, 'checkpoint.json'));
        const pending = await readFile(join(f.work, 'pending.json'));
        await assert.rejects(readPendingEvents(f.work, f.feed), {
          code: 'CURATOR_RECOVERY_REQUIRED',
        });
        assert.deepEqual(await readFile(join(f.work, 'checkpoint.json')), cp);
        assert.deepEqual(await readFile(join(f.work, 'pending.json')), pending);
      }
      // Recovery uses its persisted authorized tree, not mutable LLM output or staging.
      await rm(p.proposalFile!);
      await rm(v.candidate, { recursive: true });
      if (operation === 'prepare') {
        const prep = await prepareCurator(f.work, f.directive);
        assert.equal(prep.status, 'prepared');
        assert.equal(
          JSON.parse(await readFile(join(prep.run!, 'run.json'), 'utf8')).base
            .sequence,
          2,
        );
      } else if (operation === 'validate') {
        await assert.rejects(validateCurator(f.work), {
          code: 'CURATOR_NO_PENDING',
        });
      } else if (operation === 'state') await memoryState(f.memory);
      else if (operation === 'find')
        assert.equal((await memoryFind(f.memory, 'Advancement')).length, 1);
      else if (operation === 'read')
        assert.match(
          (await memoryRead(f.memory, 'H000001')).content,
          /Advancement/,
        );
      else if (operation === 'abandon')
        assert.equal(
          (await abandonCurator(f.work, basename(p.run!))).status,
          'already_applied',
        );
      else await initCurator(join(f.root, 'copy'), f.memory, f.feed, 2);
      assert.equal(
        JSON.parse(await readFile(join(f.work, 'checkpoint.json'), 'utf8'))
          .sequence,
        2,
      );
    });
  }
  for (const corruption of [
    'truncated',
    'checksum',
    'checkpoint-null',
    'unexpected-file',
  ] as const) {
    await t.test(corruption, async () => {
      const f = await fixture(t),
        _p = await f.propose(),
        v = await validateCurator(f.work);
      crashApply(f.work, v.seal, 'memory/STATE.md');
      if (corruption === 'truncated')
        await writeFile(join(f.work, 'apply.json'), '{');
      if (corruption === 'checksum') {
        const record = JSON.parse(
          await readFile(join(f.work, 'apply.json'), 'utf8'),
        );
        record.record.next['STATE.md'] += 'corrupt';
        await writeFile(join(f.work, 'apply.json'), JSON.stringify(record));
      }
      if (corruption === 'checkpoint-null')
        await writeFile(join(f.work, 'checkpoint.json'), 'null\n');
      if (corruption === 'unexpected-file')
        await writeFile(
          join(f.memory, 'knowledge/topic.md'),
          'unexpected edit',
        );
      const before = await readFile(join(f.memory, 'HISTORY.md'));
      const pendingBefore = await readFile(join(f.work, 'pending.json'));
      for (const read of [
        () => memoryState(f.memory),
        () => memoryFind(f.memory, 'task'),
        () => memoryRead(f.memory, 'kn-00000000-0000-4000-8000-000000000001'),
        () => prepareCurator(f.work, f.directive),
        () => applyCurator(f.work, v.seal),
        () => abandonCurator(f.work, basename(_p.run!)),
        () => prepareCurator(f.work, f.directive),
        () => readPendingEvents(f.work, f.feed),
      ])
        await assert.rejects(read());
      assert.deepEqual(await readFile(join(f.memory, 'HISTORY.md')), before);
      assert.deepEqual(
        await readFile(join(f.work, 'pending.json')),
        pendingBefore,
      );
    });
  }
});

test('noop can explicitly confirm examined events without rewriting Markdown', async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.memory, 'HISTORY.md'));
  const p = await f.propose(3, { action: 'noop' });
  await writeFile(p.proposalFile!, JSON.stringify({ action: 'noop' }));
  const v = await validateCurator(f.work);
  await applyCurator(f.work, v.seal);
  assert.deepEqual(await readFile(join(f.memory, 'HISTORY.md')), before);
  assert.equal(
    JSON.parse(await readFile(join(f.work, 'checkpoint.json'), 'utf8'))
      .sequence,
    3,
  );
});

test('authorized original artifacts and new thematic Knowledge are linked without modifying existing notes', async (t) => {
  const f = await fixture(t),
    csv = join(f.root, 'experiment.csv');
  await writeFile(csv, 'result\n42\n');
  const prep = await prepareCurator(f.work, f.directive, {
    through: 2,
    artifacts: [csv],
  });
  assert.ok(prep.run);
  const packet = JSON.parse(
    await readFile(join(prep.run, 'packet.json'), 'utf8'),
  );
  const original = await readFile(join(f.memory, 'knowledge/topic.md'));
  const artifact =
    '../' + packet.artifacts.find((p: string) => p.endsWith('/experiment.csv'));
  await writeFile(
    prep.proposal!,
    JSON.stringify({
      action: 'update',
      state:
        '# State\n\nOpen: preserve task. [E002](' +
        packet.feed +
        ') [Result](knowledge/result.md)\n',
      history: {
        summary: 'Experiment result',
        topics: ['Experiment'],
        transition: 'Original data linked.',
      },
      knowledge: {
        'knowledge/result.md':
          '---\nid: kn-00000000-0000-4000-8000-000000000002\ntype: knowledge\n---\n\n# Result\n\n[CSV](' +
          artifact +
          ') [E002](../' +
          packet.feed +
          ')\n',
      },
    }),
  );
  const v = await validateCurator(f.work);
  crashApply(f.work, v.seal, 'memory/HISTORY.md');
  await assert.rejects(readFile(join(f.memory, 'knowledge/result.md')), {
    code: 'ENOENT',
  });
  await applyCurator(f.work, v.seal);
  assert.deepEqual(
    await readFile(join(f.memory, 'knowledge/topic.md')),
    original,
  );
  assert.match(
    await readFile(join(f.memory, 'knowledge/result.md'), 'utf8'),
    /experiment.csv/,
  );
  assert.equal(await readFile(csv, 'utf8'), 'result\n42\n');
});

test('malformed feed prevents advancement', async (t) => {
  const f = await fixture(t);
  await f.propose();
  await appendFile(f.feed, '{"invalid":true}\n');
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_FEED_CORRUPT',
  });
});

test('a rewritten valid feed prefix is rejected against the confirmed checkpoint', async (t) => {
  const f = await fixture(t);
  await f.propose();
  const frames = (await readFile(f.feed, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  let previous: string | null = null;
  for (const frame of frames) {
    frame.block.event.text += ' altered';
    frame.block.previous = previous;
    frame.checksum = createHash('sha256')
      .update(JSON.stringify(frame.block))
      .digest('hex');
    previous = frame.checksum;
  }
  await writeFile(
    f.feed,
    frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n',
  );
  await assert.rejects(validateCurator(f.work), {
    code: 'CURATOR_FEED_CHANGED',
  });
});

test('legacy layout and unsupported checkpoint formats are rejected', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.memory, 'WORKING.md'), '# Old view');
  await assert.rejects(prepareCurator(f.work, f.directive), {
    code: 'CURATOR_UNSAFE_PATH',
  });
  await rm(join(f.memory, 'WORKING.md'));
  const cp = JSON.parse(
    await readFile(join(f.work, 'checkpoint.json'), 'utf8'),
  );
  await writeFile(
    join(f.work, 'checkpoint.json'),
    JSON.stringify({ ...cp, version: 1 }),
  );
  await assert.rejects(prepareCurator(f.work, f.directive), {
    code: 'CURATOR_CHECKPOINT_INVALID',
  });
});

test('process lock rejects concurrent materialization', async (t) => {
  const f = await fixture(t);
  const { acquireJournalLock } = await import('../src/journal-lock.ts');
  const release = await acquireJournalLock(join(f.work, 'curator.lock'));
  try {
    await assert.rejects(prepareCurator(f.work, f.directive), {
      code: 'DESTINATION_BUSY',
    });
    for (const read of [
      () => memoryState(f.memory),
      () => memoryFind(f.memory, 'task'),
      () => memoryRead(f.memory, 'kn-00000000-0000-4000-8000-000000000001'),
    ])
      await assert.rejects(read(), { code: 'DESTINATION_BUSY' });
  } finally {
    await release();
  }
});
