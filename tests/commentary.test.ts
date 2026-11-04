import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import {
  readCommentary,
  captureCommentary,
  projectFeedEvents,
} from '../src/commentary.ts';
import { appendFeedEvent } from '../src/feed.ts';
import type { FeedEvent } from '../src/feed.ts';
import {
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
} from '../src/curator.ts';

const sessionId = 'r2-synthetic',
  turnId = 'turn-one';
const meta = (mode = 'paginated') => ({
  type: 'session_meta',
  payload: { id: sessionId, history_mode: mode },
});
function message(
  messageId: string | null,
  text = 'same text',
  turn = turnId,
  retained = true,
) {
  return {
    type: 'response_item',
    ordinal: 40,
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      status: 'completed',
      id: messageId,
      content: [{ type: 'output_text', text }],
    },
    ...(retained
      ? {
          metadata: {
            retained_source: {
              id: { message_id: messageId, turn_id: turn, role: 'assistant' },
              complete: true,
              revision: 'retained-revision',
            },
          },
        }
      : {}),
  };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-r2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'session.jsonl'),
    directory = join(root, 'feed');
  const destination = join(
    directory,
    createHash('sha256').update(sessionId).digest('hex') + '.jsonl',
  );
  const write = (records: unknown[]) =>
    writeFile(source, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const events = async (): Promise<FeedEvent[]> =>
    (await readFile(destination, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l).block.event);
  return { root, source, directory, destination, write, events };
}

test('selects only completed commentary, keeps original text, identities, bytes and record provenance', async (t) => {
  const f = await fixture(t),
    text = '  Originale\n\u00e8 \ud83e\udde0  ';
  const rows = [
    meta(),
    message('msg-one', text),
    message('msg-two', text),
    {
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        phase: 'commentary',
        message: 'LEGACY_DUPLICATE',
      },
    },
    { type: 'item_completed', payload: message('msg-other').payload },
    {
      type: 'response_item',
      payload: { type: 'reasoning', content: 'PRIVATE_REASONING' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call', arguments: 'PRIVATE_TOOL_CALL' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'PRIVATE_TOOL_RESULT' },
    },
    {
      ...message('msg-final'),
      payload: { ...message('msg-final').payload, phase: 'final_answer' },
    },
    message('msg-another-turn', 'not this turn', 'turn-two'),
  ];
  await f.write(rows);
  const before = await readFile(f.source),
    selected = await readCommentary(f.source, sessionId, turnId);
  assert.equal(selected.events.length, 2);
  assert.deepEqual(
    selected.events.map((e) => [e.messageId, e.turnId, e.text]),
    [
      ['msg-one', turnId, text],
      ['msg-two', turnId, text],
    ],
  );
  for (const e of selected.events) {
    const s = e.source!;
    const raw = before.subarray(
      s.recordOffset,
      s.recordOffset + s.recordBytes - 1,
    );
    assert.equal(createHash('sha256').update(raw).digest('hex'), s.recordHash);
    assert.equal(JSON.parse(raw.toString('utf8')).payload.id, e.messageId);
    assert.equal(s.turnSource, 'retained');
  }
  await captureCommentary(f.directory, f.source, sessionId, turnId);
  const bytes = await readFile(f.destination);
  assert.ok(!/PRIVATE_|LEGACY_DUPLICATE/.test(bytes.toString('utf8')));
  assert.deepEqual(await readFile(f.source), before);
  assert.equal(
    (await captureCommentary(f.directory, f.source, sessionId, turnId))
      .commentaryAppended,
    0,
  );
  assert.deepEqual(await readFile(f.destination), bytes);
});

