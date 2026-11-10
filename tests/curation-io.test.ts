import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import {
  applyCurator,
  emptyMemory,
  initCurator,
  prepareCurator,
  validateCurator,
} from '../src/curator.ts';
import {
  readCurationInput,
  stateEvidence,
  transportJson,
  writeCurationArtifacts,
} from '../src/curation-io.ts';
import { nativeFixture } from './native-fixture.ts';
const sample = "Caffè, già; l'ASCII e l’apostrofo, ≥ ≤, 漢字 😀, e\u0301";
const hash = (v: string | Buffer) =>
  createHash('sha256').update(v).digest('hex');

async function fixture(t: test.TestContext, sourceText = sample) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'knownex-curation-io-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory'),
    work = join(root, '.knownex/internal/curator'),
    feed = join(root, '.knownex/internal/feed');
  await mkdir(memory, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  const peer = await nativeFixture(feed),
    previous = process.env.KNOWNEX_CODEX_BIN;
  await writeFile(join(feed, 'project.jsonl'), '');
  process.env.KNOWNEX_CODEX_BIN = process.execPath;
  t.after(() => {
    if (previous === undefined) delete process.env.KNOWNEX_CODEX_BIN;
    else process.env.KNOWNEX_CODEX_BIN = previous;
  });
  peer.set('io-session', ['one', 'two', 'consent-one', 'consent-two']);
  const append = (
    turnId: string,
    text: string,
    type: 'user_message' | 'assistant_final' = 'user_message',
  ) =>
    appendFeedEvent(
      feed,
      {
        type,
        sessionId: 'io-session',
        nativeThreadId: 'io-session',
        turnId,
        text,
        hook: type === 'user_message' ? 'UserPromptSubmit' : 'Stop',
      },
      true,
    );
  await initCurator(work, memory, join(feed, 'project.jsonl'), 0);
  async function prepare(n: number, autonomous = true) {
    const turn = n === 1 ? 'one' : 'two';
    const source = await append(turn, sourceText);
    await append(turn, 'Result: ' + sourceText, 'assistant_final');
    await append('consent-' + turn, '$knownex-checkpoint');
    const p = await prepareCurator(work, undefined, {
      autonomous,
      requireInvocation: true,
    });
    return { run: p.run!, sequence: source.sequence };
  }
  return { root, memory, work, feed, prepare };
}

// Simulate a bounded native output, not a limit on documents or a production pager.
function documentOutputs(text: string, capacity: number) {
  if (Buffer.byteLength(transportJson(text)) <= capacity)
    return [transportJson(text)];
  const outputs: string[] = [];
  // ASCII-safe JSON needs at most six bytes per UTF-16 unit, plus two quotes.
  const width = Math.floor((capacity - 2) / 6);
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + width, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start) end = newline + 1;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
    assert.ok(end > start);
    outputs.push(transportJson(text.slice(start, end)));
    start = end;
  }
  return outputs;
}

for (const size of ['small', 'large'] as const)
  test(
    'canonical acquisition exposes complete ' +
      size +
      ' inputs without per-fragment reads',
    async (t) => {
      const source = size === 'small' ? sample : (sample + '\r\n').repeat(4096);
      const f = await fixture(t, source),
        p = await f.prepare(1);
      const names = [
        'SKILL.md',
        'MEMORY-CONTRACT.md',
        'inputs.json',
        'packet.json',
        'base/STATE.md',
      ];
      let reads = 0,
        outputs = 0;
      for (const name of names) {
        const original = await readFile(join(p.run, name));
        const input = await readCurationInput(p.run, name);
        reads++;
        assert.equal(input.bytes, original.length);
        assert.equal(input.sha256, hash(original));
        const pages = documentOutputs(input.text, 65536);
        outputs += pages.length;
        for (const page of pages) {
          assert.ok(Buffer.byteLength(page) <= 65536);
          assert.throws(() => JSON.parse(page.slice(0, -1)));
        }
        const acquired = pages
          .map((page) => JSON.parse(page) as string)
          .join('');
        assert.deepEqual(Buffer.from(acquired, 'utf8'), original);
        if (pages.length > 1)
          assert.notEqual(
            hash(
              Buffer.from(
                pages
                  .slice(0, -1)
                  .map((page) => JSON.parse(page))
                  .join(''),
              ),
            ),
            input.sha256,
          );
        if (name === 'packet.json') {
          const packet = JSON.parse(acquired);
          assert.deepEqual(packet, JSON.parse(original.toString('utf8')));
          assert.equal(packet.events.length, 2);
          assert.equal(packet.events[0].text, source);
          assert.equal(packet.events[1].text, 'Result: ' + source);
          assert.equal(packet.events[0].sequence, p.sequence);
          assert.equal(packet.events[0].sessionId, 'io-session');
          assert.equal(packet.events[0].nativeThreadId, 'io-session');
          assert.equal(packet.events[0].hook, 'UserPromptSubmit');
        }
      }
      assert.equal(reads, names.length);
      if (size === 'small') assert.equal(outputs, names.length);
      else assert.ok(outputs > names.length);
      t.diagnostic(
        JSON.stringify({ size, canonicalReads: reads, nativeOutputs: outputs }),
      );
    },
  );

