import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  launchCheckpoint,
  providerCommand,
  readReply,
  spawnProvider,
  type RunProvider,
} from '../src/checkpoint-launcher.ts';
import { writeCurationDraft } from '../src/curation-io.ts';
import { cliPath } from '../src/curator-request-data.ts';
import { emptyMemory } from '../src/curator.ts';
import { appendFeedEvent } from '../src/feed.ts';
import { nativeFixture } from './native-fixture.ts';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knownex-launch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = join(root, '.knownex/memory'),
    feed = join(root, '.knownex/internal/feed');
  await mkdir(memory, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  const peer = await nativeFixture(feed);
  peer.set('launch', ['facts']);
  const prior = process.env.KNOWNEX_CODEX_BIN;
  process.env.KNOWNEX_CODEX_BIN = process.execPath;
  t.after(() => {
    if (prior === undefined) delete process.env.KNOWNEX_CODEX_BIN;
    else process.env.KNOWNEX_CODEX_BIN = prior;
  });
  for (const [type, text] of [
    ['user_message', 'SOURCE_SENTINEL: persist confirmed facts.'],
    ['assistant_final', 'Confirmed.'],
  ] as const)
    await appendFeedEvent(
      feed,
      {
        type,
        sessionId: 'launch',
        nativeThreadId: 'launch',
        turnId: 'facts',
        text,
        hook: type === 'assistant_final' ? 'Stop' : 'UserPromptSubmit',
      },
      true,
    );
  return { root, memory };
}

const answer = (sources = [1]) =>
  JSON.stringify({
    proposal: {
      action: 'update',
      history: { summary: 'Launch', topics: ['Launch'], transition: 'Done.' },
    },
    state: '# Stato\n\nLAUNCHED è [E001]\n',
    review: {
      version: 3,
      summary: 'Curato.',
      sources,
      changes: [{ path: 'STATE.md', summary: 'Stato.', sources: [1] }],
      uncertainties: [],
      anomalies: [],
    },
  });

/** Stand-in for the provider session: answers in one message, as the prompt asks. */
function curator(
  calls: string[],
  outcome: 'deliver' | 'fail' | 'silent' | 'fix' | 'stubborn' = 'deliver',
  prompts: string[] = [],
) {
  const run: RunProvider = async (command, _args, _cwd, input) => {
    calls.push(command);
    prompts.push(input);
    if (outcome === 'fail') return { exitCode: 1, error: 'provider crashed' };
    // A session that ends normally without an answer (as seen once in a real run).
    if (outcome === 'silent')
      return {
        exitCode: 0,
        output: 'Leggo la skill.\nNon trovo la CLI KnowNex.\n',
      };
    // First answer cites an event after the batch; the corrected one is valid.
    const bad =
      outcome === 'stubborn' || (outcome === 'fix' && prompts.length === 1);
    return { exitCode: 0, output: answer(bad ? [99] : [1]) };
  };
  return run;
}

