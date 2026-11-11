import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
  stat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { emptyMemory, initCurator, curatorStatus } from '../src/curator.ts';
import { appendFeedEvent } from '../src/feed.ts';
import { readCurationInput } from '../src/curation-io.ts';

/** The Curator's side of the contract: plain files written with a file tool. */
async function writeDraft(run: string, payload: any, bom = '') {
  const dir = join(run, 'draft');
  await mkdir(join(dir, 'knowledge'), { recursive: true });
  const { state, knowledge, ...meta } = payload.proposal;
  await writeFile(join(dir, 'proposal.json'), JSON.stringify(meta));
  if (state !== undefined) await writeFile(join(dir, 'STATE.md'), bom + state);
  for (const [name, text] of Object.entries(knowledge ?? {}))
    await writeFile(join(dir, name), text as string);
  await writeFile(join(dir, 'review.json'), JSON.stringify(payload.review));
}
async function draftWrite(f: { run: string; payload: unknown }) {
  await writeDraft(f.run, f.payload);
  return cli(['write', '--run', f.run]);
}
import { sha256 } from '../src/artifact-io.ts';

const unicode =
  'Caff\u00e8 \u2264 \u2014 \u6f22\u5b57 \ud83d\ude00 e\u0301\r\n';
function command(args: string[], input?: string | Buffer) {
  return spawnSync(process.execPath, ['src/index.ts', 'curate', ...args], {
    encoding: 'utf8',
    input,
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, KNOWNEX_CODEX_BIN: 'no-provider-is-available' },
  });
}
function cli(args: string[], input?: string | Buffer) {
  const r = command(args, input);
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(Buffer.from(r.stdout).every((b) => b < 128));
  return JSON.parse(r.stdout);
}
async function fixture(t: TestContext, source = unicode) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'knownex-curation-cli-')),
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
  const append = (
    type: 'user_message' | 'assistant_final',
    turnId: string,
    text: string,
  ) =>
    appendFeedEvent(
      feed,
      { type, turnId, text, sessionId: 'external-source', hook: 'portable' },
      true,
    );
  await append('user_message', 'one', source);
  await append('assistant_final', 'one', 'Confirmed.');
  const prepared = cli(['prepare', '--work', work, '--autonomous']);
  const run = prepared.run as string;
  const packet = cli(['read', '--run', run, '--input', 'packet.json']);
  const before = cli(['read', '--run', run, '--input', 'base/STATE.md']);
  const state = '# Portable result\r\n\r\n' + source + '\r\n[E001]\r\n';
  const payload = {
    proposal: {
      action: 'update',
      state,
      knowledge: {},
      history: {
        summary: 'Portable',
        topics: ['Portable'],
        transition: 'Recorded.',
      },
    },
    review: {
      version: 3,
      summary: 'Synthetic review',
      sources: [1],
      changes: [{ path: 'STATE.md', summary: 'Updated.', sources: [1] }],
      uncertainties: [],
      anomalies: [],
    },
  };
  return {
    root,
    memory,
    feed,
    work,
    run,
    prepared,
    packet,
    before,
    state,
    payload,
    append,
  };
}

test('CLI reads and byte ranges reassemble frozen Unicode inputs with the same canonical hashes', async (t) => {
  const f = await fixture(t, unicode.repeat(4096));
  for (const name of [
    'inputs.json',
    'packet.json',
    'base/STATE.md',
    'base/HISTORY.md',
    'SKILL.md',
    'WINDOW.md',
  ]) {
    const expected = await readCurationInput(f.run, name);
    const actual = cli(['read', '--run', f.run, '--input', name]);
    assert.equal(actual.runId, f.prepared.runId);
    assert.equal(actual.text, expected.text);
    assert.equal(actual.sha256, expected.sha256);
    assert.equal(actual.bytes, expected.bytes);
    assert.equal(actual.complete, true);
  }
  let offset = 0;
  let text = '';
  let pages = 0;
  do {
    const page = cli([
      'read',
      '--run',
      f.run,
      '--input',
      'packet.json',
      '--offset',
      String(offset),
      '--limit',
      '8192',
      '--sha256',
      f.packet.sha256,
    ]);
    assert.equal(page.offset, offset);
    assert.equal(page.sha256, f.packet.sha256);
    text += page.text;
    pages++;
    assert.ok(page.nextOffset > offset || page.complete);
    offset = page.nextOffset;
    if (page.complete) break;
  } while (true);
  assert.ok(pages > 1);
  assert.equal(offset, f.packet.bytes);
  assert.equal(text, f.packet.text);
  assert.equal(sha256(text), f.packet.sha256);
});