function artifacts(
  packet: { feed: string },
  sequence: number,
  state: string,
  version: number,
  before = '',
) {
  return {
    proposal: {
      action: 'update',
      state,
      history: {
        summary: 'Unicode update',
        topics: ['I/O'],
        transition: 'Updated with original Unicode.',
      },
      knowledge: {},
    },
    review: {
      version,
      summary: 'Unicode update.',
      sources: [sequence],
      changes: [
        { path: 'STATE.md', summary: 'Unicode state.', sources: [sequence] },
      ],
      critical: [
        {
          before: version === 2 ? stateEvidence(before, 1) : '',
          after: version === 2 ? stateEvidence(state, 1) : '# Project',
          reason: 'Continuity with evidence.',
          sources: [sequence],
        },
      ],
      uncertainties: [],
      anomalies: [],
    },
  };
}

test('production writer creates v1/v2 artifacts, binds actual hashes and preserves consecutive confirmed states', async (t) => {
  const f = await fixture(t);
  for (const version of [1, 2]) {
    const p = await f.prepare(version),
      packet = JSON.parse((await readCurationInput(p.run, 'packet.json')).text);
    await readCurationInput(p.run, 'inputs.json');
    const before = (await readCurationInput(p.run, 'base/STATE.md')).text;
    const state =
      '# Project ' +
      version +
      '\n\n' +
      sample +
      '\r\n\n[E' +
      String(p.sequence).padStart(3, '0') +
      '](' +
      packet.feed +
      ')\n';
    const { proposal, review } = artifacts(
      packet,
      p.sequence,
      state,
      version,
      before,
    );
    const r = await writeCurationArtifacts(p.run, proposal, review);
    const proposalBytes = await readFile(r.proposal.path),
      reviewBytes = await readFile(r.review!.path);
    assert.equal(r.proposal.sha256, hash(proposalBytes));
    assert.equal(r.review!.sha256, hash(reviewBytes));
    assert.equal(
      JSON.parse(reviewBytes.toString('utf8')).proposalSha256,
      hash(proposalBytes),
    );
    await assert.rejects(
      writeCurationArtifacts(p.run, proposal, review),
      /EEXIST/,
    );
    assert.deepEqual(await readFile(r.proposal.path), proposalBytes);
    const v = await validateCurator(f.work);
    assert.equal(v.review!.sha256, r.review!.sha256);
    if (version === 2)
      assert.equal(v.review!.report.critical[0]!.before, before.split('\n')[0]);
    await applyCurator(f.work, v.seal, true);
    const published = state.replaceAll(
      packet.feed,
      relative(f.memory, join(f.feed, 'project.jsonl')).split(sep).join('/'),
    );
    assert.equal(await readFile(join(f.memory, 'STATE.md'), 'utf8'), published);
    await assert.rejects(
      writeCurationArtifacts(p.run, proposal, review),
      /ENOENT|CURATOR_IO_RUN_NOT_PENDING/,
    );
  }
  assert.ok(
    (await readFile(join(f.memory, 'HISTORY.md'), 'utf8')).includes(sample),
  );
});