const codexEvents = (text: string, input = 1000) =>
  [
    { type: 'thread.started' },
    { item: { type: 'agent_message', text: 'Leggo il batch.' } },
    { item: { type: 'command_execution', command: 'x', status: 'completed' } },
    { item: { type: 'agent_message', text } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: input,
        cached_input_tokens: 400,
        output_tokens: 50,
        reasoning_output_tokens: 7,
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n';

test('the final message and token use are read from each provider structured output', () => {
  assert.deepEqual(readReply('codex', codexEvents('FINALE è')), {
    message: 'FINALE è',
    tokens: { input: 1000, cached: 400, output: 50, reasoning: 7 },
  });
  assert.deepEqual(
    readReply(
      'claude',
      JSON.stringify({
        type: 'result',
        result: 'FINALE',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 700,
          output_tokens: 40,
          output_tokens_details: { thinking_tokens: 5 },
        },
      }),
    ),
    {
      message: 'FINALE',
      tokens: { input: 1002, cached: 700, output: 40, reasoning: 5 },
    },
  );
  // Plain text (or an unexpected shape) is the message itself, with no token claim.
  assert.deepEqual(readReply('codex', 'solo testo'), { message: 'solo testo' });
  assert.deepEqual(readReply('claude', '{"proposal":{}}'), {
    message: '{"proposal":{}}',
  });
});

test('provider argv is non-interactive, unpersisted and minimal-context, and rejects unsafe values', () => {
  const [codex, args] = providerCommand(
    { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
    'W',
  );
  assert.equal(codex, 'codex');
  assert.deepEqual(args.slice(0, 8), [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '-C',
    'W',
    '-s',
    'read-only',
    '--json',
  ]);
  assert.deepEqual(args.slice(-5), [
    '-m',
    'gpt-6.1-sol',
    '-c',
    'model_reasoning_effort="medium"',
    '-',
  ]);
  // Codex's own system prompt, AGENTS.md, skills, plugins and MCP stay out of the curator session.
  const overrides = args.filter((_, i) => args[i - 1] === '-c');
  for (const c of [
    'project_doc_max_bytes=0',
    'skills.include_instructions=false',
    'agents.enabled=false',
    'mcp_servers={}',
    'features.plugins=false',
    'features.multi_agent=false',
  ])
    assert.ok(overrides.includes(c), c);
  assert.match(overrides[0]!, /^instructions="Sei il Curator di KnowNex\./);
  // A feature unknown to another Codex version must not fail the launch: never --disable.
  assert.ok(!args.includes('--disable'));
  assert.deepEqual(
    providerCommand(
      { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      'W',
    ),
    [
      'claude',
      [
        '-p',
        '--no-session-persistence',
        '--output-format',
        'json',
        '--safe-mode',
        '--strict-mcp-config',
        '--system-prompt',
        "Sei il Curator di KnowNex. Il messaggio dell'utente contiene l'incarico completo e il formato della risposta.",
        '--tools',
        'Bash',
        '--allowedTools',
        'Bash(node:*)',
        '--model',
        'claude-opus-5-5',
        '--effort',
        'high',
      ],
    ],
  );
  // Without model/effort the provider defaults apply.
  assert.ok(!providerCommand({ provider: 'codex' }, 'W')[1].includes('-m'));
  for (const bad of ['gpt 6', 'x"y', '-m', 'a\nb', ''])
    assert.throws(
      () => providerCommand({ provider: 'codex', model: bad }, 'W'),
      { code: 'CHECKPOINT_ARGUMENT_INVALID' },
      JSON.stringify(bad),
    );
  assert.throws(
    () => providerCommand({ provider: 'codex', effort: 'high"]' }, 'W'),
    { code: 'CHECKPOINT_ARGUMENT_INVALID' },
  );
  assert.throws(() => providerCommand({ provider: 'x' as 'codex' }, 'W'), {
    code: 'CHECKPOINT_ARGUMENT_INVALID',
  });
});

test('one launch prepares, lets the session curate and publishes; nothing new means no session', async (t) => {
  const f = await fixture(t),
    calls: string[] = [];
  const result = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls),
  );
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result));
  assert.deepEqual(calls, ['codex']);
  assert.match(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    /LAUNCHED è \[E001\]/,
  );
  await assert.rejects(
    stat(join(f.root, '.knownex/internal/checkpoint.lock')),
    { code: 'ENOENT' },
  );
  const again = await launchCheckpoint(
    f.root,
    { provider: 'claude' },
    curator(calls),
  );
  assert.equal(again.status, 'SUCCESS');
  assert.equal(again.action, 'noop');
  assert.deepEqual(calls, ['codex'], 'no session without new events');
});

test('a failed session publishes nothing, names the provider error and the same batch can be retried', async (t) => {
  const f = await fixture(t),
    calls: string[] = [];
  const failed = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls, 'fail'),
  );
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.code, 'CHECKPOINT_PROVIDER_FAILED');
  assert.equal(failed.cause, 'provider crashed');
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
  const runs = await readdir(join(f.root, '.knownex/internal/curator/runs'));
  const retried = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls),
  );
  assert.equal(retried.status, 'SUCCESS', JSON.stringify(retried));
  assert.deepEqual(
    await readdir(join(f.root, '.knownex/internal/curator/runs')),
    runs,
    'the retry curates the batch already frozen, not a new one',
  );
});

