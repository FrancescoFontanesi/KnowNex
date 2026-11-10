import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sample =
  'Caffè, già; l\'ASCII e l’apostrofo; ≥ ≤; 漢字 😀; e\u0301\r\n\\"';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('ORBIT writer transport fails before Node execution when TextEncoder is absent', () => {
  assert.throws(
    () => vm.runInNewContext("new TextEncoder().encode('è ≥ 😀')", {}),
    /TextEncoder is not defined/,
  );
});

test('canonical Node I/O preserves exact Unicode, BOM, CRLF and actual-byte hashes', async (t) => {
  const io = await import('../src/artifact-io.ts');
  const root = await mkdtemp(join(tmpdir(), 'knownex-io-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'artifact.json');
  const text = io.jsonText({ markdown: '# Unicode\r\n' + sample }, 2) + '\n';
  const [receipt] = await io.writeExclusiveFiles([{ path: file, text }]);
  const bytes = await readFile(file);
  assert.deepEqual(bytes, Buffer.from(text, 'utf8'));
  assert.equal(receipt!.sha256, hash(bytes));
  assert.equal(receipt!.bytes, bytes.length);
  assert.equal((await io.readArtifact(file)).text, text);
  assert.equal(JSON.parse(io.transportJson({ sample })).sample, sample);
  assert.match(io.transportJson({ sample }), /^[\x00-\x7f]*$/);
  assert.equal(
    io.decodeUtf8(Buffer.from('\uFEFF' + sample)),
    '\uFEFF' + sample,
  );
  assert.equal(io.decodeUtf8(Buffer.from('\uFEFF' + sample), true), sample);
  assert.throws(
    () => io.decodeUtf8(Buffer.from([0xc3, 0x28])),
    /KNOWNEX_UTF8_INVALID/,
  );
  assert.throws(() => io.utf8Bytes('\ud800'), /KNOWNEX_UTF8_INVALID/);
  await assert.rejects(
    io.writeExclusiveFiles([{ path: file, text: 'replacement' }]),
    /EEXIST/,
  );
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual((await readdir(root)).sort(), ['artifact.json']);
});

test('failed and silently partial writes publish no valid artifact and preserve existing atomic targets', async (t) => {
  const io = await import('../src/artifact-io.ts');
  const root = await mkdtemp(join(tmpdir(), 'knownex-io-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'confirmed.md');
  await writeFile(file, sample, 'utf8');
  const handle = await open(file, 'r');
  const proto = Object.getPrototypeOf(handle);
  await handle.close();
  const mock = t.mock.method(
    proto,
    'writeFile',
    async function (
      this: { write: (b: Buffer) => Promise<unknown> },
      bytes: Buffer,
    ) {
      await this.write(bytes.subarray(0, 2)); // Simulate short write without an exception.
    },
  );
  await assert.rejects(
    io.writeAtomicText(file, 'new ' + sample),
    /KNOWNEX_ARTIFACT_WRITE_MISMATCH/,
  );
  await assert.rejects(
    io.writeExclusiveFiles([{ path: join(root, 'new.json'), text: sample }]),
    /KNOWNEX_ARTIFACT_WRITE_MISMATCH/,
  );
  mock.mock.restore();
  assert.equal(await readFile(file, 'utf8'), sample);
  assert.deepEqual(await readdir(root), ['confirmed.md']);
});

test('exclusive pair rolls back its own publication and never removes an existing foreign target', async (t) => {
  const io = await import('../src/artifact-io.ts');
  const root = await mkdtemp(join(tmpdir(), 'knownex-io-pair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const existing = join(root, 'proposal.json'),
    review = join(root, 'review.json');
  await writeFile(existing, sample, 'utf8');
  await assert.rejects(
    io.writeExclusiveFiles([
      { path: review, text: 'new review' },
      { path: existing, text: 'replacement' },
    ]),
    /EEXIST/,
  );
  assert.equal(await readFile(existing, 'utf8'), sample);
  assert.deepEqual(await readdir(root), ['proposal.json']);
});

test('a process killed during staging leaves no published partial artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-io-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'proposal.json'),
    probe = join(root, 'probe');
  const module = pathToFileURL(join(process.cwd(), 'src/artifact-io.ts')).href;
  const code = `const fs=await import('node:fs/promises');const h=await fs.open(${JSON.stringify(probe)},'w');const p=Object.getPrototypeOf(h);await h.close();p.writeFile=async function(b){await this.write(b.subarray(0,2));process.exit(71)};const io=await import(${JSON.stringify(module)});await io.writeExclusiveFiles([{path:${JSON.stringify(file)},text:'new data'}]);`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(child.status, 71, child.stderr);
  assert.ok(!(await readdir(root)).includes('proposal.json'));
});

test('a temporary-name collision cannot delete another file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-io-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const foreign = join(root, 'collision.tmp');
  await writeFile(foreign, sample, 'utf8');
  const module = pathToFileURL(join(process.cwd(), 'src/artifact-io.ts')).href;
  const code = `const c=await import('node:crypto');c.default.randomUUID=()=> 'collision';(await import('node:module')).syncBuiltinESMExports();const io=await import(${JSON.stringify(module)});try{await io.writeExclusiveFiles([{path:${JSON.stringify(join(root, 'new.json'))},text:'new'}]);process.exit(2)}catch(e){if(e.code!=='EEXIST')throw e}`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await readFile(foreign, 'utf8'), sample);
  assert.deepEqual(await readdir(root), ['collision.tmp']);
});

test(
  'memory CLI uses ASCII-safe JSON that round-trips through Windows PowerShell',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'knownex-io-powershell-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = '# Unicode\n\n' + sample + '\n';
    await writeFile(join(root, 'STATE.md'), state, 'utf8');
    await writeFile(join(root, 'HISTORY.md'), '# History\n', 'utf8');
    const capture = join(root, 'capture.cjs'),
      output = join(root, 'transport.json');
    await writeFile(
      capture,
      "const fs=require('node:fs');const b=[];process.stdin.on('data',v=>b.push(v));process.stdin.on('end',()=>fs.writeFileSync(process.argv[2],Buffer.concat(b)));",
      'utf8',
    );
    const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    const command = `& ${quote(process.execPath)} ${quote(join(process.cwd(), 'src/index.ts'))} memory state --memory ${quote(root)} | & ${quote(process.execPath)} ${quote(capture)} ${quote(output)}`;
    const child = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(child.status, 0, child.stderr);
    const bytes = await readFile(output);
    assert.ok(bytes.every((b) => b < 128));
    assert.equal(JSON.parse(bytes.toString('ascii')).content, state);
    assert.deepEqual(
      await readFile(join(root, 'STATE.md')),
      Buffer.from(state, 'utf8'),
    );
  },
);
