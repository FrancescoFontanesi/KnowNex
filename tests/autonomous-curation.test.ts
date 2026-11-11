import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendFeedEvent } from '../src/feed.ts';
import {
  emptyMemory,
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
} from '../src/curator.ts';
import { curatorRequest } from '../scripts/curator-request.ts';

const hash = (v: string | Buffer) =>
  createHash('sha256').update(v).digest('hex');

test('autonomous curation freezes references, binds targeted review and preserves immutable updates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-autonomous-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory');
  const work = join(root, '.knownex/internal/curator');
  const directory = join(root, '.knownex/internal/feed');
  await mkdir(join(memory, 'knowledge'), { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  for (let n = 1; n <= 3; n++)
    await appendFeedEvent(directory, {
      type: 'user_message',
      sessionId: 's',
      turnId: String(n),
      text: 'SOURCE_SENTINEL_' + n,
      hook: 'UserPromptSubmit',
    });
  await initCurator(work, memory, join(directory, hash('s') + '.jsonl'), 0);
  let previous = '';
  let priorHead: unknown;
  for (let n = 1; n <= 3; n++) {
    const prepared = await prepareCurator(work, undefined, {
      through: n,
      autonomous: true,
    });
    const run = prepared.run!;
    const packet = JSON.parse(await readFile(join(run, 'packet.json'), 'utf8'));
    const manifest = JSON.parse(
      await readFile(join(run, 'inputs.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(packet.context), ['STATE.md']);
    assert.equal(packet.events.length, 1);
    const request = await curatorRequest(run);
    assert.ok(!request.text.includes('SOURCE_SENTINEL'));
    if (n > 1) {
      assert.equal(manifest.knowledge.length, 1);
      previous = await readFile(join(run, manifest.knowledge[0].path), 'utf8');
      assert.ok(previous.includes('Original detail'));
      assert.ok(!request.text.includes('Original detail'));
    }
    const state =
      '# Project\n\n[Detail](knowledge/detail.md) [E00' +
      n +
      '](' +
      packet.feed +
      ')\n';
    const note =
      n === 1
        ? '---\nid: kn-00000000-0000-4000-8000-000000000001\ntype: knowledge\n---\n# Specification\n\nOriginal detail [E001](../' +
          packet.feed +
          ')\n'
        : previous + '\nAdditional detail [E002](../' + packet.feed + ')\n';
    const proposal =
      n === 3
        ? { action: 'noop' }
        : {
            action: 'update',
            state,
            history: {
              summary: 'Change',
              topics: ['Specification'],
              transition: 'Updated specification.',
            },
            knowledge: { 'knowledge/detail.md': note },
          };
    const bytes = JSON.stringify(proposal);
    await writeFile(prepared.proposal!, bytes);
    await assert.rejects(validateCurator(work), /CURATOR_REVIEW_REQUIRED/);
    const review = {
      version: 3,
      proposalSha256: hash(bytes),
      summary: 'Change with evidence',
      sources: [n],
      changes:
        n === 3
          ? []
          : [
              { path: 'STATE.md', summary: 'Operational root', sources: [n] },
              {
                path: 'knowledge/detail.md',
                summary: 'Specification',
                sources: [n],
              },
            ],
      uncertainties: [],
      anomalies: [],
    };
    const save = () =>
      writeFile(join(run, 'review.json'), JSON.stringify(review));
    review.sources = [n + 1];
    await save();
    await assert.rejects(validateCurator(work), /CURATOR_REVIEW_INVALID/);
    review.sources = [n];
    await save();
    let validated = await validateCurator(work);
    review.summary = 'Explicit editorial change';
    await save();
    await assert.rejects(
      applyCurator(work, validated.seal),
      /CURATOR_STAGE_CHANGED/,
    );
    validated = await validateCurator(work);
    const skill = await readFile(join(run, 'SKILL.md'));
    await writeFile(join(run, 'SKILL.md'), 'changed input');
    await assert.rejects(
      applyCurator(work, validated.seal),
      /CURATOR_INPUTS_CHANGED/,
    );
    await writeFile(join(run, 'SKILL.md'), skill);
    await applyCurator(work, validated.seal);
    const checkpoint = JSON.parse(
      await readFile(join(work, 'checkpoint.json'), 'utf8'),
    );
    assert.equal(checkpoint.sequence, n);
    if (n === 3)
      assert.deepEqual(
        checkpoint.knowledgeVersions.heads['knowledge/detail.md'],
        priorHead,
      );
    priorHead = checkpoint.knowledgeVersions.heads['knowledge/detail.md'];
  }
});