test('the prompt carries the whole task so one call suffices: skill, events, STATE, catalog and notes', async (t) => {
  const f = await fixture(t),
    calls: string[] = [],
    prompts: string[] = [];
  await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls, 'deliver', prompts),
  );
  const [prompt] = prompts;
  for (const part of [
    '===== SKILL =====',
    '# KnowNex Curator',
    '===== WINDOW.md',
    'SOURCE_SENTINEL: persist confirmed facts.',
    '===== base/STATE.md =====',
    '===== Catalogo delle note',
    'Rispondi con un unico oggetto JSON',
    'qui sei il Curator e segui solo questo incarico',
    `node "${cliPath}" curate read --run`,
    '## 2. Decidi cosa conservare',
    '## 5. Consegna',
  ])
    assert.ok(prompt!.includes(part), part);
  // Already inline, so not resent: skill frontmatter and the steps to read the batch with tools.
  for (const part of ['name: knownex-curator', '## 1. Leggi il batch'])
    assert.ok(!prompt!.includes(part), part);
  assert.deepEqual(calls, ['codex']);
});

test('the answer is found among text around it, braces included', async (t) => {
  const f = await fixture(t);
  const chatty: RunProvider = async () => ({
    exitCode: 0,
    output: `Ecco la curatela:\n\`\`\`json\n${answer()}\n\`\`\`\nNota: le chiavi seguono {proposal, state}.`,
  });
  const outcome = await launchCheckpoint(f.root, { provider: 'codex' }, chatty);
  assert.equal(outcome.status, 'SUCCESS', JSON.stringify(outcome));
});

test('notes from earlier checkpoints are in the next prompt, so updating them needs no extra call', async (t) => {
  const f = await fixture(t),
    prompts: string[] = [];
  // First checkpoint creates a note.
  const withNote: RunProvider = async () => {
    const a = JSON.parse(answer());
    a.knowledge = { 'knowledge/nota.md': '# Nota\n\nNOTA_SENTINEL [E001]\n' };
    a.review.changes.push({
      path: 'knowledge/nota.md',
      summary: 'Nota.',
      sources: [1],
    });
    return { exitCode: 0, output: JSON.stringify(a) };
  };
  assert.equal(
    (await launchCheckpoint(f.root, { provider: 'codex' }, withNote)).status,
    'SUCCESS',
  );
  await appendFeedEvent(
    join(f.root, '.knownex/internal/feed'),
    {
      type: 'user_message',
      sessionId: 'launch',
      nativeThreadId: 'launch',
      turnId: 'more',
      text: 'Altro lavoro.',
      hook: 'UserPromptSubmit',
    },
    true,
  );
  await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator([], 'deliver', prompts),
  );
  assert.ok(prompts[0]!.includes('===== base/knowledge/nota.md ====='));
  assert.ok(prompts[0]!.includes('NOTA_SENTINEL'));
});

test('a rejected answer gets exactly one retry with its error code, and the fix publishes', async (t) => {
  const f = await fixture(t),
    calls: string[] = [],
    prompts: string[] = [];
  const fixed = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls, 'fix', prompts),
  );
  assert.equal(fixed.status, 'SUCCESS', JSON.stringify(fixed));
  assert.equal(calls.length, 2);
  assert.match(
    prompts[1]!,
    /TENTATIVO PRECEDENTE RIFIUTATO =====\nCodice: CURATOR_REVIEW_INVALID\./,
  );
  assert.ok(prompts[1]!.includes('"sources":[99]'));
});

test('token use of every attempt is summed into the outcome', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const codex: RunProvider = async () => ({
    exitCode: 0,
    output: codexEvents(answer(calls++ === 0 ? [99] : [1]), 1000 + calls),
  });
  const outcome = await launchCheckpoint(f.root, { provider: 'codex' }, codex);
  assert.equal(outcome.status, 'SUCCESS', JSON.stringify(outcome));
  assert.deepEqual(outcome.tokens, {
    input: 1001 + 1002,
    cached: 800,
    output: 100,
    reasoning: 14,
  });
});

