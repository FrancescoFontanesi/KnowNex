import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test(
  'Windows ASCII pipe reproduces the observed loss; structured UTF-8 file writing preserves exact bytes',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'knownex-unicode-boundary-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sample = 'Caffè, già; π; 日本; 😀; e\u0301';
    const bytes = Buffer.from(JSON.stringify({ state: sample }), 'utf8');
    const source = join(root, 'original.json'),
      piped = join(root, 'piped.json'),
      safe = join(root, 'proposal.json');
    await writeFile(source, bytes);
    const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    const capture =
      "const fs=require('node:fs');const b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>fs.writeFileSync(process.argv[1],Buffer.concat(b)));";
    const cmd = `Get-Content -LiteralPath ${quote(source)} -Raw -Encoding UTF8 | & ${quote(process.execPath)} -e ${quote(capture)} ${quote(piped)}`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    const corrupted = JSON.parse(await readFile(piped, 'utf8')).state;
    assert.notEqual(corrupted, sample);
    assert.ok(corrupted.includes('?'));
    // Same Node filesystem API prescribed to the curator: no shell/stdin encoding boundary.
    await writeFile(safe, bytes, { encoding: 'utf8', flag: 'wx' });
    assert.deepEqual(await readFile(safe), bytes);
    assert.deepEqual(
      Buffer.from(JSON.parse(await readFile(safe, 'utf8')).state),
      Buffer.from(sample),
    );
  },
);