test('CLI write assembles Unicode draft files into canonical artifacts and derives evidence hashes', async (t) => {
  for (const bom of ['', '\uFEFF']) {
    const f = await fixture(t, unicode.repeat(4096));
    const note =
      '---\nid: kn-00000000-0000-4000-8000-000000000001\ntype: knowledge\n---\n# Nota\n\n' +
      unicode +
      '\n[E001]\n';
    const payload = structuredClone(f.payload) as any;
    payload.proposal.knowledge = { 'knowledge/nota-unicode.md': note };
    payload.review.changes.push({
      path: 'knowledge/nota-unicode.md',
      summary: 'Nota.',
      sources: [1],
    });
    await writeDraft(f.run, payload, bom);
    const receipts = cli(['write', '--run', f.run]);
    for (const name of ['proposal', 'review'] as const) {
      const receipt = receipts[name],
        bytes = await readFile(receipt.path);
      assert.equal(receipt.bytes, bytes.length);
      assert.equal(receipt.sha256, sha256(bytes));
    }
    const proposal = JSON.parse(await readFile(receipts.proposal.path, 'utf8'));
    assert.equal(proposal.state, f.state);
    assert.deepEqual(proposal.knowledge, { 'knowledge/nota-unicode.md': note });
    const review = JSON.parse(await readFile(receipts.review.path, 'utf8'));
    assert.equal(review.proposalSha256, receipts.proposal.sha256);
    // Rewriting the same draft is idempotent: same canonical bytes, same receipts.
    assert.deepEqual(cli(['write', '--run', f.run]), receipts);
  }
});

test('external CLI complete needs only a prepared run, accepts append and replays without a provider', async (t) => {
  const f = await fixture(t);
  await assert.rejects(stat(join(f.run, 'controller.json')), {
    code: 'ENOENT',
  });
  await draftWrite(f);
  await f.append('user_message', 'later', 'Still pending.');
  const result = cli(['complete', '--run', f.run]);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.through, 2);
  assert.equal(await readFile(join(f.memory, 'STATE.md'), 'utf8'), f.state);
  const status = await curatorStatus(f.work, join(f.feed, 'project.jsonl'));
  assert.equal(status.pending, 1);
  const replay = cli(['complete', '--run', f.run]);
  assert.equal(replay.status, 'SUCCESS');
  assert.equal(replay.replayed, true);
  assert.equal(
    (
      (await readFile(join(f.memory, 'HISTORY.md'), 'utf8')).match(
        /^- \[H\d{6,}\]/gm,
      ) || []
    ).length,
    1,
  );
});

test('CLI completion recovers a killed transactional apply with a grown feed and no native controller', async (t) => {
  const f = await fixture(t);
  await draftWrite(f);
  const entry = pathToFileURL(join(process.cwd(), 'src/index.ts')).href;
  const args = ['node', 'index.ts', 'curate', 'complete', '--run', f.run];
  const code = `const fs=await import('node:fs/promises'), rename=fs.default.rename;fs.default.rename=async(...args)=>{const result=await rename(...args);if(String(args[1]).replaceAll(String.fromCharCode(92),'/').endsWith('/memory/STATE.md'))process.exit(73);return result};(await import('node:module')).syncBuiltinESMExports();process.argv=${JSON.stringify(args)};await import(${JSON.stringify(entry)});`;
  const killed = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  );
  assert.equal(killed.status, 73, killed.stderr + killed.stdout);
  await f.append('user_message', 'later', 'After the crash.');
  const result = cli(['complete', '--run', f.run]);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.replayed, true);
  assert.equal(result.through, 2);
  assert.equal(
    (await curatorStatus(f.work, join(f.feed, 'project.jsonl'))).pending,
    1,
  );
  assert.equal(
    (
      (await readFile(join(f.memory, 'HISTORY.md'), 'utf8')).match(
        /^- \[H\d{6,}\]/gm,
      ) || []
    ).length,
    1,
  );
});