test('a BLOCKED batch comes with its report and two ready commands that really accept or discard it', async (t) => {
  const f = await fixture(t);
  const doubtful: RunProvider = async () => {
    const a = JSON.parse(answer());
    a.review.uncertainties = ['Fonte non verificabile.'];
    return { exitCode: 0, output: JSON.stringify(a) };
  };
  const cli = (line: string) => {
    const args = line
      .replace('npm exec --offline -- knownex ', '')
      .match(/"[^"]*"|\S+/g)!
      .map((a) => a.replace(/^"|"$/g, ''));
    return spawnSync(process.execPath, ['src/index.ts', ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
  };
  // Discard: the events go back to pending and the next launch curates them again.
  const first = await launchCheckpoint(f.root, { provider: 'codex' }, doubtful);
  assert.equal(first.status, 'BLOCKED');
  assert.deepEqual(first.blocking, ['Fonte non verificabile.']);
  assert.ok(first.review!.endsWith('review.json'));
  assert.match(await readFile(first.review!, 'utf8'), /Fonte non verificabile/);
  const discard = cli(first.next![1]!);
  assert.equal(discard.status, 0, discard.stderr);
  assert.equal(JSON.parse(discard.stdout).status, 'abandoned');
  // Accept: the reviewed proposal is published as it is.
  const second = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    doubtful,
  );
  assert.equal(second.status, 'BLOCKED');
  assert.match(
    second.next![0]!,
    /curate apply --work ".+" --confirm [0-9a-f]+$/,
  );
  const accept = cli(second.next![0]!);
  assert.equal(accept.status, 0, accept.stderr);
  assert.match(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    /LAUNCHED è \[E001\]/,
  );
});

test('what blocks publication goes back to the model once, and its revision publishes', async (t) => {
  const f = await fixture(t),
    prompts: string[] = [];
  const reviser: RunProvider = async (_c, _a, _w, input) => {
    prompts.push(input);
    const a = JSON.parse(answer());
    if (prompts.length === 1)
      a.review.uncertainties = ['Conteggio dei test discordante.'];
    return { exitCode: 0, output: JSON.stringify(a) };
  };
  const outcome = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    reviser,
  );
  assert.equal(outcome.status, 'SUCCESS', JSON.stringify(outcome));
  assert.equal(prompts.length, 2);
  assert.match(
    prompts[1]!,
    /REVISIONE DEI PUNTI BLOCCANTI =====\n[^\n]*\n- Conteggio dei test discordante\.\n/,
  );
  assert.ok(!prompts[0]!.includes('REVISIONE DEI PUNTI BLOCCANTI'));
});

test('note names chosen by the model never write outside the draft', async (t) => {
  for (const name of [
    'knowledge/../evil.md',
    '../evil.md',
    'knowledge/sub/evil.md',
    'knowledge/Evil.md',
    'knowledge/evil.txt',
  ]) {
    const f = await fixture(t);
    const hostile: RunProvider = async () => {
      const a = JSON.parse(answer());
      a.knowledge = { [name]: '# Evil\n\nX [E001]\n' };
      return { exitCode: 0, output: JSON.stringify(a) };
    };
    const outcome = await launchCheckpoint(
      f.root,
      { provider: 'codex' },
      hostile,
    );
    assert.equal(outcome.cause, 'CHECKPOINT_RESPONSE_INVALID', name);
    const found: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }))
        if (e.isDirectory()) await walk(join(dir, e.name));
        else if (/evil/i.test(e.name)) found.push(join(dir, e.name));
    };
    await walk(f.root);
    assert.deepEqual(found, [], name);
  }
});

test('two rejected answers stop with the rejection code and leave the batch retryable', async (t) => {
  const f = await fixture(t),
    calls: string[] = [];
  const stopped = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls, 'stubborn'),
  );
  assert.equal(stopped.status, 'ERROR');
  assert.equal(stopped.code, 'CURATOR_WORKER_OUTPUT_INCOMPLETE');
  assert.equal(stopped.cause, 'CURATOR_REVIEW_INVALID');
  assert.equal(calls.length, 2, 'never a third call');
  assert.equal(
    await readFile(join(f.memory, 'STATE.md'), 'utf8'),
    emptyMemory['STATE.md'],
  );
  assert.equal(
    (await launchCheckpoint(f.root, { provider: 'codex' }, curator(calls)))
      .status,
    'SUCCESS',
  );
});