test('I/O failures do not publish partial pairs, consume another authorization or mutate confirmed memory', async (t) => {
  const f = await fixture(t),
    p = await f.prepare(1),
    packet = JSON.parse((await readCurationInput(p.run, 'packet.json')).text);
  const { proposal, review } = artifacts(
    packet,
    p.sequence,
    '# Project\n\n' + sample + '\n\n[E001](' + packet.feed + ')\n',
    1,
  );
  const authority = join(f.feed, 'project.jsonl.curator.json'),
    authorityBytes = await readFile(authority),
    pendingBytes = await readFile(join(f.work, 'pending.json'));
  const handle = await open(join(f.root, 'probe'), 'w'),
    proto = Object.getPrototypeOf(handle);
  await handle.close();
  let calls = 0;
  const original = proto.writeFile;
  const mock = t.mock.method(
    proto,
    'writeFile',
    async function (
      this: { write: (b: Buffer) => Promise<unknown> },
      bytes: Buffer,
    ) {
      if (++calls === 2) {
        await this.write(bytes.subarray(0, 3));
        throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
      }
      return original.call(this, bytes);
    },
  );
  await assert.rejects(writeCurationArtifacts(p.run, proposal, review), /EIO/);
  mock.mock.restore();
  assert.ok(!(await readdir(p.run)).includes('proposal.json'));
  assert.ok(!(await readdir(p.run)).includes('review.json'));
  assert.ok(!(await readdir(p.run)).some((n) => n.endsWith('.tmp')));
  assert.deepEqual(await readFile(authority), authorityBytes);
  assert.deepEqual(await readFile(join(f.work, 'pending.json')), pendingBytes);
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
  await assert.rejects(validateCurator(f.work), /ENOENT/);
  await assert.rejects(
    writeCurationArtifacts(p.run, proposal, {
      ...review,
      proposalSha256: 'wrong',
    }),
    /CURATOR_IO_PROPOSAL_HASH_MISMATCH/,
  );
  await assert.rejects(
    readCurationInput(p.run, '../../STATE.md'),
    /CURATOR_IO_INPUT_NOT_AUTHORIZED/,
  );
  const input = join(p.run, 'base/STATE.md');
  await writeFile(input, 'changed');
  await assert.rejects(
    readCurationInput(p.run, 'base/STATE.md'),
    /CURATOR_INPUTS_CHANGED/,
  );
});

test('Node runtime without optional encoding globals can write the real artifacts and validate them', async (t) => {
  const f = await fixture(t),
    p = await f.prepare(1),
    packet = JSON.parse((await readCurationInput(p.run, 'packet.json')).text);
  const { proposal, review } = artifacts(
    packet,
    p.sequence,
    '# Project\n\n' + sample + '\n\n[E001](' + packet.feed + ')\n',
    1,
  );
  const module = pathToFileURL(join(process.cwd(), 'src/curation-io.ts')).href;
  const code = `globalThis.TextEncoder=undefined;globalThis.TextDecoder=undefined;globalThis.Buffer=undefined;globalThis.process=undefined;const io=await import(${JSON.stringify(module)});const r=await io.writeCurationArtifacts(${JSON.stringify(p.run)},${JSON.stringify(proposal)},${JSON.stringify(review)});console.log(io.transportJson(r));`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
  const receipts = JSON.parse(child.stdout);
  assert.equal(
    receipts.proposal.sha256,
    hash(await readFile(receipts.proposal.path)),
  );
  await applyCurator(f.work, (await validateCurator(f.work)).seal, true);
});

test('legacy pending batches can use the canonical writer without acquiring a new review format', async (t) => {
  const f = await fixture(t),
    p = await f.prepare(1, false);
  const r = await writeCurationArtifacts(p.run, { action: 'noop' });
  assert.equal(r.review, undefined);
  const bytes = await readFile(r.proposal.path);
  const v = await validateCurator(f.work);
  assert.equal(v.review, undefined);
  await applyCurator(f.work, v.seal, true);
  assert.deepEqual(await readFile(r.proposal.path), bytes);
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
});

test('a writer killed after publishing review leaves an unvalidatable pair and the confirmed state intact', async (t) => {
  const f = await fixture(t),
    p = await f.prepare(1),
    packet = JSON.parse((await readCurationInput(p.run, 'packet.json')).text);
  const { proposal, review } = artifacts(
    packet,
    p.sequence,
    '# Project\n\n' + sample + '\n\n[E001](' + packet.feed + ')\n',
    1,
  );
  const authority = await readFile(join(f.feed, 'project.jsonl.curator.json'));
  const module = pathToFileURL(join(process.cwd(), 'src/curation-io.ts')).href;
  const code = `const fs=await import('node:fs/promises');const h=await fs.open(${JSON.stringify(join(f.root, 'probe'))},'w');const p=Object.getPrototypeOf(h),sync=p.sync;await h.close();let n=0;p.sync=async function(){if(++n===3)process.exit(72);return sync.call(this)};const io=await import(${JSON.stringify(module)});await io.writeCurationArtifacts(${JSON.stringify(p.run)},${JSON.stringify(proposal)},${JSON.stringify(review)});`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(child.status, 72, child.stderr);
  const names = await readdir(p.run);
  assert.ok(names.includes('review.json'));
  assert.ok(!names.includes('proposal.json'));
  await assert.rejects(validateCurator(f.work), /ENOENT/);
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
  assert.deepEqual(
    await readFile(join(f.feed, 'project.jsonl.curator.json')),
    authority,
  );
});