test('CLI rejects unauthorized input, changed snapshots and unverifiable or invalid ranges', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['--input', 'run.json'],
    ['--input', 'base/../../run.json'],
    ['--input', JSON.parse(f.packet.text).feed],
    ['--input', 'packet.json', '--sha256', 'a'.repeat(64)],
    ['--input', 'packet.json', '--offset', '1', '--limit', '16'],
    ['--input', 'packet.json', '--offset', '0', '--limit', '0'],
  ];
  for (const args of cases) {
    const r = command(['read', '--run', f.run, ...args]);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stderr).status, 'error');
  }
  const emoji = Buffer.from(f.packet.text).indexOf(Buffer.from('\ud83d\ude00'));
  assert.ok(emoji >= 0);
  for (const [offset, limit] of [
    [emoji + 1, 16],
    [emoji, 1],
  ]) {
    const r = command([
      'read',
      '--run',
      f.run,
      '--input',
      'packet.json',
      '--offset',
      String(offset),
      '--limit',
      String(limit),
      '--sha256',
      f.packet.sha256,
    ]);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stderr).code, 'CURATOR_IO_RANGE_INVALID');
  }
  await writeFile(join(f.run, 'base/STATE.md'), 'Changed.');
  const bad = command(['read', '--run', f.run, '--input', 'base/STATE.md']);
  assert.equal(JSON.parse(bad.stderr).code, 'CURATOR_INPUTS_CHANGED');
  const invalid = command([
    'read',
    '--run',
    join(f.root, 'missing'),
    '--input',
    'packet.json',
  ]);
  assert.equal(invalid.status, 1);
});

test('malformed, partial or invalid UTF-8 drafts publish no artifacts; complete before delivery consumes nothing', async (t) => {
  const cases: [string, string | Buffer][] = [
    ['proposal.json', '{'],
    ['proposal.json', JSON.stringify({ action: 'update', state: 'inline' })],
    ['review.json', '{'],
    ['STATE.md', Buffer.from([0xc3, 0x28])],
  ];
  for (const [name, content] of cases) {
    const f = await fixture(t);
    await writeDraft(f.run, f.payload);
    await writeFile(join(f.run, 'draft', name), content);
    const result = command(['write', '--run', f.run]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).status, 'error');
    for (const name of ['proposal.json', 'review.json'])
      await assert.rejects(stat(join(f.run, name)), { code: 'ENOENT' });
  }
  {
    const f = await fixture(t);
    const result = command(['write', '--run', f.run]);
    assert.equal(result.status, 1);
    await assert.rejects(stat(join(f.run, 'proposal.json')), {
      code: 'ENOENT',
    });
  }
  const f = await fixture(t);
  const early = command(['complete', '--run', f.run]);
  assert.equal(early.status, 1);
  assert.equal(
    JSON.parse(early.stdout).code,
    'CURATOR_WORKER_OUTPUT_INCOMPLETE',
  );
  assert.equal(await controllerStatus(f.run), 'prepared');
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
  // The removed receipts input is an argument error, not a run failure.
  const legacy = command(['complete', '--run', f.run, '--input', '-'], '{}');
  assert.equal(JSON.parse(legacy.stderr).code, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
  assert.equal(await controllerStatus(f.run), 'prepared');
  await draftWrite(f);
  assert.equal(cli(['complete', '--run', f.run]).status, 'SUCCESS');
});

async function controllerStatus(run: string) {
  return JSON.parse(await readFile(join(run, 'controller.json'), 'utf8'))
    .status;
}
async function assertNothingPersisted(run: string) {
  for (const name of ['proposal.json', 'review.json', 'validated.json'])
    await assert.rejects(stat(join(run, name)), { code: 'ENOENT' });
  assert.ok(!(await readdir(run)).some((n) => n.startsWith('candidate-')));
}

