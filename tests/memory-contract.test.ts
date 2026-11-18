import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseNoteIdentity,
  validateKnowledge,
  validateKnowledgeEvolution,
} from '../src/curation/memory-contract.ts';
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