test('legacy to paginated uses stable identity, refuses divergent content and conservatively skips missing identity', async (t) => {
  const f = await fixture(t);
  await f.write([
    meta('legacy'),
    { type: 'turn_context', payload: { turn_id: turnId } },
    message('msg-one', 'same', turnId, false),
  ]);
  assert.equal(
    (await captureCommentary(f.directory, f.source, sessionId, turnId))
      .commentaryAppended,
    1,
  );
  const bytes = await readFile(f.destination);
  await f.write([meta(), message('msg-one', 'same')]);
  assert.equal(
    (await captureCommentary(f.directory, f.source, sessionId, turnId))
      .commentaryAppended,
    0,
  );
  assert.deepEqual(await readFile(f.destination), bytes);
  await f.write([meta(), message('msg-one', 'changed')]);
  assert.ok(
    (
      await captureCommentary(f.directory, f.source, sessionId, turnId)
    ).commentaryIssues.includes('FEED_CONFLICT'),
  );
  assert.deepEqual(await readFile(f.destination), bytes);
  await f.write([
    meta(),
    message('msg-new-identity', 'same'),
    message(null),
    message('msg-no-retained', 'x', turnId, false),
  ]);
  const result = await captureCommentary(
    f.directory,
    f.source,
    sessionId,
    turnId,
  );
  assert.equal(result.commentaryAppended, 1); // Same text is not identity.
  assert.ok(result.commentaryIssues.includes('COMMENTARY_IDENTITY_UNVERIFIED'));
  assert.equal((await f.events()).length, 2);
});

test('project commentary shares the cross-session feed and repeated capture is idempotent', async (t) => {
  const f = await fixture(t);
  await appendFeedEvent(
    f.directory,
    {
      type: 'user_message',
      sessionId: 'previous-session',
      turnId,
      text: 'Prior pending',
      hook: 'UserPromptSubmit',
    },
    true,
  );
  await f.write([
    meta(),
    message('project-commentary', 'Relevant intermediate'),
  ]);
  assert.equal(
    (await captureCommentary(f.directory, f.source, sessionId, turnId, true))
      .commentaryAppended,
    1,
  );
  const destination = join(f.directory, 'project.jsonl');
  const bytes = await readFile(destination);
  assert.equal(
    (await captureCommentary(f.directory, f.source, sessionId, turnId, true))
      .commentaryAppended,
    0,
  );
  assert.deepEqual(await readFile(destination), bytes);
  const events = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line).block.event);
  assert.deepEqual(
    events.map((e) => [e.sequence, e.sessionId, e.type]),
    [
      [1, 'previous-session', 'user_message'],
      [2, sessionId, 'assistant_commentary'],
    ],
  );
  await assert.rejects(readFile(f.destination), { code: 'ENOENT' });
});

test('wrong session, malformed source, incomplete records and inconsistent retained identity do not invent events', async (t) => {
  const f = await fixture(t);
  await f.write([
    { type: 'session_meta', payload: { id: 'wrong-session' } },
    message('one'),
  ]);
  await assert.rejects(readCommentary(f.source, sessionId, turnId), {
    code: 'COMMENTARY_SESSION_MISMATCH',
  });
  await f.write([
    meta(),
    { ...message('one'), metadata: { retained_source: { complete: false } } },
    {
      ...message('two'),
      metadata: {
        retained_source: {
          complete: true,
          id: { message_id: 'different', turn_id: turnId, role: 'assistant' },
        },
      },
    },
  ]);
  assert.equal(
    (await readCommentary(f.source, sessionId, turnId)).events.length,
    0,
  );
  await appendFile(f.source, '{broken}\n');
  await assert.rejects(readCommentary(f.source, sessionId, turnId), {
    code: 'JSONL_MALFORMED',
  });
  await f.write([meta()]);
  const partial = JSON.stringify(message('partial', '\ud83e\udde0'));
  await appendFile(f.source, partial);
  assert.equal(
    (await readCommentary(f.source, sessionId, turnId)).events.length,
    0,
  );
  await appendFile(f.source, '\n');
  assert.equal(
    (await readCommentary(f.source, sessionId, turnId)).events.length,
    1,
  );
});