test('write rejects every draft complete would reject, persists nothing, and the corrected draft completes the same batch', async (t) => {
  const f = await fixture(t);
  const feed = JSON.parse(f.packet.text).feed;
  // Each case is a realistic Curator slip that used to surface only at complete.
  const cases: [string, (p: any) => void, string][] = [
    [
      'review still carrying the removed critical list',
      (p) => (p.review.critical = []),
      'CURATOR_REVIEW_INVALID',
    ],
    [
      'change entry without sources',
      (p) => (p.review.changes[0].sources = []),
      'CURATOR_REVIEW_INVALID',
    ],
    [
      'changes missing the updated STATE',
      (p) => (p.review.changes = []),
      'CURATOR_REVIEW_INVALID',
    ],
    [
      'source after the frozen cutoff',
      (p) => (p.review.sources = [99]),
      'CURATOR_REVIEW_INVALID',
    ],
    [
      'unknown review field',
      (p) => (p.review.extra = true),
      'CURATOR_REVIEW_INVALID',
    ],
    [
      'unknown proposal field',
      (p) => (p.proposal.extra = true),
      'CURATOR_PROPOSAL_INVALID',
    ],
    [
      'history without transition',
      (p) => delete p.proposal.history.transition,
      'CURATOR_PROPOSAL_INVALID',
    ],
    [
      'update identical to confirmed memory',
      (p) => {
        p.proposal.state = f.before.text;
      },
      'CURATOR_EMPTY_UPDATE',
    ],
    [
      'Knowledge note with a malformed hand-written identity',
      (p) => {
        p.proposal.knowledge = {
          'knowledge/nota.md':
            '---\nid: kn-not-a-uuid\ntype: knowledge\n---\n# Nota\n\n[E001]\n',
        };
        p.review.changes.push({
          path: 'knowledge/nota.md',
          summary: 'Nota.',
          sources: [1],
        });
      },
      'CURATOR_NOTE_METADATA',
    ],
  ];
  for (const [name, mutate, code] of cases) {
    const payload = structuredClone(f.payload) as any;
    mutate(payload);
    await rm(join(f.run, 'draft'), { recursive: true, force: true });
    await writeDraft(f.run, payload);
    const result = command(['write', '--run', f.run]);
    assert.equal(result.status, 1, name);
    assert.equal(JSON.parse(result.stderr).code, code, name);
    await assertNothingPersisted(f.run);
    await assert.rejects(stat(join(f.run, 'controller.json')), {
      code: 'ENOENT',
    });
  }
  await rm(join(f.run, 'draft'), { recursive: true, force: true });
  await draftWrite(f);
  const result = cli(['complete', '--run', f.run]);
  assert.equal(result.status, 'SUCCESS');
  assert.ok(
    (await readFile(join(f.memory, 'STATE.md'), 'utf8')).includes(
      '# Portable result',
    ),
  );
});

