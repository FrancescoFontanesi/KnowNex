import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex feed hook '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.codex/hooks'), { recursive: true });
  await cp('src', join(root, 'src'), { recursive: true });
  await copyFile('package.json', join(root, 'package.json'));
  const script = join(root, '.codex/hooks/feed.cjs');
  await copyFile('.codex/hooks/feed.cjs', script);
  return { root, script };
}

test('an existing legacy feed stays in place without creating a canonical feed', async (t) => {
  const { root, script } = await fixture(t);
  await mkdir(join(root, '.knownex/feed'), { recursive: true });
  const result = await invoke(script, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'legacy',
    turn_id: 'one',
    prompt: 'Preserve legacy placement',
  });
  assert.equal(result.code, 0);
  assert.equal((await readdir(join(root, '.knownex/feed'))).length, 1);
  await assert.rejects(readdir(join(root, '.knownex/internal')), {
    code: 'ENOENT',
  });
});

function invoke(script: string, payload: unknown) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [script], { windowsHide: true });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (b) => {
        stdout += b;
      });
      child.stderr.on('data', (b) => {
        stderr += b;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    },
  );
}

test('payload stdin originale, quattro eventi, replay e log privi di contenuto', async (t) => {
  const { root, script } = await fixture(t);
  const session = 'synthetic-feed-session',
    secret = 'PRIVATE_SYNTHETIC_CONTENT\nè 🧠';
  const inputs = ['one', 'two'].flatMap((turn_id) => [
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: session,
      turn_id,
      prompt: secret,
    },
    {
      hook_event_name: 'Stop',
      session_id: session,
      turn_id,
      last_assistant_message: secret + ' assistant',
    },
  ]);
  for (const p of [...inputs, inputs[0]]) {
    const result = await invoke(script, p);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  const name = createHash('sha256').update(session).digest('hex') + '.jsonl';
  const bytes = await readFile(join(root, '.knownex/internal/feed', name));
  const frames = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(frames.length, 4);
  assert.deepEqual(
    frames.map((f) => f.block.event.text),
    [secret, secret + ' assistant', secret, secret + ' assistant'],
  );
  assert.deepEqual(
    frames.map((f) => f.block.event.turnId),
    ['one', 'one', 'two', 'two'],
  );
  const logs = await readFile(
    join(root, '.codex/hooks/feed-events.jsonl'),
    'utf8',
  );
  assert.ok(!logs.includes('PRIVATE_SYNTHETIC_CONTENT'));
  assert.deepEqual(
    logs
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).appended),
    [1, 1, 1, 1, 0],
  );
});

test('campo finale o turno mancanti: nessun evento inventato, errore non bloccante e diagnostico', async (t) => {
  const { root, script } = await fixture(t);
  for (const [payload, code] of [
    [
      { hook_event_name: 'Stop', session_id: 's', turn_id: 't' },
      'MISSING_ASSISTANT_MESSAGE',
    ],
    [
      { hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't' },
      'MISSING_PROMPT',
    ],
    [
      {
        hook_event_name: 'Stop',
        session_id: 's',
        last_assistant_message: 'PRIVATE_SYNTHETIC_CONTENT',
      },
      'INVALID_HOOK_PAYLOAD',
    ],
  ] as const) {
    const result = await invoke(script, payload);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const response = JSON.parse(result.stdout);
    assert.equal(response.continue, true);
    assert.ok(response.systemMessage.includes(code));
    assert.ok(!result.stdout.includes('PRIVATE_SYNTHETIC_CONTENT'));
  }
  await assert.rejects(readdir(join(root, '.knownex/internal/feed')), {
    code: 'ENOENT',
  });
  const logs = await readFile(
    join(root, '.codex/hooks/feed-events.jsonl'),
    'utf8',
  );
  assert.ok(!logs.includes('PRIVATE_SYNTHETIC_CONTENT'));
});

test('Stop captures two commentary messages before native final; replay is byte-exact and source errors preserve final', async (t) => {
  const { root, script } = await fixture(t),
    source = join(root, 'source.jsonl');
  const session_id = 'r2-hook',
    turn_id = 'r2-turn';
  const rows = [
    {
      type: 'session_meta',
      payload: { id: session_id, history_mode: 'paginated' },
    },
    ...['one', 'two'].map((id) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        id,
        content: [{ type: 'output_text', text: 'PRIVATE_COMMENTARY_' + id }],
      },
      metadata: {
        retained_source: {
          id: { message_id: id, turn_id, role: 'assistant' },
          complete: true,
        },
      },
    })),
  ];
  await writeFile(source, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const original = await readFile(source);
  await invoke(script, {
    hook_event_name: 'UserPromptSubmit',
    session_id,
    turn_id,
    prompt: 'PRIVATE_PROMPT',
  });
  const stop = {
    hook_event_name: 'Stop',
    session_id,
    turn_id,
    last_assistant_message: 'PRIVATE_FINAL',
    transcript_path: source,
  };
  assert.deepEqual(JSON.parse((await invoke(script, stop)).stdout), {});
  const destination = join(
    root,
    '.knownex/internal/feed',
    createHash('sha256').update(session_id).digest('hex') + '.jsonl',
  );
  const bytes = await readFile(destination);
  assert.deepEqual(
    bytes
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l).block.event.type),
    [
      'user_message',
      'assistant_commentary',
      'assistant_commentary',
      'assistant_final',
    ],
  );
  assert.deepEqual(JSON.parse((await invoke(script, stop)).stdout), {});
  assert.deepEqual(await readFile(destination), bytes);
  assert.deepEqual(await readFile(source), original);
  await invoke(script, {
    ...stop,
    turn_id: 'other-turn',
    transcript_path: join(root, 'absent.jsonl'),
  });
  const frames = (await readFile(destination, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l).block.event);
  assert.equal(frames.at(-1).type, 'assistant_final');
  const logs = await readFile(
    join(root, '.codex/hooks/feed-events.jsonl'),
    'utf8',
  );
  assert.ok(!logs.includes('PRIVATE_'));
  const entries = logs
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    entries.slice(1, 3).map((e) => e.commentaryAppended),
    [2, 0],
  );
  assert.ok(entries.at(-1).commentaryIssues.includes('ENOENT'));
});
