const noteId =
  /^kn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** Restricted metadata, not a general YAML parser. IDs survive note edits. */
export function parseNoteIdentity(text: string): { id: string } {
  const header = text.match(
    /^---\r?\nid: ([^\r\n]+)\r?\ntype: knowledge\r?\n---(?:\r?\n|$)/,
  );
  if (!header || !noteId.test(header[1]!)) fail('CURATOR_NOTE_METADATA');
  return { id: header[1]! };
}

export function validateKnowledge(tree: Record<string, string>) {
  const ids = new Set<string>();
  for (const [name, text] of Object.entries(tree)) {
    if (!name.startsWith('knowledge/')) continue;
    const { id } = parseNoteIdentity(text);
    if (ids.has(id)) fail('CURATOR_NOTE_ID_DUPLICATE');
    ids.add(id);
  }
}

export function validateKnowledgeEvolution(
  before: Record<string, string>,
  after: Record<string, string>,
) {
  validateKnowledge(after);
  for (const [name, text] of Object.entries(before)) {
    if (!name.startsWith('knowledge/')) continue;
    if (
      !after[name] ||
      parseNoteIdentity(after[name]).id !== parseNoteIdentity(text).id
    )
      fail('CURATOR_NOTE_ID_CHANGED');
  }
}