test('write replaces an accepted delivery until complete starts, and a rejected rewrite keeps the accepted one', async (t) => {
  const f = await fixture(t);
  const first = await draftWrite(f);
  const second = structuredClone(f.payload) as any;
  second.proposal.state = f.state.replace('# Portable result', '# Second');
  await writeDraft(f.run, second);
  const replaced = cli(['write', '--run', f.run]);
  assert.notEqual(replaced.proposal.sha256, first.proposal.sha256);
  const proposalBytes = await readFile(join(f.run, 'proposal.json'));
  assert.equal(sha256(proposalBytes), replaced.proposal.sha256);
  assert.equal(
    JSON.parse(await readFile(join(f.run, 'review.json'), 'utf8'))
      .proposalSha256,
    sha256(proposalBytes),
  );
  // A bad rewrite is rejected before anything is removed.
  const bad = structuredClone(second);
  bad.review.sources = [999];
  await writeDraft(f.run, bad);
  assert.equal(
    JSON.parse(command(['write', '--run', f.run]).stderr).code,
    'CURATOR_REVIEW_INVALID',
  );
  assert.deepEqual(await readFile(join(f.run, 'proposal.json')), proposalBytes);
  await writeDraft(f.run, second);
  for (const status of ['finishing', 'failed', 'blocked']) {
    await writeFile(
      join(f.run, 'controller.json'),
      JSON.stringify({ policy: 'frozen-batch-clean-report-v1', status }),
    );
    const frozen = command(['write', '--run', f.run]);
    assert.equal(
      JSON.parse(frozen.stderr).code,
      'CURATOR_CHECKPOINT_RETRY_FORBIDDEN',
      status,
    );
    assert.deepEqual(
      await readFile(join(f.run, 'proposal.json')),
      proposalBytes,
    );
  }
  await rm(join(f.run, 'controller.json'));
  assert.equal(cli(['complete', '--run', f.run]).status, 'SUCCESS');
  const state = await readFile(join(f.memory, 'STATE.md'), 'utf8');
  assert.ok(state.includes('# Second') && !state.includes('# Portable result'));
  // After publication the run is no longer pending: write cannot touch it.
  assert.equal(command(['write', '--run', f.run]).status, 1);
  assert.deepEqual(await readFile(join(f.run, 'proposal.json')), proposalBytes);
});

test('the Curator reads the whole batch from a frozen WINDOW.md that is smaller than packet.json and as complete', async (t) => {
  const f = await fixture(t);
  const packet = JSON.parse(f.packet.text);
  const window = cli(['read', '--run', f.run, '--input', 'WINDOW.md']);
  // Every event the Curator needs: sequence label, type and verbatim text.
  for (const e of packet.events) {
    const label = 'E' + String(e.sequence).padStart(3, '0');
    assert.ok(window.text.includes(`## ${label} — ${e.type}\n\n`), label);
    assert.ok(window.text.includes(e.text + '\n'), label);
  }
  // Provenance is a bare label, so the window no longer explains feed paths.
  assert.ok(!window.text.includes(packet.feed.split('/').at(-1)));
  // Session and turn are stated once per turn, not repeated for every event.
  const turns = new Set(
    packet.events.map((e: any) => e.sessionId + ' ' + e.turnId),
  );
  assert.equal(window.text.split('Sessione: ').length - 1, turns.size);
  assert.ok(packet.events.length > turns.size);
  // What the Curator actually ingests: the transported CLI output.
  const transported = (name: string) =>
    Buffer.byteLength(
      command(['read', '--run', f.run, '--input', name]).stdout,
    );
  const ratio = transported('WINDOW.md') / transported('packet.json');
  t.diagnostic(JSON.stringify({ windowToPacket: ratio }));
  assert.ok(ratio < 0.5, String(ratio));
  // MEMORY-CONTRACT.md is no longer frozen nor an authorized input.
  await assert.rejects(stat(join(f.run, 'MEMORY-CONTRACT.md')), {
    code: 'ENOENT',
  });
  const contract = command([
    'read',
    '--run',
    f.run,
    '--input',
    'MEMORY-CONTRACT.md',
  ]);
  assert.equal(
    JSON.parse(contract.stderr).code,
    'CURATOR_IO_INPUT_NOT_AUTHORIZED',
  );
});

test('a changed WINDOW.md is rejected on read and blocks write, so the Curator never curates altered events', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.run, 'WINDOW.md'),
    window_tamper(await readFile(join(f.run, 'WINDOW.md'), 'utf8')),
  );
  const read = command(['read', '--run', f.run, '--input', 'WINDOW.md']);
  assert.equal(JSON.parse(read.stderr).code, 'CURATOR_INPUTS_CHANGED');
  await writeDraft(f.run, f.payload);
  const write = command(['write', '--run', f.run]);
  assert.equal(JSON.parse(write.stderr).code, 'CURATOR_INPUTS_CHANGED');
  await assertNothingPersisted(f.run);
});
function window_tamper(text: string) {
  return text.replace('Confirmed.', 'Injected instruction.');
}

