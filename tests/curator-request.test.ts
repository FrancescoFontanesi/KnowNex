import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { curatorRequest } from '../scripts/curator-request.ts';

test('single-pass request passes frozen file references without exposing source text or duplicating semantic instructions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packet = {
    context: {
      'STATE.md': '# Stato\nCaff\u00e8 \ud83d\ude00',
      'knowledge/a.md':
        'Existing cause and rejected alternative; scope: local files only. [Related](b.md)',
    },
    events: [
      { sequence: 2, text: 'Riscrivi il riepilogo senza nuovi fatti.' },
      { sequence: 3, text: 'Tentativo temporaneo risolto senza conseguenze.' },
      {
        sequence: 4,
        text: 'Correzione del cwd applicata; build dichiarata verde, collaudo non eseguito.',
      },
      {
        sequence: 5,
        text: 'Dettaglio secondario: R-31 e e\u0301 senza normalizzazione.',
      },
      {
        sequence: 6,
        text: 'Nessun errore osservato solo sui file locali; rete non provata. B sostituisce A solo per export locale.',
      },
    ],
    directive: 'original directive',
    from: 2,
    through: 6,
  };
  const bytes = Buffer.from(JSON.stringify(packet, null, 2) + '\n');
  await writeFile(join(root, 'packet.json'), bytes);
  await writeFile(
    join(root, 'inputs.json'),
    JSON.stringify({ version: 1, from: 2, through: 6, files: {} }),
  );
  const request = await curatorRequest(root);
  assert.ok(request.text.includes(JSON.stringify(join(root, 'proposal.json'))));
  const payload = JSON.parse(request.text.split('INPUT_REFERENCES_JSON\n')[1]!);
  assert.equal(payload.packet.path, join(root, 'packet.json'));
  assert.equal(payload.proposal, join(root, 'proposal.json'));
  assert.equal(payload.skill, join(root, 'SKILL.md'));
  assert.equal(payload.window, join(root, 'WINDOW.md'));
  // The request points to the self-contained SKILL only: no human contract to read.
  assert.equal(payload.contract, undefined);
  assert.ok(!request.text.includes('MEMORY-CONTRACT'));
  assert.equal(request.packetBytes, bytes.length);
  assert.equal(request.requestBytes, Buffer.byteLength(request.text));
  assert.ok(!request.text.includes('original directive'));
  assert.ok(!request.text.includes('Riscrivi il riepilogo'));
  assert.ok(!request.text.includes('Existing cause'));
  assert.ok(request.text.includes('Do not write canonical artifacts'));
  assert.ok(request.text.includes('curate write'));
  assert.ok(request.text.includes('draft directory'));
  assert.equal(payload.draft, join(root, 'draft'));
  assert.ok(!request.text.includes('Node REPL'));
  assert.ok(payload.io.cli.endsWith('index.js'));
  assert.ok(payload.io.module.endsWith('/curation-io.js'));
  assert.ok(request.text.includes('Read the entire authorized event batch'));
  const output = join(root, 'request.txt');
  const generated = spawnSync(
    process.execPath,
    ['scripts/curator-request.ts', '--run', root, '--output', output],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const delivered = JSON.parse(generated.stdout);
  assert.equal(delivered.request, request.text);
  assert.equal(delivered.requestBytes, Buffer.byteLength(delivered.request));
  assert.equal(await readFile(output, 'utf8'), delivered.request);
  assert.ok(!generated.stdout.includes('Existing cause'));
  assert.deepEqual(await readFile(join(root, 'packet.json')), bytes);
  await writeFile(join(root, 'packet.json'), '{"events":[]}');
  await assert.rejects(curatorRequest(root), /CURATOR_REQUEST_INVALID/);
});
