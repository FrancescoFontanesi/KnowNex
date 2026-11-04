import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseNoteIdentity,
  validateKnowledge,
  validateKnowledgeEvolution,
} from '../src/memory-contract.ts';
import { historyAppendix, historySegments } from '../src/history.ts';
const note =
  '---\nid: kn-00000000-0000-4000-8000-000000000001\ntype: knowledge\n---\n\n# Topic\n';

test('Knowledge requires minimal metadata, unique stable IDs and preserved confirmed notes', () => {
  assert.equal(
    parseNoteIdentity(note).id,
    'kn-00000000-0000-4000-8000-000000000001',
  );
  assert.throws(() => parseNoteIdentity('# Untyped'), {
    code: 'CURATOR_NOTE_METADATA',
  });
  assert.throws(
    () => validateKnowledge({ 'knowledge/a.md': note, 'knowledge/b.md': note }),
    { code: 'CURATOR_NOTE_ID_DUPLICATE' },
  );
  assert.throws(
    () => validateKnowledgeEvolution({ 'knowledge/a.md': note }, {}),
    { code: 'CURATOR_NOTE_ID_CHANGED' },
  );
  validateKnowledgeEvolution(
    { 'knowledge/a.md': note },
    { 'knowledge/a.md': note + 'New details\n' },
  );
});

test('history boundaries, progress, source interval and previous STATE are structural invariants', () => {
  const initial = '# History\n',
    state = '# State\n\nActive task.\n';
  const appendix = historyAppendix(
    initial,
    state,
    2,
    3,
    '2026-11-03T12:00:00.000Z',
    '../feed.jsonl',
    { summary: 'Two events', topics: ['Memory'], transition: 'New state' },
  );
  const history = initial + appendix;
  assert.deepEqual(historySegments(history, 3), [
    { id: 'H000001', from: 2, through: 3 },
  ]);
  for (const damaged of [
    history.replace(':end', ':begin'),
    history.replaceAll('H000001', 'H000002'),
    history.replace('E002..E003', 'E003..E002'),
    history.replace('### STATE precedente', '### Missing'),
    history + appendix,
  ])
    assert.throws(() => historySegments(damaged, 3), {
      code: 'CURATOR_HISTORY_INVALID',
    });
  assert.throws(() => historySegments(history, 2), {
    code: 'CURATOR_HISTORY_INVALID',
  });
});