test('a session that exits normally without delivering is reported with its own last words, kept in the run', async (t) => {
  const f = await fixture(t),
    calls: string[] = [];
  const silent = await launchCheckpoint(
    f.root,
    { provider: 'codex' },
    curator(calls, 'silent'),
  );
  assert.equal(silent.status, 'ERROR');
  assert.equal(silent.code, 'CURATOR_WORKER_OUTPUT_INCOMPLETE');
  // Not JSON twice: the code says why, the session log keeps the words.
  assert.equal(silent.cause, 'CHECKPOINT_RESPONSE_INVALID');
  const [run] = await readdir(join(f.root, '.knownex/internal/curator/runs'));
  assert.equal(
    await readFile(
      join(f.root, '.knownex/internal/curator/runs', run!, 'session.log'),
      'utf8',
    ),
    'Leggo la skill.\nNon trovo la CLI KnowNex.\n',
  );
  assert.equal(
    (await launchCheckpoint(f.root, { provider: 'codex' }, curator(calls)))
      .status,
    'SUCCESS',
  );
});

test('a second launch while one is curating stops at once without a session', async (t) => {
  const f = await fixture(t),
    calls: string[] = [];
  let resume!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  const slow: RunProvider = async (...args) => {
    await gate;
    return curator(calls)(...args);
  };
  const first = launchCheckpoint(f.root, { provider: 'codex' }, slow);
  await new Promise((r) => setTimeout(r, 300));
  const second = await launchCheckpoint(
    f.root,
    { provider: 'claude' },
    curator(calls),
  );
  assert.equal(second.status, 'ERROR');
  assert.equal(second.code, 'CHECKPOINT_BUSY');
  resume();
  assert.equal((await first).status, 'SUCCESS');
  assert.deepEqual(calls, ['codex']);
});

test('outside a KnowNex workspace nothing is created', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-launch-none-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await launchCheckpoint(root, { provider: 'codex' }, () =>
    assert.fail('no session'),
  );
  assert.equal(result.code, 'KNOWNEX_WORKSPACE_REQUIRED');
  assert.deepEqual(await readdir(root), []);
});

test('the real spawner disables capture, passes the task on stdin and reports only status and last error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'knownex-spawn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = (code: number) =>
    "const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{" +
    "fs.writeFileSync('seen.json',JSON.stringify({capture:process.env.KNOWNEX_CAPTURE,input:s}));" +
    `console.log('MODEL OUTPUT');console.error('first\\nlast line');process.exit(${code})})`;
  assert.deepEqual(
    await spawnProvider(process.execPath, ['-e', script(0)], dir, 'TASK è'),
    { exitCode: 0, output: 'MODEL OUTPUT\n' },
  );
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'seen.json'), 'utf8')), {
    capture: '0',
    input: 'TASK è',
  });
  assert.deepEqual(
    await spawnProvider(process.execPath, ['-e', script(3)], dir, 'x'),
    { exitCode: 3, error: 'last line', output: 'MODEL OUTPUT\n' },
  );
  assert.deepEqual(
    await spawnProvider(join(dir, 'missing-provider.exe'), [], dir, 'x'),
    { exitCode: null, error: 'ENOENT' },
  );
});

test('a character split between two output chunks reaches the draft intact', async () => {
  // Write every multibyte character in two halves, with a pause so they arrive as separate reads.
  const text = 'Città è più: 漢字 😀 é';
  const script =
    `const b=Buffer.from(${JSON.stringify(text)});let i=0;` +
    `const next=()=>{if(i>=b.length)return;process.stdout.write(b.subarray(i,i+1));i++;setTimeout(next,2)};next()`;
  const r = await spawnProvider(process.execPath, ['-e', script], '.', '');
  assert.equal(r.output, text);
  assert.ok(!r.output!.includes('�'));
});

test("the model's own output never reaches the launcher's stdout", () => {
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { spawnProvider } from './src/checkpoint-launcher.ts';" +
        "await spawnProvider(process.execPath, ['-e', 'console.log(\"MODEL OUTPUT\")'], '.', '');",
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('the CLI accepts exactly one provider and rejects bad arguments before touching the workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'knownex-launch-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [
    [],
    ['--codex', '--claude'],
    ['--codex', '--model'],
    ['--codex', '--bogus'],
    ['--codex', '-m', ' '],
  ]) {
    const r = spawnSync(
      process.execPath,
      ['src/index.ts', 'checkpoint', ...args, '--workspace', root],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(JSON.parse(r.stderr).code, 'INVALID_ARGUMENTS');
  }
  assert.deepEqual(await readdir(root), []);
});
