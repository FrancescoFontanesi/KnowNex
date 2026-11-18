import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

/** A workspace running the package hooks the way an installed .claude wrapper does. */
async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-claude-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.codex/hooks'), { recursive: true });
  await mkdir(join(root, '.claude/hooks'), { recursive: true });
  await cp('src', join(root, 'src'), { recursive: true });
  await copyFile('package.json', join(root, 'package.json'));
  await copyFile('.codex/hooks/feed.cjs', join(root, '.codex/hooks/feed.cjs'));
  // Shape of a real Claude Code transcript (records observed from a live session).
  const transcript = join(root, 'claude-transcript.jsonl');
  const user = (promptId: string, content: unknown) => ({
    type: 'user',
    promptId,
    sessionId: 'claude-session',
    message: { role: 'user', content },
  });
  const assistant = (
    uuid: string,
    stop: string,
    content: unknown[],
    extra = {},
  ) => ({
    type: 'assistant',
    uuid,
    sessionId: 'claude-session',
    message: { role: 'assistant', stop_reason: stop, content },
    ...extra,
  });
  const text = (t: string) => ({ type: 'text', text: t });
  await writeFile(
    transcript,
    [
      user('prompt-0', 'turno precedente'),
      assistant('a-old', 'tool_use', [text('VECCHIO TURNO')]),
      { type: 'attachment', uuid: 'x' },
      user('prompt-1', 'Domanda è'),
      assistant('a-1', 'tool_use', [text('Prima controllo è.')]),
      assistant('a-1b', 'tool_use', [{ type: 'tool_use', name: 'Bash' }]),
      user('prompt-1', [{ type: 'tool_result', content: 'v24' }]),
      assistant('a-sub', 'tool_use', [text('SUBAGENTE')], {
        isSidechain: true,
      }),
      assistant('a-2', 'tool_use', [text('Ora il secondo passo.')]),
      user('prompt-1', [{ type: 'tool_result', content: '5' }]),
      assistant('a-final', 'end_turn', [text('Risposta finale')]),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const run = (name: string, payload: object, provider = 'claude') => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KNOWNEX_WORKSPACE: root,
      KNOWNEX_PROVIDER: provider,
    };
    delete env.KNOWNEX_CAPTURE;
    return spawnSync(
      process.execPath,
      [join(root, `.codex/hooks/${name}.cjs`)],
      {
        input: JSON.stringify({
          session_id: 'claude-session',
          transcript_path: transcript,
          cwd: root,
          ...payload,
        }),
        cwd: root,
        encoding: 'utf8',
        env,
      },
    );
  };
  const events = async () => {
    try {
      return (
        await readFile(
          join(root, '.knownex/internal/feed/project.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).block.event);
    } catch {
      return [];
    }
  };
  const log = async (folder: string, file: string) =>
    (await readFile(join(root, folder, file), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  return { root, run, events, log };
}

test('a Claude turn is captured with prompt_id as turn, its intermediate messages in order and provider claude', async (t) => {
  const w = await workspace(t);
  const user = w.run('feed', {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-1',
    prompt: 'Domanda è',
  });
  assert.equal(user.status, 0, user.stderr);
  assert.equal(user.stdout.trim(), '{}');
  const final = w.run('feed', {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
    last_assistant_message: 'Risposta finale',
  });
  assert.equal(final.stdout.trim(), '{}');
  const events = await w.events();
  // Only this turn's intermediate texts: not the earlier turn, the subagent, tool-only records
  // or the final answer, which arrives with Stop itself.
  assert.deepEqual(
    events.map((e) => [e.type, e.turnId, e.provider, e.messageId, e.text]),
    [
      ['user_message', 'prompt-1', 'claude', undefined, 'Domanda è'],
      [
        'assistant_commentary',
        'prompt-1',
        'claude',
        'a-1',
        'Prima controllo è.',
      ],
      [
        'assistant_commentary',
        'prompt-1',
        'claude',
        'a-2',
        'Ora il secondo passo.',
      ],
      ['assistant_final', 'prompt-1', 'claude', undefined, 'Risposta finale'],
    ],
  );
  assert.ok(events.every((e) => !('nativeThreadId' in e)));
  assert.ok(events[1].source.recordOffset < events[2].source.recordOffset);
  // A repeated Stop (hook retry) adds nothing.
  w.run('feed', {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
    last_assistant_message: 'Risposta finale',
  });
  assert.equal((await w.events()).length, 4);
  const entries = await w.log('.claude/hooks', 'feed-events.jsonl');
  assert.deepEqual(
    entries.map((e) => [e.status, e.commentaryMatched, e.commentaryIssues]),
    [
      ['captured', undefined, undefined],
      ['captured', 2, []],
      ['captured', 2, []],
    ],
  );
  await assert.rejects(
    readFile(join(w.root, '.codex/hooks/feed-events.jsonl')),
    { code: 'ENOENT' },
  );
});

test('a subagent turn is not part of the conversation and leaves no trace', async (t) => {
  const w = await workspace(t);
  for (const event of [
    { hook_event_name: 'UserPromptSubmit', prompt: 'sub' },
    { hook_event_name: 'Stop', last_assistant_message: 'sub' },
  ]) {
    const r = w.run('feed', { ...event, prompt_id: 'p', agent_id: 'agent-1' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '{}');
  }
  assert.deepEqual(await w.events(), []);
  await assert.rejects(
    readFile(join(w.root, '.claude/hooks/feed-events.jsonl')),
    { code: 'ENOENT' },
  );
});

test('a Claude payload without prompt_id is reported, not invented', async (t) => {
  const w = await workspace(t);
  const r = w.run('feed', { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /INVALID_HOOK_PAYLOAD/);
  assert.deepEqual(await w.events(), []);
  assert.equal(
    (await w.log('.claude/hooks', 'feed-events.jsonl'))[0].code,
    'INVALID_HOOK_PAYLOAD',
  );
});

test('Codex payloads keep turn_id and are marked codex', async (t) => {
  const w = await workspace(t);
  const r = w.run(
    'feed',
    { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'c' },
    'codex',
  );
  assert.equal(r.status, 0, r.stderr);
  const [event] = await w.events();
  assert.deepEqual([event.turnId, event.provider], ['t1', 'codex']);
  // prompt_id alone is not a Codex turn.
  w.run(
    'feed',
    { hook_event_name: 'UserPromptSubmit', prompt_id: 'p', prompt: 'c2' },
    'codex',
  );
  assert.equal((await w.events()).length, 1);
});