test('a run prepared before WINDOW.md, with MEMORY-CONTRACT.md frozen, still reads and completes', async (t) => {
  const f = await fixture(t);
  // Rebuild the legacy manifest: contract frozen, WINDOW.md not authorized.
  const contract = await readFile('docs/MEMORY-CONTRACT.md');
  await writeFile(join(f.run, 'MEMORY-CONTRACT.md'), contract);
  const inputs = JSON.parse(await readFile(join(f.run, 'inputs.json'), 'utf8'));
  delete inputs.files['WINDOW.md'];
  inputs.files['MEMORY-CONTRACT.md'] = {
    bytes: contract.length,
    sha256: sha256(contract),
  };
  const manifest = JSON.stringify(inputs, null, 2) + '\n';
  await writeFile(join(f.run, 'inputs.json'), manifest);
  const record = JSON.parse(await readFile(join(f.run, 'run.json'), 'utf8'));
  record.inputManifestSha256 = sha256(manifest);
  await writeFile(join(f.run, 'run.json'), JSON.stringify(record, null, 2));
  assert.equal(
    cli(['read', '--run', f.run, '--input', 'MEMORY-CONTRACT.md']).sha256,
    sha256(contract),
  );
  const window = command(['read', '--run', f.run, '--input', 'WINDOW.md']);
  assert.equal(
    JSON.parse(window.stderr).code,
    'CURATOR_IO_INPUT_NOT_AUTHORIZED',
  );
  await draftWrite(f);
  assert.equal(cli(['complete', '--run', f.run]).status, 'SUCCESS');
});

const uuidV4 =
  /^kn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noteId = (text: string) =>
  /^---\nid: (\S+)\ntype: knowledge\n---\n/.exec(text)?.[1];

test('write gives new notes fresh v4 identities and an updated note its frozen one across checkpoints', async (t) => {
  const f = await fixture(t);
  const first = structuredClone(f.payload) as any;
  first.proposal.knowledge = {
    'knowledge/alfa.md': '# Alfa\n\nPrima versione. [E001]\n',
    'knowledge/beta.md': '# Beta\n\nAltro tema. [E001]\n',
  };
  for (const path of Object.keys(first.proposal.knowledge))
    first.review.changes.push({ path, summary: 'Nota.', sources: [1] });
  await writeDraft(f.run, first);
  const receipts = cli(['write', '--run', f.run]);
  const written = JSON.parse(
    await readFile(receipts.proposal.path, 'utf8'),
  ).knowledge;
  const alfa = noteId(written['knowledge/alfa.md'])!,
    beta = noteId(written['knowledge/beta.md'])!;
  assert.match(alfa, uuidV4);
  assert.match(beta, uuidV4);
  assert.notEqual(alfa, beta);
  assert.equal(cli(['complete', '--run', f.run]).status, 'SUCCESS');
  // Second checkpoint: the Curator rewrites alfa without frontmatter, as the skill says.
  await f.append('user_message', 'two', 'Alfa cambia.');
  await f.append('assistant_final', 'two', 'Confermato.');
  const next = cli(['prepare', '--work', f.work, '--autonomous']).run as string;
  const base = await readFile(join(next, 'base/knowledge/alfa.md'), 'utf8');
  assert.equal(noteId(base), alfa);
  const before = cli(['read', '--run', next, '--input', 'base/STATE.md']).text;
  const second = {
    proposal: {
      action: 'update',
      state: before + '\nAlfa aggiornata. [E003]\n',
      knowledge: {
        'knowledge/alfa.md': '# Alfa\n\nSeconda versione. [E003]\n',
      },
      history: { summary: 'Alfa', topics: ['Alfa'], transition: 'Alfa.' },
    },
    review: {
      version: 3,
      summary: 'Alfa aggiornata.',
      sources: [3],
      changes: [
        { path: 'STATE.md', summary: 'Alfa.', sources: [3] },
        { path: 'knowledge/alfa.md', summary: 'Alfa.', sources: [3] },
      ],
      uncertainties: [],
      anomalies: [],
    },
  };
  // A hand-written frontmatter that changes an existing id is still rejected.
  const forged = structuredClone(second);
  forged.proposal.knowledge['knowledge/alfa.md'] =
    '---\nid: kn-00000000-0000-4000-8000-000000000001\ntype: knowledge\n---\n' +
    second.proposal.knowledge['knowledge/alfa.md'];
  await writeDraft(next, forged);
  assert.equal(
    JSON.parse(command(['write', '--run', next]).stderr).code,
    'CURATOR_NOTE_ID_CHANGED',
  );
  await writeDraft(next, second);
  const updated = cli(['write', '--run', next]);
  const note = JSON.parse(await readFile(updated.proposal.path, 'utf8'))
    .knowledge['knowledge/alfa.md'];
  assert.equal(noteId(note), alfa);
  assert.equal(cli(['complete', '--run', next]).status, 'SUCCESS');
});