test('pending uses conversational order while preserving physical checkpoints, frozen windows and R1 apply', async (t) => {
  const f = await fixture(t);
  await appendFeedEvent(f.directory, {
    type: 'user_message',
    sessionId,
    turnId: 'seed',
    text: 'seed',
    hook: 'UserPromptSubmit',
  });
  await appendFeedEvent(f.directory, {
    type: 'user_message',
    sessionId,
    turnId,
    text: 'prompt',
    hook: 'UserPromptSubmit',
  });
  // A final captured by S2.1 before R2 is immutable, even if commentary arrives later.
  await appendFeedEvent(f.directory, {
    type: 'assistant_final',
    sessionId,
    turnId,
    text: 'final',
    hook: 'Stop',
  });
  await f.write([meta(), message('m1', 'first'), message('m2', 'second')]);
  await captureCommentary(f.directory, f.source, sessionId, turnId);
  const physical = await f.events();
  assert.deepEqual(
    physical.slice(1).map((e) => e.type),
    [
      'user_message',
      'assistant_final',
      'assistant_commentary',
      'assistant_commentary',
    ],
  );
  const memory = join(f.root, 'seed'),
    work = join(f.root, 'work'),
    directive = join(f.root, 'directive.md');
  await mkdir(memory);
  const name = f.destination.split(/[\\/]/).at(-1)!;
  await writeFile(
    join(memory, 'STATE.md'),
    '# State\n\n[E001](../feed/' + name + ')\n',
  );
  await writeFile(join(memory, 'HISTORY.md'), '# History\n');
  await writeFile(directive, 'Preserve original messages and open work.');
  await initCurator(work, memory, f.destination, 1);
  const prep = await prepareCurator(work, directive);
  assert.ok(prep.run);
  const packet = JSON.parse(
    await readFile(join(prep.run, 'packet.json'), 'utf8'),
  );
  assert.deepEqual(
    packet.events.map((e: FeedEvent) => e.sequence),
    [2, 4, 5, 3],
  );
  assert.deepEqual(
    packet.events.map((e: FeedEvent) => e.text),
    ['prompt', 'first', 'second', 'final'],
  );
  assert.deepEqual(packet.orderingIssues, []);
  const window = await readFile(join(prep.run, 'WINDOW.md'), 'utf8');
  assert.ok(window.indexOf('first') < window.indexOf('final'));
  await writeFile(prep.proposal!, JSON.stringify({ action: 'noop' }));
  const v = await validateCurator(work);
  await applyCurator(work, v.seal);
  assert.equal(
    JSON.parse(await readFile(join(work, 'checkpoint.json'), 'utf8')).sequence,
    5,
  );
  assert.equal((await prepareCurator(work, directive)).status, 'noop');
  const before = await readFile(f.destination);
  assert.equal(
    (await captureCommentary(f.directory, f.source, sessionId, turnId))
      .commentaryAppended,
    0,
  );
  assert.deepEqual(await readFile(f.destination), before);
  assert.equal((await prepareCurator(work, directive)).status, 'noop');
});

test('cross-snapshot and interleaved turns retain acquisition order and report ambiguity', async (t) => {
  const f = await fixture(t);
  await f.write([meta(), message('one')]);
  await captureCommentary(f.directory, f.source, sessionId, turnId);
  await f.write([meta(), message('new'), message('one')]);
  await captureCommentary(f.directory, f.source, sessionId, turnId);
  const events = await f.events(),
    projected = projectFeedEvents(events);
  assert.deepEqual(
    projected.events.map((e) => e.messageId),
    ['one', 'new'],
  );
  assert.ok(projected.issues.includes('COMMENTARY_ORDER_AMBIGUOUS'));
  assert.ok(
    projectFeedEvents([
      events[0]!,
      { ...events[0]!, turnId: 'other' },
      events[1]!,
    ]).issues.includes('TURN_ORDER_AMBIGUOUS'),
  );
});
