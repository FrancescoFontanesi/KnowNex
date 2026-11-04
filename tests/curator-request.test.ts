import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { curatorRequest } from '../scripts/curator-request.ts';

test('single-pass request embeds the frozen packet exactly and preserves essential rules without reading other files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packet = {
    context: {
      'STATE.md': '# Stato\nCaff\u00e8 \ud83d\ude00',
      'knowledge/a.md': 'existing detail',
    },
    events: [{ sequence: 2, text: 'original pending' }],
    directive: 'original directive',
    from: 2,
    through: 2,
  };
  const bytes = Buffer.from(JSON.stringify(packet, null, 2) + '\n');
  await writeFile(join(root, 'packet.json'), bytes);
  const request = await curatorRequest(root);
  const payload = request.text.split('PACKET_JSON\n')[1]!;
  assert.deepEqual(Buffer.from(payload), bytes);
  assert.deepEqual(JSON.parse(payload), packet);
  assert.equal(request.packetBytes, bytes.length);
  assert.equal(request.requestBytes, Buffer.byteLength(request.text));
  for (const rule of [
    'Do not use tools',
    'Superseded decisions',
    'troubleshooting',
    'UUID v4',
    'explicit feed reference',
    'append-only HISTORY',
    'complete STATE Markdown',
  ])
    assert.ok(request.text.includes(rule), rule);
  assert.deepEqual(await readFile(join(root, 'packet.json')), bytes);
  await writeFile(join(root, 'packet.json'), '{"events":[]}');
  await assert.rejects(curatorRequest(root), /CURATOR_REQUEST_INVALID/);
});