test('each checkpoint adds one index line and an immutable window, and runs never copy windows', async (t) => {
  const f = await fixture(t);
  const first = structuredClone(f.payload) as any;
  first.proposal.knowledge = {
    'knowledge/alfa.md': '# Alfa\n\nPrima. [E001]\n',
  };
  first.review.changes.push({
    path: 'knowledge/alfa.md',
    summary: 'Nota.',
    sources: [1],
  });
  await writeDraft(f.run, first);
  cli(['write', '--run', f.run]);
  assert.equal(cli(['complete', '--run', f.run]).status, 'SUCCESS');
  const history1 = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  const window1 = await readFile(join(f.memory, 'history/H000001.md'), 'utf8');
  // The index is one line per checkpoint and never copies STATE.
  assert.match(
    history1,
    /\n- \[H000001\]\(history\/H000001\.md\) · `[^`]+` · `E001\.\.E\d{3}` · Portable — Portable\n$/,
  );
  assert.ok(!history1.includes(f.state.split('\r\n')[2]!));
  // The window lists the revision written by the checkpoint, and the link opens it.
  const notes = [
    ...window1.matchAll(/^- \[(knowledge\/[^\]]+)\]\(([^)]+)\)$/gm),
  ];
  assert.deepEqual(
    notes.map((m) => m[1]),
    ['knowledge/alfa.md'],
  );
  const revision = await readFile(
    resolve(join(f.memory, 'history'), decodeURIComponent(notes[0]![2]!)),
    'utf8',
  );
  assert.ok(revision.includes('Prima. [E001]'));
  // It ends with the STATE it produced, links moved one level down.
  const state1 = await readFile(join(f.memory, 'STATE.md'), 'utf8');
  assert.ok(
    window1.endsWith(
      '## STATE risultante\n\n' +
        state1.replace(/\]\((?![a-z]+:|#)/gi, '](../'),
    ),
  );
  await f.append('user_message', 'two', 'Secondo passo.');
  await f.append('assistant_final', 'two', 'Fatto.');
  const next = cli(['prepare', '--work', f.work, '--autonomous']).run as string;
  // Windows are history, not curation input: the run base and its manifest leave them out.
  await assert.rejects(stat(join(next, 'base/history')), { code: 'ENOENT' });
  assert.ok(
    !(await readFile(join(next, 'inputs.json'), 'utf8')).includes('history/'),
  );
  const before = cli(['read', '--run', next, '--input', 'base/STATE.md']).text;
  await writeDraft(next, {
    proposal: {
      action: 'update',
      state: before + '\nSecondo passo. [E003]\n',
      knowledge: {},
      history: { summary: 'Passo', topics: ['Passo'], transition: 'Avanti.' },
    },
    review: {
      version: 3,
      summary: 'Passo.',
      sources: [3],
      changes: [{ path: 'STATE.md', summary: 'Passo.', sources: [3] }],
      uncertainties: [],
      anomalies: [],
    },
  });
  cli(['write', '--run', next]);
  assert.equal(cli(['complete', '--run', next]).status, 'SUCCESS');
  const history2 = await readFile(join(f.memory, 'HISTORY.md'), 'utf8');
  assert.ok(history2.startsWith(history1));
  assert.equal(history2.match(/^- \[H\d{6}\]/gm)?.length, 2);
  assert.equal(
    await readFile(join(f.memory, 'history/H000001.md'), 'utf8'),
    window1,
  );
  assert.match(
    await readFile(join(f.memory, 'history/H000002.md'), 'utf8'),
    /## Note scritte\n\n- nessuna\n/,
  );
  // The timeline is listed newest first, without window bodies.
  const listed = spawnSync(
    process.execPath,
    ['src/index.ts', 'memory', 'history', '--memory', f.memory],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(listed.status, 0, listed.stderr);
  const { results } = JSON.parse(listed.stdout);
  assert.deepEqual(
    results.map((r: { id: string; path: string }) => [r.id, r.path]),
    [
      ['H000002', 'history/H000002.md'],
      ['H000001', 'history/H000001.md'],
    ],
  );
  assert.ok(!listed.stdout.includes('STATE risultante'));
});

test('write keeps hand-written frontmatter byte for byte', async (t) => {
  const f = await fixture(t);
  const payload = structuredClone(f.payload) as any;
  const manual =
    '---\nid: kn-00000000-0000-4000-8000-000000000009\ntype: knowledge\n---\n# Gamma\n\nTesto. [E001]\n';
  payload.proposal.knowledge = { 'knowledge/gamma.md': manual };
  payload.review.changes.push({
    path: 'knowledge/gamma.md',
    summary: 'Nota.',
    sources: [1],
  });
  await writeDraft(f.run, payload);
  const receipts = cli(['write', '--run', f.run]);
  const note = JSON.parse(await readFile(receipts.proposal.path, 'utf8'))
    .knowledge['knowledge/gamma.md'];
  assert.equal(note, manual);
});

test('event citations stay bare labels, legacy feed links are reduced in every file and labels are still validated', async (t) => {
  const f = await fixture(t);
  const feed = JSON.parse(f.packet.text).feed;
  const payload = structuredClone(f.payload) as any;
  // Mixed input: bare labels plus feed links copied from an older note.
  payload.proposal.state =
    '# Bare\n\nRisultato confermato [E001] e risposta [E001–E002].\nGia collegato [E001](' +
    feed +
    ').\n';
  payload.proposal.history.transition = 'Citato in [E001](' + feed + ').';
  payload.proposal.knowledge = {
    'knowledge/delta.md': '# Delta\n\nDettaglio [E002](../' + feed + ').\n',
  };
  payload.review.changes.push({
    path: 'knowledge/delta.md',
    summary: 'Nota.',
    sources: [2],
  });
  // A bare label is checked like a link was: after the cutoff it is refused.
  const late = structuredClone(payload);
  late.proposal.state = '# Bare\n\nFuturo [E099].\n';
  await writeDraft(f.run, late);
  assert.equal(
    JSON.parse(command(['write', '--run', f.run]).stderr).code,
    'CURATOR_PROVENANCE_INVALID',
  );
  // A file without any label has no provenance.
  late.proposal.state = '# Bare\n\nSenza fonte.\n';
  await writeDraft(f.run, late);
  assert.equal(
    JSON.parse(command(['write', '--run', f.run]).stderr).code,
    'CURATOR_PROVENANCE_INVALID',
  );
  await writeDraft(f.run, payload);
  const receipts = cli(['write', '--run', f.run]);
  const proposal = JSON.parse(await readFile(receipts.proposal.path, 'utf8'));
  assert.equal(
    proposal.state,
    '# Bare\n\nRisultato confermato [E001] e risposta [E001–E002].\nGia collegato [E001].\n',
  );
  assert.equal(proposal.history.transition, 'Citato in [E001].');
  assert.ok(
    proposal.knowledge['knowledge/delta.md'].endsWith(
      '# Delta\n\nDettaglio [E002].\n',
    ),
  );
  assert.equal(cli(['complete', '--run', f.run]).status, 'SUCCESS');
  for (const file of ['STATE.md', 'HISTORY.md']) {
    const published = await readFile(join(f.memory, file), 'utf8');
    assert.ok(!published.includes('project.jsonl'), file);
  }
  const state = await readFile(join(f.memory, 'STATE.md'), 'utf8');
  assert.ok(state.includes('risposta [E001–E002].'));
});
